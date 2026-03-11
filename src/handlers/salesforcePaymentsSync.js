const Stripe = require('stripe');
const { SalesforceService, buildSalesforceConfig } = require('../services/salesforceService');

const { mapStripeToTransaction } = require('../domain/transactions');

let createSalesforceSvc;
let TRANSACTION_FIELD_API_NAMES = {};
try {
  ({ createSalesforceSvc, TRANSACTION_FIELD_API_NAMES } = require('../services/salesforceSvc'));
} catch (error) {
  createSalesforceSvc = null;
  TRANSACTION_FIELD_API_NAMES = {};
}

const STRIPE_API_VERSION = '2023-10-16';
const DEFAULT_EXAMPLE_LIMIT = 3;
const MAX_EXAMPLE_LIMIT = 10;
const DEFAULT_PAGE_SIZE = 100;
const MAX_PAGE_SIZE = 100;
const DEFAULT_MAX_PAGES = 3;
const MAX_MAX_PAGES = 25;
const DEFAULT_MAX_RUNTIME_MS = 25_000;
const MIN_MAX_RUNTIME_MS = 5_000;
const MAX_MAX_RUNTIME_MS = 110_000;
const DEFAULT_MAX_RECORDS = 300;
const MAX_MAX_RECORDS = 5_000;

const SALESFORCE_RELATIONSHIP_FIELD = 'Contact__r.Stripe_Customer_Id__c';
const TRANSACTION_CSV_HEADERS = Array.from(
  new Set([
    ...Object.values(TRANSACTION_FIELD_API_NAMES || {}),
    SALESFORCE_RELATIONSHIP_FIELD,
  ])
);

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

const buildPaymentsCsv = (rows, headers = TRANSACTION_CSV_HEADERS) => {
  const csvRows = [headers.join(',')];

  for (const row of rows) {
    const values = headers.map((header) => csvEscape(row[header]));
    csvRows.push(values.join(','));
  }

  return `${csvRows.join('\n')}\n`;
};

const toSalesforceTransactionCsvRow = (transactionPayload, fallbackCustomerId = null) => {
  const row = {};

  for (const [dtoFieldName, apiFieldName] of Object.entries(TRANSACTION_FIELD_API_NAMES || {})) {
    row[apiFieldName] = transactionPayload?.[dtoFieldName] ?? null;
  }

  row[SALESFORCE_RELATIONSHIP_FIELD] =
    transactionPayload?.stripe_customer_id__c || fallbackCustomerId || null;

  return row;
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

const parseModeToggle = (value) => {
  if (value === undefined || value === null || value === '') {
    return { isValid: true };
  }

  if (typeof value !== 'string') {
    return { isValid: false, message: 'mode must be a string value: test or live.' };
  }

  const normalized = value.trim().toLowerCase();
  if (normalized === 'test' || normalized === 'sandbox') {
    return { isValid: true, testMode: true };
  }

  if (normalized === 'live') {
    return { isValid: true, testMode: false };
  }

  return { isValid: false, message: 'mode must be either "test" or "live".' };
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

const parseIntegerWithBounds = (value, defaultValue, min, max) => {
  if (value === undefined || value === null || value === '') {
    return defaultValue;
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return defaultValue;
  }

  const rounded = Math.trunc(parsed);
  if (rounded < min) {
    return min;
  }

  if (rounded > max) {
    return max;
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

const createSummary = () => ({
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
});

const hasReachedRuntimeLimit = (startedAt, maxRuntimeMs) => Date.now() - startedAt >= maxRuntimeMs;

const hasReachedRecordLimit = (processedRecordCount, maxRecords) => processedRecordCount >= maxRecords;

const resolveSyncOptions = ({ query, deps }) => {
  const requestedDryRun = parseBoolean(query.dryRun, false);
  const testMode = parseBoolean(deps.testMode, false);
  const dryRun = testMode ? true : requestedDryRun;
  const forcedByTestMode = testMode && !requestedDryRun;
  const exampleLimit = parseExampleLimit(query.exampleLimit);
  const format = typeof query.format === 'string' ? query.format.trim().toLowerCase() : '';
  const exportCsv = format === 'csv';
  const pageSize = parseIntegerWithBounds(
    query.pageSize,
    DEFAULT_PAGE_SIZE,
    1,
    MAX_PAGE_SIZE
  );
  const maxPages = parseIntegerWithBounds(
    query.maxPages,
    DEFAULT_MAX_PAGES,
    1,
    MAX_MAX_PAGES
  );
  const maxRuntimeMs = parseIntegerWithBounds(
    query.maxRuntimeMs,
    DEFAULT_MAX_RUNTIME_MS,
    MIN_MAX_RUNTIME_MS,
    MAX_MAX_RUNTIME_MS
  );
  const maxRecords = parseIntegerWithBounds(
    query.maxRecords,
    DEFAULT_MAX_RECORDS,
    1,
    MAX_MAX_RECORDS
  );
  const includeCustomerLookup = parseBoolean(
    query.includeCustomerLookup,
    !dryRun && !exportCsv
  );
  const requestedCursor =
    typeof query.cursor === 'string' && query.cursor.trim().length > 0 ? query.cursor.trim() : null;

  return {
    dryRun,
    testMode,
    forcedByTestMode,
    exampleLimit,
    exportCsv,
    pageSize,
    maxPages,
    maxRuntimeMs,
    maxRecords,
    includeCustomerLookup,
    requestedCursor,
  };
};

const fetchStripeCustomerSafely = async (stripe, customerId) => {
  if (!customerId) {
    return null;
  }

  try {
    const stripeCustomer = await stripe.customers.retrieve(customerId);
    if (!stripeCustomer || stripeCustomer.deleted) {
      return null;
    }

    return stripeCustomer;
  } catch (error) {
    return null;
  }
};

const buildSalesforceCustomerPayload = (stripeCustomer) => {
  if (!stripeCustomer) {
    return null;
  }

  const { firstName, lastName } = splitName(stripeCustomer.name);
  return {
    stripe_customer_id__c: stripeCustomer.id,
    Name: stripeCustomer.name || stripeCustomer.email || `Customer ${stripeCustomer.id}`,
    Email: stripeCustomer.email || null,
    FirstName: firstName,
    LastName: lastName,
  };
};

const fetchChargesPage = async (stripe, { limit, startingAfter }) => {
  const params = {
    limit,
  };

  if (startingAfter) {
    params.starting_after = startingAfter;
  }

  const response = await stripe.charges.list(params);
  const data = Array.isArray(response?.data) ? response.data : [];
  const hasMore = Boolean(response?.has_more && data.length > 0);
  const nextCursor = hasMore ? data[data.length - 1].id : null;

  return {
    data,
    hasMore,
    nextCursor,
  };
};

const fetchPaymentIntentForCharge = async (stripe, charge) => {
  const paymentIntentId = normalizeStripeId(charge?.payment_intent);
  if (!paymentIntentId) {
    return null;
  }

  const paymentIntentApi = stripe?.paymentIntents;
  if (!paymentIntentApi || typeof paymentIntentApi.retrieve !== 'function') {
    return null;
  }

  try {
    return await paymentIntentApi.retrieve(paymentIntentId);
  } catch (error) {
    return null;
  }
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
        if (!createSalesforceSvc) {
          throw new Error('Salesforce service is not available.');
        }

        const service = new SalesforceService(buildSalesforceConfig());
        const connection = await service.authenticate();
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
  const readHeader = (name) => {
    const headers = request?.headers;
    if (!headers) {
      return undefined;
    }

    if (typeof headers.get === 'function') {
      return headers.get(name) || undefined;
    }

    return headers[name] || headers[name?.toLowerCase?.()] || headers[name?.toUpperCase?.()];
  };

  if (request?.query && typeof request.query.get === 'function') {
    return {
      mode: request.query.get('mode') || readHeader('x-stripe-mode') || undefined,
      dryRun: request.query.get('dryRun') || undefined,
      exampleLimit: request.query.get('exampleLimit') || undefined,
      format: request.query.get('format') || undefined,
      cursor: request.query.get('cursor') || undefined,
      pageSize: request.query.get('pageSize') || undefined,
      maxPages: request.query.get('maxPages') || undefined,
      maxRuntimeMs: request.query.get('maxRuntimeMs') || undefined,
      maxRecords: request.query.get('maxRecords') || undefined,
      includeCustomerLookup: request.query.get('includeCustomerLookup') || undefined,
    };
  }

  if (request?.query && typeof request.query === 'object') {
    return {
      ...request.query,
      mode: request.query.mode || readHeader('x-stripe-mode') || undefined,
    };
  }

  try {
    if (typeof request?.url === 'string') {
      const parsed = new URL(request.url);
      return {
        mode: parsed.searchParams.get('mode') || readHeader('x-stripe-mode') || undefined,
        dryRun: parsed.searchParams.get('dryRun') || undefined,
        exampleLimit: parsed.searchParams.get('exampleLimit') || undefined,
        format: parsed.searchParams.get('format') || undefined,
        cursor: parsed.searchParams.get('cursor') || undefined,
        pageSize: parsed.searchParams.get('pageSize') || undefined,
        maxPages: parsed.searchParams.get('maxPages') || undefined,
        maxRuntimeMs: parsed.searchParams.get('maxRuntimeMs') || undefined,
        maxRecords: parsed.searchParams.get('maxRecords') || undefined,
        includeCustomerLookup: parsed.searchParams.get('includeCustomerLookup') || undefined,
      };
    }
  } catch (error) {
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

    const modeToggle = parseModeToggle(query.mode);
    if (!modeToggle.isValid) {
      return {
        status: 400,
        jsonBody: {
          error: 'bad_request',
          message: modeToggle.message,
        },
      };
    }

    let runtimeDeps = deps;
    if (typeof modeToggle.testMode === 'boolean') {
      const stripeSecret = resolveStripeSecret(modeToggle.testMode);
      if (!stripeSecret) {
        return {
          status: 500,
          jsonBody: {
            error: 'configuration_error',
            message: modeToggle.testMode
              ? 'STRIPE_TEST_SECRET_KEY (or STRIPE_SECRET) is not configured.'
              : 'STRIPE_LIVE_SECRET_KEY (or STRIPE_SECRET) is not configured.',
          },
        };
      }

      runtimeDeps = {
        ...deps,
        testMode: modeToggle.testMode,
        stripe: new Stripe(stripeSecret, { apiVersion: STRIPE_API_VERSION }),
      };
    }

    const {
      dryRun,
      testMode,
      forcedByTestMode,
      exampleLimit,
      exportCsv,
      pageSize,
      maxPages,
      maxRuntimeMs,
      maxRecords,
      includeCustomerLookup,
      requestedCursor,
    } = resolveSyncOptions({ query, deps: runtimeDeps });
    const startedAt = Date.now();
    const summary = createSummary();

    const uniqueCustomerIds = new Set();
    const examples = [];
    const errorSamples = [];
    const csvRows = [];
    let pagesProcessed = 0;
    let hasMore = false;
    let nextCursor = requestedCursor;
    let stopReason = 'completed';

    let salesforce = null;
    const ensureSalesforce = async () => {
      if (!salesforce) {
        salesforce = await deps.getSalesforceSvc();
      }
      return salesforce;
    };

    while (pagesProcessed < maxPages) {
      if (hasReachedRecordLimit(summary.totalPayments, maxRecords)) {
        stopReason = 'max_records_reached';
        break;
      }

      if (hasReachedRuntimeLimit(startedAt, maxRuntimeMs)) {
        stopReason = 'max_runtime_reached';
        break;
      }

      const page = await fetchChargesPage(runtimeDeps.stripe, {
        limit: pageSize,
        startingAfter: nextCursor,
      });

      pagesProcessed += 1;
      hasMore = page.hasMore;
      nextCursor = page.nextCursor;

      for (const charge of page.data) {
        summary.totalPayments += 1;

        try {
          const isSucceededCharge = charge.status === 'succeeded';

          if (!isSucceededCharge) {
            summary.skippedPayments += 1;

            if (!exportCsv) {
              continue;
            }
          }

          if (isSucceededCharge) {
            summary.successfulPayments += 1;
          }

          const customerId = normalizeStripeId(charge.customer);
          if (customerId) {
            summary.customers.withCustomerId += 1;
            uniqueCustomerIds.add(customerId);
          } else {
            summary.customers.withoutCustomerId += 1;
          }

          let balanceTransaction = null;
          const balanceTransactionId = normalizeStripeId(charge.balance_transaction);
          if (balanceTransactionId) {
            try {
              balanceTransaction = await runtimeDeps.stripe.balanceTransactions.retrieve(balanceTransactionId);
            } catch (error) {
              balanceTransaction = null;
            }
          }

              const paymentIntent = await fetchPaymentIntentForCharge(runtimeDeps.stripe, charge);
              const stripeCustomer = await fetchStripeCustomerSafely(runtimeDeps.stripe, customerId);

          const transactionPayload = mapStripeToTransaction({
            paymentIntent,
            charge,
            balanceTransaction,
            stripeCustomer,
          });

          const paymentType =
            transactionPayload.status__c === 'refunded'
              ? 'refunded'
              : transactionPayload.status__c === 'disputed'
                ? 'disputed'
                : derivePaymentType(charge);

          if (exportCsv || isSucceededCharge) {
            summary.paymentTypes[paymentType] += 1;
          }

          let customerPayload = null;

          if (customerId && includeCustomerLookup) {
            customerPayload = buildSalesforceCustomerPayload(stripeCustomer);
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
            csvRows.push(toSalesforceTransactionCsvRow(transactionPayload, customerId));
          }

          if (!isSucceededCharge) {
            continue;
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

        if (hasReachedRecordLimit(summary.totalPayments, maxRecords)) {
          stopReason = 'max_records_reached';
          break;
        }

        if (hasReachedRuntimeLimit(startedAt, maxRuntimeMs)) {
          stopReason = 'max_runtime_reached';
          break;
        }
      }

      if (!hasMore) {
        stopReason = 'completed';
        break;
      }

      if (
        hasReachedRecordLimit(summary.totalPayments, maxRecords) ||
        hasReachedRuntimeLimit(startedAt, maxRuntimeMs)
      ) {
        break;
      }

      if (nextCursor === null) {
        break;
      }
    }

    if (hasMore && stopReason === 'completed') {
      stopReason = pagesProcessed >= maxPages ? 'max_pages_reached' : 'partial';
    }

    summary.customers.uniqueCustomerCount = uniqueCustomerIds.size;

    const pagination = {
      pageSize,
      maxPages,
      maxRuntimeMs,
      maxRecords,
      pagesProcessed,
      recordsProcessed: summary.totalPayments,
      requestedCursor,
      nextCursor: hasMore ? nextCursor : null,
      hasMore,
      stopReason,
      continuationRecommended: hasMore,
    };

    if (exportCsv) {
      const csvContent = buildPaymentsCsv(csvRows);
      const fileName = `stripe-payments-export-${formatTimestampForFilename()}.csv`;

      return {
        status: 200,
        headers: {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': `attachment; filename="${fileName}"`,
          'X-Has-More': hasMore ? 'true' : 'false',
          'X-Next-Cursor': hasMore && nextCursor ? nextCursor : '',
          'X-Stop-Reason': stopReason,
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
        pagination,
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
