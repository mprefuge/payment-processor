const Stripe = require('stripe');
const jsforce = require('jsforce');

const { mapStripeToTransaction } = require('../domain/transactions');

let createSalesforceSvc;
try {
  ({ createSalesforceSvc } = require('../services/salesforceSvc'));
} catch (error) {
  createSalesforceSvc = null;
}

const STRIPE_API_VERSION = '2023-10-16';
const DEFAULT_EXAMPLE_LIMIT = 3;
const MAX_EXAMPLE_LIMIT = 10;

const csvEscape = (value) => {
  if (value === null || value === undefined) {
    return '';
  }

  const stringValue = String(value);
  if (/[",\n\r]/.test(stringValue)) {
    return `"${stringValue.replace(/"/g, '""')}"`;
  }

  return stringValue;
};

const formatTimestampForFilename = (date = new Date()) => {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  const hours = String(date.getUTCHours()).padStart(2, '0');
  const minutes = String(date.getUTCMinutes()).padStart(2, '0');
  const seconds = String(date.getUTCSeconds()).padStart(2, '0');
  return `${year}${month}${day}-${hours}${minutes}${seconds}`;
};

const buildPaymentsCsv = (rows) => {
  const headers = [
    'stripe_charge_id',
    'stripe_payment_intent_id',
    'payment_type',
    'payment_status',
    'amount_gross',
    'amount_fee',
    'amount_net',
    'currency',
    'stripe_customer_id',
    'customer_name',
    'customer_email',
    'received_at',
  ];

  const csvRows = [headers.join(',')];

  for (const row of rows) {
    const values = headers.map((header) => csvEscape(row[header]));
    csvRows.push(values.join(','));
  }

  return `${csvRows.join('\n')}\n`;
};

const parseBoolean = (value, defaultValue = false) => {
  if (value === undefined || value === null) {
    return defaultValue;
  }

  if (typeof value === 'boolean') {
    return value;
  }

  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (['true', '1', 'yes', 'y', 'on'].includes(normalized)) {
      return true;
    }
    if (['false', '0', 'no', 'n', 'off'].includes(normalized)) {
      return false;
    }
  }

  return defaultValue;
};

const parseExampleLimit = (value) => {
  if (value === undefined || value === null) {
    return DEFAULT_EXAMPLE_LIMIT;
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return DEFAULT_EXAMPLE_LIMIT;
  }

  const rounded = Math.trunc(parsed);
  if (rounded < 1) {
    return 1;
  }

  if (rounded > MAX_EXAMPLE_LIMIT) {
    return MAX_EXAMPLE_LIMIT;
  }

  return rounded;
};

const normalizeStripeId = (value) => {
  if (!value) {
    return null;
  }

  if (typeof value === 'string') {
    return value;
  }

  if (typeof value === 'object' && value !== null && typeof value.id === 'string') {
    return value.id;
  }

  return null;
};

const splitName = (name) => {
  if (typeof name !== 'string') {
    return { firstName: null, lastName: null };
  }

  const trimmed = name.trim();
  if (!trimmed) {
    return { firstName: null, lastName: null };
  }

  const [firstName, ...rest] = trimmed.split(/\s+/);
  return {
    firstName: firstName || null,
    lastName: rest.length > 0 ? rest.join(' ') : null,
  };
};

const derivePaymentType = (charge) => {
  if (charge?.disputed) {
    return 'disputed';
  }

  if (charge?.refunded || (typeof charge?.amount_refunded === 'number' && charge.amount_refunded > 0)) {
    return 'refunded';
  }

  return 'paid';
};

const toAmount = (cents) => {
  if (typeof cents !== 'number' || Number.isNaN(cents)) {
    return null;
  }

  return cents / 100;
};

const collectStripePages = async (listFn, initialParams) => {
  const results = [];
  let params = { ...initialParams };
  let hasMore = true;

  while (hasMore) {
    const response = await listFn(params);
    const data = Array.isArray(response?.data) ? response.data : [];
    results.push(...data);

    hasMore = Boolean(response?.has_more && data.length > 0);
    if (hasMore) {
      params = {
        ...params,
        starting_after: data[data.length - 1].id,
      };
    }
  }

  return results;
};

const resolveStripeSecret = (testMode) => {
  if (testMode) {
    return process.env.STRIPE_TEST_SECRET_KEY || process.env.STRIPE_SECRET || null;
  }

  return process.env.STRIPE_LIVE_SECRET_KEY || process.env.STRIPE_SECRET || null;
};

const createSalesforceGetter = () => {
  let cachedPromise = null;

  return async () => {
    if (!cachedPromise) {
      cachedPromise = (async () => {
        const username = process.env.SALESFORCE_USERNAME;
        const password = process.env.SALESFORCE_PASSWORD;
        const securityToken = process.env.SALESFORCE_SECURITY_TOKEN || '';
        const loginUrl = process.env.SALESFORCE_LOGIN_URL || 'https://login.salesforce.com';

        if (!username || !password) {
          throw new Error('Salesforce credentials are not configured.');
        }

        if (!createSalesforceSvc) {
          throw new Error('Salesforce service is not available.');
        }

        const connection = new jsforce.Connection({ loginUrl });
        await connection.login(username, `${password}${securityToken}`);
        return createSalesforceSvc({ connection });
      })();
    }

    return cachedPromise;
  };
};

const createDefaultDependencies = () => {
  const testMode = parseBoolean(process.env.TEST_MODE, false);
  const stripeSecret = resolveStripeSecret(testMode);

  if (!stripeSecret) {
    throw new Error('Stripe secret key is not configured.');
  }

  const stripe = new Stripe(stripeSecret, { apiVersion: STRIPE_API_VERSION });

  return {
    testMode,
    stripe,
    getSalesforceSvc: createSalesforceGetter(),
  };
};

let customDependencies = null;

const setDependencies = (overrides = null) => {
  customDependencies = overrides;
};

const resetDependencies = () => {
  customDependencies = null;
};

const resolveDependencies = () => {
  if (customDependencies) {
    return customDependencies;
  }

  return createDefaultDependencies();
};

const readQuery = (request) => {
  if (request?.query && typeof request.query.get === 'function') {
    return {
      dryRun: request.query.get('dryRun') || undefined,
      exampleLimit: request.query.get('exampleLimit') || undefined,
      format: request.query.get('format') || undefined,
    };
  }

  if (request?.query && typeof request.query === 'object') {
    return request.query;
  }

  try {
    if (typeof request?.url === 'string') {
      const parsed = new URL(request.url);
      return {
        dryRun: parsed.searchParams.get('dryRun') || undefined,
        exampleLimit: parsed.searchParams.get('exampleLimit') || undefined,
        format: parsed.searchParams.get('format') || undefined,
      };
    }
  } catch (error) {
    // Ignore URL parsing errors and use empty query defaults.
  }

  return {};
};

const syncSalesforcePayments = async (request, context) => {
  try {
    if (!request || !['POST', 'GET'].includes(request.method || '')) {
      return {
        status: 405,
        jsonBody: {
          error: 'method_not_allowed',
          message: 'Use GET or POST for payment sync.',
        },
      };
    }

    const deps = resolveDependencies();
    const query = readQuery(request);

    const requestedDryRun = parseBoolean(query.dryRun, false);
    const testMode = parseBoolean(deps.testMode, false);
    const dryRun = testMode ? true : requestedDryRun;
    const forcedByTestMode = testMode && !requestedDryRun;
    const exampleLimit = parseExampleLimit(query.exampleLimit);
    const format = typeof query.format === 'string' ? query.format.trim().toLowerCase() : '';
    const exportCsv = format === 'csv';

    const charges = await collectStripePages(deps.stripe.charges.list.bind(deps.stripe.charges), {
      limit: 100,
    });

    const summary = {
      totalPayments: 0,
      successfulPayments: 0,
      skippedPayments: 0,
      paymentTypes: {
        paid: 0,
        refunded: 0,
        disputed: 0,
      },
      customers: {
        withCustomerId: 0,
        withoutCustomerId: 0,
        uniqueCustomerCount: 0,
      },
      salesforce: {
        customerUpserts: 0,
        paymentUpserts: 0,
      },
      errors: 0,
    };

    const uniqueCustomerIds = new Set();
    const examples = [];
    const errorSamples = [];
    const csvRows = [];

    let salesforce = null;
    const ensureSalesforce = async () => {
      if (!salesforce) {
        salesforce = await deps.getSalesforceSvc();
      }
      return salesforce;
    };

    for (const charge of charges) {
      summary.totalPayments += 1;

      try {
        if (charge.status !== 'succeeded') {
          summary.skippedPayments += 1;
          continue;
        }

        summary.successfulPayments += 1;

        const customerId = normalizeStripeId(charge.customer);
        if (customerId) {
          summary.customers.withCustomerId += 1;
          uniqueCustomerIds.add(customerId);
        } else {
          summary.customers.withoutCustomerId += 1;
        }

        const paymentType = derivePaymentType(charge);
        summary.paymentTypes[paymentType] += 1;

        let balanceTransaction = null;
        const balanceTransactionId = normalizeStripeId(charge.balance_transaction);
        if (balanceTransactionId) {
          try {
            balanceTransaction = await deps.stripe.balanceTransactions.retrieve(balanceTransactionId);
          } catch (error) {
            balanceTransaction = null;
          }
        }

        const transactionPayload = mapStripeToTransaction({
          paymentIntent: null,
          charge,
          balanceTransaction,
        });

        let customerPayload = null;

        if (customerId) {
          try {
            const stripeCustomer = await deps.stripe.customers.retrieve(customerId);
            if (stripeCustomer && !stripeCustomer.deleted) {
              const { firstName, lastName } = splitName(stripeCustomer.name);
              customerPayload = {
                stripe_customer_id__c: stripeCustomer.id,
                Name: stripeCustomer.name || stripeCustomer.email || `Customer ${stripeCustomer.id}`,
                Email: stripeCustomer.email || null,
                FirstName: firstName,
                LastName: lastName,
              };
            }
          } catch (error) {
            customerPayload = null;
          }
        }

        if (examples.length < exampleLimit) {
          examples.push({
            stripeCharge: {
              id: charge.id,
              amount: toAmount(charge.amount),
              currency: charge.currency || null,
              customerId,
              status: charge.status,
              paymentType,
            },
            salesforceCustomerPayload: customerPayload,
            salesforcePaymentPayload: {
              stripe_charge_id__c: transactionPayload.stripe_charge_id__c || null,
              stripe_payment_intent_id__c: transactionPayload.stripe_payment_intent_id__c || null,
              transaction_type__c: transactionPayload.transaction_type__c,
              status__c: transactionPayload.status__c,
              amount_gross__c: transactionPayload.amount_gross__c,
              amount_fee__c: transactionPayload.amount_fee__c,
              amount_net__c: transactionPayload.amount_net__c,
              currency_iso_code__c: transactionPayload.currency_iso_code__c,
              stripe_customer_id__c: transactionPayload.stripe_customer_id__c || null,
              received_at__c: transactionPayload.received_at__c || null,
            },
          });
        }

        if (exportCsv) {
          csvRows.push({
            stripe_charge_id: transactionPayload.stripe_charge_id__c || charge.id || null,
            stripe_payment_intent_id: transactionPayload.stripe_payment_intent_id__c || null,
            payment_type: paymentType,
            payment_status: transactionPayload.status__c || charge.status || null,
            amount_gross: transactionPayload.amount_gross__c,
            amount_fee: transactionPayload.amount_fee__c,
            amount_net: transactionPayload.amount_net__c,
            currency: transactionPayload.currency_iso_code__c || charge.currency || null,
            stripe_customer_id: transactionPayload.stripe_customer_id__c || customerId,
            customer_name: customerPayload?.Name || null,
            customer_email: customerPayload?.Email || null,
            received_at: transactionPayload.received_at__c || null,
          });
        }

        if (dryRun || exportCsv) {
          continue;
        }

        const salesforceSvc = await ensureSalesforce();

        if (customerPayload) {
          await salesforceSvc.upsertCustomerByStripeId(customerPayload);
          summary.salesforce.customerUpserts += 1;
        }

        await salesforceSvc.upsertTransactionByExternalId(
          transactionPayload,
          'stripe_charge_id__c'
        );
        summary.salesforce.paymentUpserts += 1;
      } catch (error) {
        summary.errors += 1;

        if (errorSamples.length < exampleLimit) {
          errorSamples.push({
            chargeId: charge?.id || null,
            message: error instanceof Error ? error.message : String(error),
          });
        }

        context.log('[salesforcePaymentsSync] Failed to process payment', {
          chargeId: charge?.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    summary.customers.uniqueCustomerCount = uniqueCustomerIds.size;

    if (exportCsv) {
      const csvContent = buildPaymentsCsv(csvRows);
      const fileName = `stripe-payments-export-${formatTimestampForFilename()}.csv`;

      return {
        status: 200,
        headers: {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': `attachment; filename="${fileName}"`,
        },
        body: csvContent,
      };
    }

    return {
      status: 200,
      jsonBody: {
        success: true,
        dryRun,
        testMode,
        dryRunForcedByTestMode: forcedByTestMode,
        paymentCount: summary.totalPayments,
        counts: summary,
        examplePayloads: examples,
        errors: errorSamples,
      },
    };
  } catch (error) {
    context.log('[salesforcePaymentsSync] Unhandled error', {
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });

    return {
      status: 500,
      jsonBody: {
        error: 'internal_error',
        message: 'Failed to sync Stripe payments to Salesforce.',
        details: error instanceof Error ? error.message : String(error),
      },
    };
  }
};

syncSalesforcePayments.__internals = {
  setDependencies,
  resetDependencies,
};

module.exports = syncSalesforcePayments;
