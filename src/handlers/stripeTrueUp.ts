import type { InvocationContext, HttpRequest } from '@azure/functions';
import Stripe from 'stripe';
import jsforce from 'jsforce';

// Try to import env config, but don't fail if it's incomplete
let env: any = { stripe: { secret: '' } };
try {
  env = require('../config/env').default;
} catch (error) {
  console.warn('[StripeTrueUp] env.ts failed to load, will use environment variables directly:', error);
}

import {
  centsToPositiveMajorUnits,
  findCheckoutSessionForPaymentIntent,
  normalizeStripeId,
  resolveBalanceTransaction,
  resolveCharge,
  resolveStripeCustomer,
  timestampToDate,
  timestampToIsoString,
  getProductNameFromCharge,
  getFrequencyFromSubscription,
} from '../stripe/utils';

// Import types only, not the actual implementations (to avoid env.ts loading)
import type { PostChargeToQboResult } from '../services/qboSvc';

import { AzureIdempotencyStore, type IdempotencyStore } from '../services/idempotencyStore';
import {
  createSalesforceSvc,
  type SalesforceSvc,
  type QuickBooksDocumentReference,
} from '../services/salesforceSvc';
import { mapStripeToTransaction, type TransactionUpsertDTO } from '../domain/transactions';
import { 
  loadConfig, 
  normalizeTransactionCategory, 
  generateTransactionName 
} from '../config/contactMatching';
import {
  fetchStripeChargesSince,
  fetchStripeRefundsSince,
  fetchStripePayoutsSince,
  fetchBalanceTransactionsForPayout,
  normalizeSince,
} from '../services/qbo/stripe/fetchStripe';

const STRIPE_API_VERSION: Stripe.LatestApiVersion = '2023-10-16';

interface StripeServices {
  getClient: (livemode: boolean) => Stripe;
}

interface FetchServices {
  payments: typeof fetchStripeChargesSince;
  refunds: typeof fetchStripeRefundsSince;
  payouts: typeof fetchStripePayoutsSince;
  payoutBalance: typeof fetchBalanceTransactionsForPayout;
}

// Lazy-load QBO functions to avoid importing env.ts at module load time
let qboFunctions: any = null;
const getQboFunctions = () => {
  if (!qboFunctions) {
    try {
      const qboSvc = require('../services/qboSvc');
      qboFunctions = {
        postChargeToQbo: qboSvc.postChargeToQbo,
        postRefundToQbo: qboSvc.postRefundToQbo,
        postPayoutToQbo: qboSvc.postPayoutToQbo,
      };
    } catch (error) {
      console.warn('[StripeTrueUp] Could not load qboSvc, QBO posting will be disabled:', error);
      // Return no-op functions
      qboFunctions = {
        postChargeToQbo: async () => ({ success: false, error: 'QBO service not available' }),
        postRefundToQbo: async () => ({ success: false, error: 'QBO service not available' }),
        postPayoutToQbo: async () => ({ success: false, error: 'QBO service not available' }),
      };
    }
  }
  return qboFunctions;
};

interface AccountingServices {
  postChargeToQbo: (charge: any, options?: any) => Promise<PostChargeToQboResult>;
  postRefundToQbo: (refund: any, options?: any) => Promise<any>;
  postPayoutToQbo: (payout: any, balanceTransactions?: any[], options?: any) => Promise<any>;
}

interface Dependencies {
  stripe: StripeServices;
  fetchers: FetchServices;
  idempotencyStore: IdempotencyStore;
  getSalesforceSvc: () => Promise<SalesforceSvc>;
  accounting: AccountingServices;
}

interface ProcessSummary {
  fetched: number;
  processed: number;
  skipped: number;
  salesforceUpdates: number;
  qboPosts: number;
  errors: number;
}

type HttpContext = InvocationContext & {
  res?: {
    status?: number;
    headers?: Record<string, string>;
    body?: unknown;
  };
  log: (...args: unknown[]) => void;
};

type DependencyOverrides = Partial<{
  stripe: Partial<StripeServices>;
  fetchers: Partial<FetchServices>;
  idempotencyStore: IdempotencyStore;
  getSalesforceSvc: () => Promise<SalesforceSvc>;
  accounting: Partial<AccountingServices>;
}>;

const createInMemoryStore = (): IdempotencyStore => {
  const processed = new Set<string>();
  return {
    async isProcessed(key: string): Promise<boolean> {
      return processed.has(key);
    },
    async markProcessed(key: string): Promise<void> {
      processed.add(key);
    },
    async withLock<T>(_: string, fn: () => Promise<T>): Promise<T> {
      return fn();
    },
    async flush(): Promise<void> {
      // no-op
    },
  };
};

const createStripeServices = (): StripeServices => {
  const cache = new Map<boolean, Stripe>();

  const getClient = (livemode: boolean): Stripe => {
    if (cache.has(livemode)) {
      return cache.get(livemode)!;
    }

    const secret = livemode
      ? process.env.STRIPE_LIVE_SECRET_KEY || env.stripe.secret
      : process.env.STRIPE_TEST_SECRET_KEY || env.stripe.secret;

    const client = new Stripe(secret, {
      apiVersion: STRIPE_API_VERSION,
    });
    cache.set(livemode, client);
    return client;
  };

  return { getClient };
};

let defaultSalesforceSvcPromise: Promise<SalesforceSvc> | null = null;
let salesforceConnection: any = null;

const createSalesforceGetter = (): (() => Promise<SalesforceSvc>) => {
  return async (): Promise<SalesforceSvc> => {
    if (!defaultSalesforceSvcPromise) {
      defaultSalesforceSvcPromise = (async () => {
        const username = process.env.SALESFORCE_USERNAME;
        const password = process.env.SALESFORCE_PASSWORD;
        const securityToken = process.env.SALESFORCE_SECURITY_TOKEN || '';
        const loginUrl = process.env.SALESFORCE_LOGIN_URL || 'https://login.salesforce.com';

        if (!username || !password) {
          throw new Error('Salesforce credentials are not configured.');
        }

        salesforceConnection = new jsforce.Connection({ loginUrl });
        await salesforceConnection.login(username, `${password}${securityToken}`);
        return createSalesforceSvc({ connection: salesforceConnection });
      })();
    }

    return defaultSalesforceSvcPromise;
  };
};

let defaultCrmSvcPromise: Promise<any> | null = null;

const createCrmGetter = (): (() => Promise<any>) => {
  return async (): Promise<any> => {
    if (!defaultCrmSvcPromise) {
      defaultCrmSvcPromise = (async () => {
        try {
          const CrmFactory = require('../services/salesforce/crmFactory');
          const username = process.env.SALESFORCE_USERNAME;
          const password = process.env.SALESFORCE_PASSWORD;
          const securityToken = process.env.SALESFORCE_SECURITY_TOKEN || '';
          const loginUrl = process.env.SALESFORCE_LOGIN_URL || 'https://login.salesforce.com';

          if (!username || !password) {
            throw new Error('Salesforce CRM credentials are not configured.');
          }

          const crmConfig = {
            username,
            password,
            securityToken,
            loginUrl,
          };

          const validation = CrmFactory.validateConfig('salesforce', crmConfig);
          if (!validation.isValid) {
            throw new Error(`Invalid CRM configuration: ${validation.error}`);
          }

          return CrmFactory.createCrmService('salesforce', crmConfig);
        } catch (error) {
          defaultCrmSvcPromise = null;
          const message = error instanceof Error ? error.message : 'Unknown CRM initialization error';
          console.error('[StripeTrueUp] CRM initialization failed:', message);
          
          // Return disabled service on error
          return {
            async findOrCreateCampaign(name: string): Promise<string> {
              return `701000000000000_${name}`;
            },
          };
        }
      })();
    }

    return defaultCrmSvcPromise;
  };
};

const createDefaultDependencies = (): Dependencies => ({
  stripe: createStripeServices(),
  fetchers: {
    payments: fetchStripeChargesSince,
    refunds: fetchStripeRefundsSince,
    payouts: fetchStripePayoutsSince,
    payoutBalance: fetchBalanceTransactionsForPayout,
  },
  idempotencyStore:
    process.env.DISABLE_AZURE_TABLES === '1' ? createInMemoryStore() : new AzureIdempotencyStore(),
  getSalesforceSvc: createSalesforceGetter(),
  accounting: getQboFunctions(), // Lazy-load QBO functions
});

let dependencies: Dependencies = createDefaultDependencies();

const setDependencies = (overrides: DependencyOverrides = {}): void => {
  if (overrides.idempotencyStore) {
    dependencies.idempotencyStore = overrides.idempotencyStore;
  }

  if (overrides.getSalesforceSvc) {
    dependencies.getSalesforceSvc = overrides.getSalesforceSvc;
  }

  if (overrides.stripe) {
    dependencies.stripe = {
      ...dependencies.stripe,
      ...overrides.stripe,
    };
  }

  if (overrides.fetchers) {
    dependencies.fetchers = {
      ...dependencies.fetchers,
      ...overrides.fetchers,
    } as FetchServices;
  }

  if (overrides.accounting) {
    dependencies.accounting = {
      ...dependencies.accounting,
      ...overrides.accounting,
    } as AccountingServices;
  }
};

const resetDependencies = (): void => {
  defaultSalesforceSvcPromise = null;
  salesforceConnection = null;
  dependencies = createDefaultDependencies();
};

const getHeader = (req: HttpRequest, name: string): string | undefined => {
  const headers = (req as unknown as { headers?: Headers | Record<string, string> }).headers;
  if (!headers) {
    return undefined;
  }

  if (typeof (headers as Headers).get === 'function') {
    const cast = headers as Headers;
    return (
      cast.get(name) ?? cast.get(name.toLowerCase()) ?? cast.get(name.toUpperCase()) ?? undefined
    );
  }

  const record = headers as Record<string, string | undefined>;
  return record[name] || record[name.toLowerCase()] || record[name.toUpperCase()];
};

const parseBoolean = (value: unknown, defaultValue: boolean): boolean => {
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

const toEpochSeconds = (value: unknown): number => {
  try {
    return normalizeSince(value as never);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid date parameter: ${message}`);
  }
};

const markPosted = async (
  salesforce: SalesforceSvc,
  upsertResult: unknown,
  doc: PostChargeToQboResult
): Promise<void> => {
  if (!salesforce || typeof salesforce.markPostedToQbo !== 'function') {
    return;
  }

  const id =
    upsertResult &&
    typeof upsertResult === 'object' &&
    'id' in (upsertResult as Record<string, unknown>)
      ? (upsertResult as { id?: string }).id
      : undefined;

  if (typeof id === 'string' && id.trim().length > 0) {
    const reference: QuickBooksDocumentReference = {
      id: doc.qboId,
      type: doc.type,
    };
    await salesforce.markPostedToQbo(id, reference);
  }
};

const ensureStripeBalanceTransaction = async (
  stripe: Stripe,
  value: Stripe.BalanceTransaction | string | null | undefined
): Promise<Stripe.BalanceTransaction | null> => {
  if (!value) {
    return null;
  }
  if (typeof value === 'string') {
    try {
      return await stripe.balanceTransactions.retrieve(value);
    } catch (error) {
      return null;
    }
  }
  return value;
};

const extractStripeId = (value: unknown): string | null => {
  if (!value) {
    return null;
  }

  if (typeof value === 'string') {
    return value;
  }

  if (typeof value === 'object' && value !== null && 'id' in (value as Record<string, unknown>)) {
    const idValue = (value as Record<string, unknown>).id;
    return typeof idValue === 'string' ? idValue : null;
  }

  return null;
};

const resolveCustomerForCharge = async (
  stripe: Stripe,
  charge: Stripe.Charge,
  logger: (...args: unknown[]) => void
): Promise<(Stripe.Customer | Stripe.DeletedCustomer) | null> => {
  const customerId = extractStripeId(charge.customer);
  if (!customerId) {
    return null;
  }

  try {
    const customer = await stripe.customers.retrieve(customerId);
    return customer as Stripe.Customer | Stripe.DeletedCustomer;
  } catch (error) {
    logger('[StripeTrueUp] Failed to retrieve Stripe customer', {
      chargeId: charge.id,
      customerId,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
};



const getTransactionNameFromMetadata = (charge: Stripe.Charge): string | null => {
  const metadata = charge.metadata as Record<string, unknown> | null | undefined;
  if (!metadata || typeof metadata !== 'object') {
    return null;
  }

  // Check for category field (customer categorization, not product type)
  // Note: transactionType is used for QuickBooks item/product type, not customer categorization
  const category = metadata.category || metadata.Category;
  if (typeof category === 'string' && category.trim()) {
    return category.trim();
  }

  return null;
};

const findOrCreateContactInSalesforce = async (
  salesforceSvc: SalesforceSvc,
  customer: Stripe.Customer | Stripe.DeletedCustomer | null,
  transactionName: string | null,
  contextLog: typeof console.log
): Promise<{ id: string } | null> => {
  if (!customer || customer.deleted) {
    return null;
  }

  const stripeCustomer = customer as Stripe.Customer;
  
  // Use transaction name as customer category/name, fallback to customer name or email
  let customerName = transactionName;
  if (!customerName) {
    customerName = stripeCustomer.name || stripeCustomer.email || `Customer ${stripeCustomer.id}`;
  }

  // Parse name into first and last name
  let firstName: string | null = null;
  let lastName: string | null = null;
  
  if (stripeCustomer.name) {
    const nameParts = stripeCustomer.name.trim().split(/\s+/);
    if (nameParts.length === 1) {
      lastName = nameParts[0];
    } else if (nameParts.length >= 2) {
      firstName = nameParts[0];
      lastName = nameParts.slice(1).join(' ');
    }
  }

  // If we still don't have a lastName, use the customer name as lastName (required by Salesforce)
  if (!lastName) {
    lastName = customerName;
  }

  contextLog('[StripeTrueUp] Starting contact find/create process', {
    customerId: stripeCustomer.id,
    customerName,
    firstName,
    lastName,
    email: stripeCustomer.email,
  });

  try {
    // Get the jsforce connection - use the global one or create a new one
    const connection = salesforceConnection || (await createSalesforceConnection());

    if (!connection) {
      contextLog('[StripeTrueUp] No Salesforce connection available');
      return null;
    }

    contextLog('[StripeTrueUp] Salesforce connection established');

    // Step 1: Search for existing contact using SOQL
    const whereConditions: string[] = [];

    // Priority 1: Search by Stripe Customer ID
    if (stripeCustomer.id) {
      const escapedId = stripeCustomer.id.replace(/'/g, "\\'");
      whereConditions.push(`Stripe_Customer_Id__c = '${escapedId}'`);
    }

    // Priority 2: Search by email
    if (stripeCustomer.email) {
      const escapedEmail = stripeCustomer.email.replace(/'/g, "\\'");
      whereConditions.push(`Email = '${escapedEmail}'`);
    }

    // Priority 3: Search by name combination
    if (firstName && lastName) {
      const escapedFirst = firstName.replace(/'/g, "\\'");
      const escapedLast = lastName.replace(/'/g, "\\'");
      whereConditions.push(
        `(FirstName = '${escapedFirst}' AND LastName = '${escapedLast}')`
      );
    }

    let existingContact: any = null;

    if (whereConditions.length > 0) {
      const query = `SELECT Id, FirstName, LastName, Email, Stripe_Customer_Id__c 
                     FROM Contact 
                     WHERE ${whereConditions.join(' OR ')} 
                     ORDER BY CreatedDate DESC 
                     LIMIT 10`;

      contextLog('[StripeTrueUp] Executing SOQL query', { 
        query,
        whereConditions,
      });

      const result = await connection.query(query);

      contextLog('[StripeTrueUp] SOQL query completed', {
        recordCount: result.records?.length || 0,
      });

      if (result.records && result.records.length > 0) {
        // Priority matching:
        // 1. Exact Stripe Customer ID match
        const stripeIdMatch = result.records.find(
          (c: any) => c.Stripe_Customer_Id__c === stripeCustomer.id
        );

        if (stripeIdMatch) {
          existingContact = stripeIdMatch;
          contextLog('[StripeTrueUp] Found contact by Stripe Customer ID', {
            contactId: existingContact.Id,
            stripeCustomerId: stripeCustomer.id,
          });
        } else if (firstName && lastName) {
          // 2. Name match (to prevent updating wrong contact)
          const nameMatch = result.records.find((c: any) => {
            const firstNameMatch =
              c.FirstName &&
              firstName &&
              c.FirstName.toLowerCase() === firstName.toLowerCase();
            const lastNameMatch =
              c.LastName &&
              lastName &&
              c.LastName.toLowerCase() === lastName.toLowerCase();
            return firstNameMatch && lastNameMatch;
          });

          if (nameMatch) {
            existingContact = nameMatch;
            contextLog('[StripeTrueUp] Found contact by name match', {
              contactId: existingContact.Id,
              firstName,
              lastName,
            });
          }
        } else {
          // 3. Use first result (email match)
          existingContact = result.records[0];
          contextLog('[StripeTrueUp] Found contact by email', {
            contactId: existingContact.Id,
            email: stripeCustomer.email,
          });
        }
      }
    } else {
      contextLog('[StripeTrueUp] No search conditions available, will create new contact');
    }

    // Step 2: Update existing contact or create new one
    if (existingContact) {
      // Update existing contact
      const updateFields: Record<string, any> = {
        Id: existingContact.Id,
      };

      // Update Stripe Customer ID if not set
      if (!existingContact.Stripe_Customer_Id__c && stripeCustomer.id) {
        updateFields.Stripe_Customer_Id__c = stripeCustomer.id;
        contextLog('[StripeTrueUp] Adding Stripe Customer ID to existing contact', {
          contactId: existingContact.Id,
          stripeCustomerId: stripeCustomer.id,
        });
      }

      // Update email if provided and different
      if (stripeCustomer.email && stripeCustomer.email !== existingContact.Email) {
        updateFields.Email = stripeCustomer.email;
      }

      // Update name if provided and different
      if (firstName && firstName !== existingContact.FirstName) {
        updateFields.FirstName = firstName;
      }
      if (lastName && lastName !== existingContact.LastName) {
        updateFields.LastName = lastName;
      }

      // Only update if there are changes beyond the Id
      if (Object.keys(updateFields).length > 1) {
        const updateResult = await connection.sobject('Contact').update(updateFields);
        
        if (!updateResult.success) {
          contextLog('[StripeTrueUp] Failed to update contact', {
            contactId: existingContact.Id,
            errors: updateResult.errors,
          });
        } else {
          contextLog('[StripeTrueUp] Updated existing contact', {
            contactId: existingContact.Id,
            updatedFields: Object.keys(updateFields).filter(k => k !== 'Id'),
          });
        }
      }

      return { id: existingContact.Id };
    } else {
      // Create new contact
      const contactRecord: Record<string, any> = {
        FirstName: firstName,
        LastName: lastName,
        Email: stripeCustomer.email || null,
        Stripe_Customer_Id__c: stripeCustomer.id,
      };

      contextLog('[StripeTrueUp] Creating new contact', {
        stripeCustomerId: stripeCustomer.id,
        firstName,
        lastName,
        email: stripeCustomer.email,
      });

      const createResult = await connection.sobject('Contact').create(contactRecord);

      if (!createResult.success) {
        contextLog('[StripeTrueUp] Failed to create contact', {
          errors: createResult.errors,
        });
        return null;
      }

      contextLog('[StripeTrueUp] Created new contact', {
        contactId: createResult.id,
        stripeCustomerId: stripeCustomer.id,
      });

      return { id: createResult.id };
    }
  } catch (error) {
    contextLog('[StripeTrueUp] Failed to find/create contact in Salesforce', {
      customerId: stripeCustomer.id,
      error: error instanceof Error ? error.message : String(error),
    });
    // Don't throw - continue processing even if customer upsert fails
    return null;
  }
};

const createSalesforceConnection = async (): Promise<any> => {
  const username = process.env.SALESFORCE_USERNAME;
  const password = process.env.SALESFORCE_PASSWORD;
  const securityToken = process.env.SALESFORCE_SECURITY_TOKEN || '';
  const loginUrl = process.env.SALESFORCE_LOGIN_URL || 'https://login.salesforce.com';

  if (!username || !password) {
    throw new Error('Salesforce credentials are not configured.');
  }

  const connection = new jsforce.Connection({ loginUrl });
  await connection.login(username, `${password}${securityToken}`);
  return connection;
};

const processPayments = async (
  context: HttpContext,
  stripe: Stripe,
  from: number,
  to: number | null,
  dryRun: boolean,
  resubmit: boolean
): Promise<ProcessSummary> => {
  const summary: ProcessSummary = {
    fetched: 0,
    processed: 0,
    skipped: 0,
    salesforceUpdates: 0,
    qboPosts: 0,
    errors: 0,
  };

  const params = to
    ? { params: { created: { lte: to } }, logger: context.log }
    : { logger: context.log };

  const charges = await dependencies.fetchers.payments(stripe, from, params as never);
  summary.fetched = charges.length;

  let salesforceSvc: SalesforceSvc | null = null;
  const ensureSalesforce = async (): Promise<SalesforceSvc> => {
    if (!salesforceSvc) {
      salesforceSvc = await dependencies.getSalesforceSvc();
    }
    return salesforceSvc;
  };

  for (const charge of charges) {
    try {
      // Only process successful charges
      if (charge.status !== 'succeeded') {
        context.log('[StripeTrueUp] Skipping charge with non-successful status', {
          chargeId: charge.id,
          status: charge.status,
        });
        summary.skipped += 1;
        continue;
      }

      const balanceTransaction = await ensureStripeBalanceTransaction(
        stripe,
        charge.balance_transaction as Stripe.BalanceTransaction | string | undefined
      );

      if (!balanceTransaction || !balanceTransaction.id) {
        context.log('[StripeTrueUp] Skipping charge without balance transaction', {
          chargeId: charge.id,
        });
        summary.errors += 1;
        continue;
      }

      const key = `bt_${balanceTransaction.id}`;
      
      // Check if already processed
      let shouldSkip = false;
      if (resubmit) {
        // In resubmit mode, check Salesforce for existing transaction
        const salesforce = await ensureSalesforce();
        const existingId = await salesforce.findTransactionIdByExternalId(
          'stripe_charge_id__c',
          charge.id
        );
        if (existingId) {
          context.log('[StripeTrueUp] Skipping charge already in Salesforce', {
            chargeId: charge.id,
            salesforceId: existingId,
          });
          shouldSkip = true;
        }
      } else {
        // Normal mode: check idempotency store
        const alreadyProcessed = await dependencies.idempotencyStore.isProcessed(key);
        if (alreadyProcessed) {
          shouldSkip = true;
        }
      }
      
      if (shouldSkip) {
        summary.skipped += 1;
        continue;
      }

      if (!dryRun) {
        const salesforce = await ensureSalesforce();
        
        const stripeCustomer = await resolveCustomerForCharge(
          stripe,
          charge as Stripe.Charge,
          (...args: unknown[]) => context.log(...args)
        );

        context.log('[StripeTrueUp] Retrieved customer from Stripe', {
          chargeId: charge.id,
          customerId: stripeCustomer?.id,
          customerExists: !!stripeCustomer,
          customerDeleted: stripeCustomer?.deleted,
        });

        // Upsert customer to Salesforce first to get the Contact ID
        let contactId: string | null = null;
        if (stripeCustomer && !stripeCustomer.deleted) {
          context.log('[StripeTrueUp] Calling upsertCustomerByStripeId', {
            customerId: stripeCustomer.id,
            customerName: (stripeCustomer as Stripe.Customer).name,
            customerEmail: (stripeCustomer as Stripe.Customer).email,
          });
          
          try {
            const customerUpsertResult = await salesforce.upsertCustomerByStripeId({
              stripe_customer_id__c: stripeCustomer.id,
              Name: (stripeCustomer as Stripe.Customer).name || (stripeCustomer as Stripe.Customer).email || `Customer ${stripeCustomer.id}`,
              Email: (stripeCustomer as Stripe.Customer).email || null,
            });
            contactId = customerUpsertResult?.id ?? null;
            
            context.log('[StripeTrueUp] Contact upsert completed', {
              contactId,
              success: !!contactId,
            });
          } catch (error) {
            context.log('[StripeTrueUp] Failed to upsert contact in Salesforce', {
              customerId: stripeCustomer.id,
              error: error instanceof Error ? error.message : String(error),
              stack: error instanceof Error ? error.stack : undefined,
            });
          }
        } else {
          context.log('[StripeTrueUp] Skipping contact creation', {
            reason: !stripeCustomer ? 'no customer' : 'customer deleted',
          });
        }

        // Build transaction with contact link if we have a contact ID
        const chargeObj = charge as Stripe.Charge;
        const paymentIntentId = typeof chargeObj.payment_intent === 'string' 
          ? chargeObj.payment_intent 
          : chargeObj.payment_intent?.id;
        
        const transaction = mapStripeToTransaction({
          paymentIntent: null, // We'll get the ID from the charge itself in the mapping
          charge: chargeObj,
          balanceTransaction,
        });

        // Extract frequency from subscription if charge has invoice and no frequency is set
        if (!transaction.frequency__c && chargeObj.invoice) {
          try {
            // Get invoice to find subscription
            const invoice = await stripe.invoices.retrieve(chargeObj.invoice as string);
            if (invoice.subscription) {
              const subscriptionId = typeof invoice.subscription === 'string' 
                ? invoice.subscription 
                : invoice.subscription.id;
              
              if (subscriptionId) {
                const frequency = await getFrequencyFromSubscription(stripe, subscriptionId, (...args: unknown[]) => context.log(...args));
                if (frequency) {
                  transaction.frequency__c = frequency;
                  context.log('[StripeTrueUp] Set frequency from subscription for charge', {
                    chargeId: charge.id,
                    invoiceId: chargeObj.invoice,
                    subscriptionId,
                    frequency,
                  });
                }
              }
            }
          } catch (error) {
            const message = error instanceof Error ? error.message : 'Unknown error getting frequency from subscription';
            context.log('[StripeTrueUp] Failed to get frequency from subscription for charge', {
              chargeId: charge.id,
              invoiceId: chargeObj.invoice,
              error: message,
            });
          }
        }

        // Generate transaction name
        const config = loadConfig();
        const metadata = chargeObj.metadata || {};
        
        context.log('[StripeTrueUp] Charge metadata for transaction naming', {
          chargeId: charge.id,
          metadata: metadata,
          hasCategory: !!(metadata.category || metadata.Category),
          hasTransactionType: !!(metadata.transactionType || metadata.TransactionType),
          hasPaymentIntent: !!paymentIntentId,
          paymentIntentId: paymentIntentId,
        });
        
        // Try to get product name from payment intent first
        let productName: string | null = null;
        if (paymentIntentId) {
          try {
            productName = await getProductNameFromCharge(
              stripe,
              chargeObj,
              (...args: unknown[]) => context.log(...args)
            );
          } catch (error) {
            context.log('[StripeTrueUp] Error getting product name', {
              chargeId: charge.id,
              error: error instanceof Error ? error.message : String(error),
              stack: error instanceof Error ? error.stack : undefined,
            });
          }
        }
        
        // Use product name, then metadata, then default
        const category = productName || metadata.category || metadata.Category || config.transaction.defaultCategory;
        const normalizedCategory = normalizeTransactionCategory(category, config);
        
        // Associate category with campaign if no campaign is already set
        if (!transaction.campaign__c && productName) {
          try {
            context.log('[StripeTrueUp] Associating category with campaign', {
              category: productName,
              chargeId: charge.id,
            });
            const crm = await createCrmGetter()();
            const campaignId = await crm.findOrCreateCampaign(productName);
            if (campaignId && typeof campaignId === 'string' && campaignId.trim().length > 0) {
              transaction.campaign__c = campaignId;
              context.log('[StripeTrueUp] Category associated with campaign', {
                category: productName,
                campaignId,
                chargeId: charge.id,
              });

              // Add contact as campaign member if contact is available
              if (transaction.contact__c && typeof transaction.contact__c === 'string' && transaction.contact__c.trim().length > 0) {
                try {
                  context.log('[StripeTrueUp] Adding contact as campaign member', {
                    campaignId,
                    contactId: transaction.contact__c,
                  });
                  const memberResult = await crm.addCampaignMember(campaignId, transaction.contact__c);
                  if (memberResult.isNew) {
                    context.log('[StripeTrueUp] Contact added as new campaign member', {
                      campaignId,
                      contactId: transaction.contact__c,
                      campaignMemberId: memberResult.id,
                    });
                  } else {
                    context.log('[StripeTrueUp] Contact is already a campaign member', {
                      campaignId,
                      contactId: transaction.contact__c,
                      campaignMemberId: memberResult.id,
                    });
                  }
                } catch (error) {
                  const message = error instanceof Error ? error.message : 'Unknown error';
                  context.log('[StripeTrueUp] Failed to add contact as campaign member', {
                    campaignId,
                    contactId: transaction.contact__c,
                    error: message,
                  });
                }
              }
            }
          } catch (error) {
            const message = error instanceof Error ? error.message : 'Unknown error';
            context.log(
              '[StripeTrueUp] Failed to associate category with campaign; continuing without campaign',
              { category: productName, error: message, chargeId: charge.id }
            );
          }
        }
        
        // Get transaction type from metadata if available, otherwise use derived type
        const metadataTransactionType = metadata.transactionType || metadata.TransactionType;
        const transactionTypeName = metadataTransactionType || 
                                    (transaction.transaction_type__c === 'charge' ? 'Payment' : 
                                     transaction.transaction_type__c === 'refund' ? 'Refund' : 
                                     transaction.transaction_type__c === 'dispute' ? 'Dispute' :
                                     transaction.transaction_type__c === 'payout' ? 'Payout' :
                                     'Transaction');
        
        const transactionName = generateTransactionName(normalizedCategory, config, {
          amount: transaction.amount_gross__c ? `$${transaction.amount_gross__c.toFixed(2)}` : undefined,
          date: new Date().toLocaleDateString(),
          id: charge.id,
          transactionType: transactionTypeName,
        });
        
        context.log('[StripeTrueUp] Generated transaction name', {
          chargeId: charge.id,
          category,
          normalizedCategory,
          transactionTypeName,
          transactionName,
        });
        
        if (transactionName) {
          transaction.Name = transactionName;
        }

        if (contactId) {
          transaction.contact__c = contactId;
          context.log('[StripeTrueUp] Associated contact with transaction', {
            contactId,
            transactionStripeChargeId: transaction.stripe_charge_id__c,
          });
        } else {
          context.log('[StripeTrueUp] No contact ID to associate with transaction', {
            transactionStripeChargeId: transaction.stripe_charge_id__c,
          });
        }

        context.log('[StripeTrueUp] Upserting transaction to Salesforce', {
          chargeId: charge.id,
          contactId: transaction.contact__c,
          hasContact: !!transaction.contact__c,
        });

        // Validate required fields before upserting
        if (!transaction.status__c || !transaction.amount_gross__c) {
          context.log('[StripeTrueUp] Skipping transaction upsert due to missing required fields', {
            chargeId: charge.id,
            status: transaction.status__c,
            amountGross: transaction.amount_gross__c,
            transaction,
          });
          summary.skipped += 1;
          continue;
        }

        const upsertResult = await salesforce.upsertTransactionByExternalId(
          transaction,
          'stripe_charge_id__c'
        );
        summary.salesforceUpdates += 1;

        // Create a minimal checkout session object with metadata for QBO customer naming
        const chargeMetadata = (charge as Stripe.Charge).metadata as Record<string, unknown> | null | undefined;
        const checkoutSessionStub = chargeMetadata ? {
          id: `stub_${charge.id}`,
          metadata: chargeMetadata,
        } as Partial<Stripe.Checkout.Session> : undefined;

        const grossAmount = Math.abs(balanceTransaction.amount ?? 0);
        
        // Validate gross amount before QBO posting
        if (grossAmount === 0) {
          context.log('[StripeTrueUp] Skipping QBO charge posting due to zero gross amount', {
            chargeId: charge.id,
            balanceTransactionAmount: balanceTransaction.amount,
          });
          summary.skipped += 1;
          continue;
        }

        const posting = await dependencies.accounting.postChargeToQbo({
          gross: grossAmount,
          fee: Math.abs(balanceTransaction.fee ?? 0),
          memo: `Stripe charge ${charge.id}`,
          date: timestampToDate(
            balanceTransaction.created ?? balanceTransaction.available_on ?? null
          ),
          stripe: {
            charge: charge as Stripe.Charge,
            paymentIntent: null,
            customer: stripeCustomer,
            checkoutSession: checkoutSessionStub as Stripe.Checkout.Session | undefined,
          },
        });
        summary.qboPosts += 1;

        await markPosted(salesforce, upsertResult, posting);
        await dependencies.idempotencyStore.markProcessed(key);
      }

      summary.processed += 1;
    } catch (error) {
      context.log('[StripeTrueUp] Failed to process payment', {
        chargeId: charge?.id,
        error: error instanceof Error ? error.message : String(error),
      });
      summary.errors += 1;
    }
  }

  return summary;
};

const processRefunds = async (
  context: HttpContext,
  stripe: Stripe,
  from: number,
  to: number | null,
  dryRun: boolean,
  resubmit: boolean
): Promise<ProcessSummary> => {
  const summary: ProcessSummary = {
    fetched: 0,
    processed: 0,
    skipped: 0,
    salesforceUpdates: 0,
    qboPosts: 0,
    errors: 0,
  };

  const params = to
    ? { params: { created: { lte: to } }, logger: context.log }
    : { logger: context.log };

  const refunds = await dependencies.fetchers.refunds(stripe, from, params as never);
  summary.fetched = refunds.length;

  let salesforceSvc: SalesforceSvc | null = null;
  const ensureSalesforce = async (): Promise<SalesforceSvc> => {
    if (!salesforceSvc) {
      salesforceSvc = await dependencies.getSalesforceSvc();
    }
    return salesforceSvc;
  };

  for (const refund of refunds) {
    try {
      // Only process successful refunds
      if (refund.status !== 'succeeded') {
        context.log('[StripeTrueUp] Skipping refund with non-successful status', {
          refundId: refund.id,
          status: refund.status,
        });
        summary.skipped += 1;
        continue;
      }

      const balanceTransaction = await ensureStripeBalanceTransaction(
        stripe,
        refund.balance_transaction as Stripe.BalanceTransaction | string | undefined
      );

      if (!balanceTransaction || !balanceTransaction.id) {
        context.log('[StripeTrueUp] Skipping refund without balance transaction', {
          refundId: refund.id,
        });
        summary.errors += 1;
        continue;
      }

      const key = `bt_${balanceTransaction.id}`;
      
      // Check if already processed
      let shouldSkip = false;
      if (resubmit) {
        // In resubmit mode, check Salesforce for existing transaction
        const salesforce = await ensureSalesforce();
        const existingId = await salesforce.findTransactionIdByExternalId(
          'stripe_refund_id__c',
          refund.id
        );
        if (existingId) {
          context.log('[StripeTrueUp] Skipping refund already in Salesforce', {
            refundId: refund.id,
            salesforceId: existingId,
          });
          shouldSkip = true;
        }
      } else {
        // Normal mode: check idempotency store
        const alreadyProcessed = await dependencies.idempotencyStore.isProcessed(key);
        if (alreadyProcessed) {
          shouldSkip = true;
        }
      }
      
      if (shouldSkip) {
        summary.skipped += 1;
        continue;
      }

      if (!dryRun) {
        const salesforce = await ensureSalesforce();
        const chargeId =
          typeof refund.charge === 'string'
            ? refund.charge
            : (refund.charge as Stripe.Charge | undefined)?.id || null;

        let parentId: string | null = null;
        if (chargeId && typeof salesforce.findTransactionIdByExternalId === 'function') {
          parentId = await salesforce.findTransactionIdByExternalId(
            'stripe_charge_id__c',
            chargeId
          );
        }

        let chargeFragment: Stripe.Charge | null = null;
        if (typeof refund.charge === 'object' && refund.charge) {
          chargeFragment = refund.charge as Stripe.Charge;
        } else if (chargeId) {
          // Retrieve the full charge to get customer info
          try {
            chargeFragment = await stripe.charges.retrieve(chargeId);
          } catch (error) {
            context.log('[StripeTrueUp] Failed to retrieve charge for refund', {
              refundId: refund.id,
              chargeId,
              error: error instanceof Error ? error.message : String(error),
            });
            chargeFragment = { id: chargeId } as unknown as Stripe.Charge;
          }
        }

        // Upsert customer first to get the Contact ID
        // Note: Customer sync for refunds is for Salesforce only
        // QBO refunds are posted as journal entries without customer association
        let contactId: string | null = null;
        if (chargeFragment && chargeFragment.customer) {
          context.log('[StripeTrueUp] Processing refund customer', {
            refundId: refund.id,
            chargeId: chargeFragment.id,
            customerId: extractStripeId(chargeFragment.customer),
          });
          
          const stripeCustomer = await resolveCustomerForCharge(
            stripe,
            chargeFragment,
            (...args: unknown[]) => context.log(...args)
          );
          
          context.log('[StripeTrueUp] Retrieved customer for refund', {
            refundId: refund.id,
            customerId: stripeCustomer?.id,
            customerExists: !!stripeCustomer,
          });
          
          if (stripeCustomer && !stripeCustomer.deleted) {
            try {
              const customerUpsertResult = await salesforce.upsertCustomerByStripeId({
                stripe_customer_id__c: stripeCustomer.id,
                Name: (stripeCustomer as Stripe.Customer).name || (stripeCustomer as Stripe.Customer).email || `Customer ${stripeCustomer.id}`,
                Email: (stripeCustomer as Stripe.Customer).email || null,
              });
              contactId = customerUpsertResult?.id ?? null;
              
              context.log('[StripeTrueUp] Contact upsert completed for refund', {
                refundId: refund.id,
                contactId,
                success: !!contactId,
              });
            } catch (error) {
              context.log('[StripeTrueUp] Failed to upsert contact for refund', {
                refundId: refund.id,
                customerId: stripeCustomer.id,
                error: error instanceof Error ? error.message : String(error),
              });
            }
          }
        } else {
          context.log('[StripeTrueUp] Skipping contact creation for refund', {
            refundId: refund.id,
            reason: !chargeFragment ? 'no charge' : 'no customer on charge',
          });
        }

        const paymentIntentIdRefund = chargeFragment?.payment_intent 
          ? (typeof chargeFragment.payment_intent === 'string' 
            ? chargeFragment.payment_intent 
            : chargeFragment.payment_intent?.id)
          : null;

        const transaction: TransactionUpsertDTO = mapStripeToTransaction({
          paymentIntent: null,
          charge: chargeFragment ?? null,
          balanceTransaction,
        });

        // Generate transaction name
        const config = loadConfig();
        const metadata = chargeFragment?.metadata || {};
        
        context.log('[StripeTrueUp] Refund charge metadata for transaction naming', {
          refundId: refund.id,
          metadata: metadata,
          hasCategory: !!(metadata.category || metadata.Category),
          hasTransactionType: !!(metadata.transactionType || metadata.TransactionType),
          hasPaymentIntent: !!paymentIntentIdRefund,
          paymentIntentId: paymentIntentIdRefund,
        });
        
        // Try to get product name from payment intent first
        let productName: string | null = null;
        if (paymentIntentIdRefund && chargeFragment) {
          try {
            productName = await getProductNameFromCharge(
              stripe,
              chargeFragment,
              (...args: unknown[]) => context.log(...args)
            );
          } catch (error) {
            context.log('[StripeTrueUp] Error getting product name for refund', {
              refundId: refund.id,
              error: error instanceof Error ? error.message : String(error),
              stack: error instanceof Error ? error.stack : undefined,
            });
          }
        }
        
        // Use product name, then metadata, then default
        const category = productName || metadata.category || metadata.Category || config.transaction.defaultCategory;
        const normalizedCategory = normalizeTransactionCategory(category, config);
        
        // Get transaction type from metadata if available, otherwise use derived type
        const metadataTransactionType = metadata.transactionType || metadata.TransactionType;
        const transactionTypeName = metadataTransactionType ||
                                    (transaction.transaction_type__c === 'charge' ? 'Payment' : 
                                     transaction.transaction_type__c === 'refund' ? 'Refund' : 
                                     transaction.transaction_type__c === 'dispute' ? 'Dispute' :
                                     transaction.transaction_type__c === 'payout' ? 'Payout' :
                                     'Transaction');
        
        const transactionName = generateTransactionName(normalizedCategory, config, {
          amount: transaction.amount_gross__c ? `$${Math.abs(transaction.amount_gross__c).toFixed(2)}` : undefined,
          date: new Date().toLocaleDateString(),
          id: refund.id,
          transactionType: transactionTypeName,
        });
        
        context.log('[StripeTrueUp] Generated refund transaction name', {
          refundId: refund.id,
          category,
          normalizedCategory,
          transactionTypeName,
          transactionName,
        });
        
        if (transactionName) {
          transaction.Name = transactionName;
        }

        if (parentId) {
          transaction.parent_transaction__c = parentId;
        }

        if (contactId) {
          transaction.contact__c = contactId;
          context.log('[StripeTrueUp] Associated contact with refund transaction', {
            contactId,
            refundId: refund.id,
          });
        } else {
          context.log('[StripeTrueUp] No contact ID to associate with refund transaction', {
            refundId: refund.id,
          });
        }

        context.log('[StripeTrueUp] Upserting refund transaction to Salesforce', {
          refundId: refund.id,
          contactId: transaction.contact__c,
          hasContact: !!transaction.contact__c,
        });

        // Validate required fields before upserting
        if (!transaction.status__c || !transaction.amount_gross__c) {
          context.log('[StripeTrueUp] Skipping refund transaction upsert due to missing required fields', {
            refundId: refund.id,
            status: transaction.status__c,
            amountGross: transaction.amount_gross__c,
            transaction,
          });
          summary.skipped += 1;
          continue;
        }

        const upsertResult = await salesforce.upsertTransactionByExternalId(
          transaction,
          'stripe_refund_id__c'
        );
        summary.salesforceUpdates += 1;

        const refundAmount = Math.abs(balanceTransaction.amount ?? 0);
        
        // Validate refund amount before QBO posting
        if (refundAmount === 0) {
          context.log('[StripeTrueUp] Skipping QBO refund posting due to zero refund amount', {
            refundId: refund.id,
            balanceTransactionAmount: balanceTransaction.amount,
          });
          summary.skipped += 1;
          continue;
        }

        const posting = await dependencies.accounting.postRefundToQbo({
          amount: refundAmount,
          memo: `Stripe refund ${refund.id}`,
          date: timestampToDate(
            balanceTransaction.created ?? balanceTransaction.available_on ?? null
          ),
        });
        summary.qboPosts += 1;

        await markPosted(salesforce, upsertResult, posting);
        await dependencies.idempotencyStore.markProcessed(key);
      }

      summary.processed += 1;
    } catch (error) {
      context.log('[StripeTrueUp] Failed to process refund', {
        refundId: refund?.id,
        error: error instanceof Error ? error.message : String(error),
      });
      summary.errors += 1;
    }
  }

  return summary;
};

const processPayouts = async (
  context: HttpContext,
  stripe: Stripe,
  from: number,
  to: number | null,
  dryRun: boolean,
  resubmit: boolean
): Promise<ProcessSummary> => {
  const summary: ProcessSummary = {
    fetched: 0,
    processed: 0,
    skipped: 0,
    salesforceUpdates: 0,
    qboPosts: 0,
    errors: 0,
  };

  const params = to
    ? { params: { arrival_date: { lte: to } }, logger: context.log }
    : { logger: context.log };

  const payouts = await dependencies.fetchers.payouts(stripe, from, params as never);
  summary.fetched = payouts.length;

  let salesforceSvc: SalesforceSvc | null = null;
  const ensureSalesforce = async (): Promise<SalesforceSvc> => {
    if (!salesforceSvc) {
      salesforceSvc = await dependencies.getSalesforceSvc();
    }
    return salesforceSvc;
  };

  for (const payout of payouts) {
    try {
      if (!payout || !payout.id) {
        summary.errors += 1;
        continue;
      }

      // Only process successful payouts (paid status)
      if (payout.status !== 'paid') {
        context.log('[StripeTrueUp] Skipping payout with non-paid status', {
          payoutId: payout.id,
          status: payout.status,
        });
        summary.skipped += 1;
        continue;
      }

      const key = `payout_${payout.id}`;
      
      // Check if already processed
      let shouldSkip = false;
      if (resubmit) {
        // In resubmit mode, check if any transactions already have this payout linked
        const salesforce = await ensureSalesforce();
        // Query for any transaction with this payout ID
        try {
          const existingId = await salesforce.findTransactionIdByExternalId(
            'stripe_payout_id__c',
            payout.id
          );
          if (existingId) {
            context.log('[StripeTrueUp] Skipping payout already linked in Salesforce', {
              payoutId: payout.id,
              salesforceId: existingId,
            });
            shouldSkip = true;
          }
        } catch (error) {
          // If query fails, log but continue processing
          context.log('[StripeTrueUp] Failed to check payout in Salesforce, will process', {
            payoutId: payout.id,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      } else {
        // Normal mode: check idempotency store
        const alreadyProcessed = await dependencies.idempotencyStore.isProcessed(key);
        if (alreadyProcessed) {
          shouldSkip = true;
        }
      }
      
      if (shouldSkip) {
        summary.skipped += 1;
        continue;
      }

      if (!dryRun) {
        const salesforce = await ensureSalesforce();
        
        // Fetch balance transactions for automatic payouts
        // Manual payouts don't support balance transaction filtering
        let balanceTransactions: any[] = [];
        if (payout.automatic) {
          try {
            balanceTransactions = await dependencies.fetchers.payoutBalance(stripe, payout.id, {
              logger: context.log,
            });
          } catch (error) {
            context.log('[StripeTrueUp] Could not fetch balance transactions for automatic payout', {
              payoutId: payout.id,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }

        // Build payout transaction for Salesforce
        const transactionName = 'Payout';
        const payoutAmount = Math.abs(payout.amount ?? 0);
        
        const payoutTransaction = {
          Name: transactionName,
          transaction_type__c: 'payout' as const,
          status__c: 'paid' as const,
          stripe_payout_id__c: payout.id,
          stripe_balance_transaction_id__c: payout.balance_transaction || payout.id,
          amount_gross__c: payoutAmount / 100,
          amount_fee__c: 0,
          amount_net__c: payoutAmount / 100,
          currency_iso_code__c: (typeof payout.currency === 'string' ? payout.currency : 'usd').toUpperCase(),
          memo__c: `Stripe Payout ${payout.id} (${payout.automatic ? 'automatic' : 'manual'})`,
          received_at__c: timestampToDate(payout.arrival_date ?? payout.created ?? null).toISOString(),
          posted_to_qbo__c: false,
          qbo_doc_type__c: null,
          qbo_doc_id__c: null,
          qbo_posted_at__c: null,
          posting_error__c: null,
        };

        // Upsert payout transaction in Salesforce
        try {
          // Validate required fields before upserting
          if (!payoutTransaction.status__c || !payoutTransaction.amount_gross__c) {
            context.log('[StripeTrueUp] Skipping payout transaction upsert due to missing required fields', {
              payoutId: payout.id,
              status: payoutTransaction.status__c,
              amountGross: payoutTransaction.amount_gross__c,
              payoutTransaction,
            });
            summary.skipped += 1;
            continue;
          }

          await salesforce.upsertTransactionByExternalId(
            payoutTransaction,
            'stripe_payout_id__c'
          );
          context.log('[StripeTrueUp] Upserted payout transaction in Salesforce', {
            payoutId: payout.id,
            transactionName,
            amount: payoutTransaction.amount_net__c,
          });
        } catch (error) {
          context.log('[StripeTrueUp] Failed to upsert payout transaction in Salesforce', {
            payoutId: payout.id,
            error: error instanceof Error ? error.message : String(error),
          });
        }

        // Link balance transactions if available
        if (balanceTransactions.length > 0 && typeof salesforce.linkPayoutOnTransactions === 'function') {
          const ids = balanceTransactions
            .map((txn) => txn?.id)
            .filter((id): id is string => typeof id === 'string' && id.trim().length > 0);

          if (ids.length > 0) {
            const results = await salesforce.linkPayoutOnTransactions(payout.id, ids);
            summary.salesforceUpdates += results.length;
          }
        }

        // Post to QuickBooks
        const posting = await dependencies.accounting.postPayoutToQbo({
          amount: payoutAmount,
          memo: `Stripe payout ${payout.id}`,
          date: timestampToDate(payout.created ?? payout.arrival_date ?? null),
          payoutId: payout.id, // Include payout ID for duplicate detection
        });
        summary.qboPosts += 1;

        // Mark Salesforce transaction as posted to QBO
        if (posting && posting.qboId) {
          try {
            const payoutTxnId = await salesforce.findTransactionIdByExternalId(
              'stripe_payout_id__c',
              payout.id
            );

            if (payoutTxnId) {
              await salesforce.markPostedToQbo(payoutTxnId, {
                id: posting.qboId,
                type: posting.type || 'bank-deposit',
              });
              context.log('[StripeTrueUp] Marked payout transaction as posted to QBO', {
                payoutId: payout.id,
                salesforceId: payoutTxnId,
                qboDocId: posting.qboId,
              });
            }
          } catch (error) {
            context.log('[StripeTrueUp] Failed to mark payout as posted to QBO in Salesforce', {
              payoutId: payout.id,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }

        await dependencies.idempotencyStore.markProcessed(key);
      }

      summary.processed += 1;
    } catch (error) {
      context.log('[StripeTrueUp] Failed to process payout', {
        payoutId: payout?.id,
        error: error instanceof Error ? error.message : String(error),
      });
      summary.errors += 1;
    }
  }

  return summary;
};

const respond = (status: number, body: Record<string, unknown>) => {
  return {
    status,
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  };
};

const validateEnvironment = (): { valid: boolean; errors: string[] } => {
  const errors: string[] = [];
  const liveMode = process.env.STRIPE_TRUE_UP_MODE === 'live';

  // Check Stripe credentials
  if (liveMode) {
    if (!process.env.STRIPE_LIVE_SECRET_KEY && !env.stripe.secret) {
      errors.push('STRIPE_LIVE_SECRET_KEY is not configured for live mode');
    }
  } else {
    if (!process.env.STRIPE_TEST_SECRET_KEY && !env.stripe.secret) {
      errors.push('STRIPE_TEST_SECRET_KEY is not configured for test mode');
    }
  }

  // Check Salesforce credentials (optional but warn if missing)
  if (!process.env.SALESFORCE_USERNAME && !process.env.SF_USERNAME) {
    errors.push('SALESFORCE_USERNAME or SF_USERNAME is not configured (Salesforce sync will be skipped)');
  }
  if (!process.env.SALESFORCE_PASSWORD && !process.env.SF_PASSWORD) {
    errors.push('SALESFORCE_PASSWORD or SF_PASSWORD is not configured (Salesforce sync will be skipped)');
  }

  // Check QBO credentials (using the actual variable names from env.ts)
  if (!process.env.QBO_CLIENT_ID) {
    errors.push('QBO_CLIENT_ID is not configured (QuickBooks sync will fail)');
  }
  if (!process.env.QBO_CLIENT_SECRET) {
    errors.push('QBO_CLIENT_SECRET is not configured (QuickBooks sync will fail)');
  }
  if (!process.env.QBO_REALM_ID && !process.env.QBO_COMPANY_ID) {
    errors.push('QBO_REALM_ID or QBO_COMPANY_ID is not configured (QuickBooks sync will fail)');
  }

  return { valid: errors.length === 0, errors };
};

const stripeTrueUp = async (req: HttpRequest, context: InvocationContext): Promise<any> => {
  try {
    // Validate environment first
    const envCheck = validateEnvironment();
    if (!envCheck.valid) {
      context.log('[StripeTrueUp] Environment validation failed:', envCheck.errors);
      return respond(500, {
        error: 'configuration_error',
        message: 'Required environment variables are not configured.',
        details: envCheck.errors,
      });
    }

    const queryRaw = (req as unknown as { query?: unknown }).query;
  let query: Record<string, string | undefined> = {};

  if (queryRaw instanceof URLSearchParams) {
    query = Object.fromEntries(queryRaw.entries());
  } else if (queryRaw && typeof queryRaw === 'object') {
    query = queryRaw as Record<string, string | undefined>;
  }
  const fromParam = query.from;
  if (!fromParam) {
    return respond(400, {
      error: 'bad_request',
      message: 'Query parameter "from" is required.',
    });
    return;
  }

  let from: number;
  try {
    from = toEpochSeconds(fromParam);
  } catch (error) {
    return respond(400, {
      error: 'bad_request',
      message: error instanceof Error ? error.message : String(error),
    });
    return;
  }

  let to: number | null = null;
  if (query.to) {
    try {
      to = toEpochSeconds(query.to);
    } catch (error) {
      return respond(400, {
        error: 'bad_request',
        message: error instanceof Error ? error.message : String(error),
      });
      return;
    }

    if (to < from) {
      return respond(400, {
        error: 'bad_request',
        message: 'The "to" parameter must be greater than or equal to "from".',
      });
      return;
    }
  }

  const type = (query.type || 'payments').toLowerCase();
  if (!['payments', 'refunds', 'payouts'].includes(type)) {
    return respond(400, {
      error: 'bad_request',
      message: 'Query parameter "type" must be one of payments, refunds, or payouts.',
    });
    return;
  }

  const dryRun = parseBoolean(query.dryRun, false);
  const resubmit = parseBoolean(query.resubmit, false);
  const liveMode = process.env.STRIPE_TRUE_UP_MODE === 'live';

    const stripe = dependencies.stripe.getClient(liveMode);

    let summary: ProcessSummary;
    if (type === 'payments') {
      summary = await processPayments(context, stripe, from, to, dryRun, resubmit);
    } else if (type === 'refunds') {
      summary = await processRefunds(context, stripe, from, to, dryRun, resubmit);
    } else {
      summary = await processPayouts(context, stripe, from, to, dryRun, resubmit);
    }

    // Flush idempotency store to ensure all processed keys are persisted
    if (!dryRun) {
      await dependencies.idempotencyStore.flush();
      context.log('[StripeTrueUp] Idempotency store flushed successfully');
    }

    return respond(200, {
      type,
      dryRun,
      resubmit,
      liveMode,
      range: {
        from: timestampToIsoString(from),
        to: to ? timestampToIsoString(to) : null,
      },
      counts: summary,
    });
  } catch (error) {
    context.log('[StripeTrueUp] Unhandled error', {
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    return respond(500, {
      error: 'internal_error',
      message: 'Failed to complete Stripe true-up operation.',
      details: error instanceof Error ? error.message : String(error),
    });
  }
};

type HandlerWithInternals = typeof stripeTrueUp & {
  __internals?: {
    setDependencies: (overrides?: DependencyOverrides) => void;
    resetDependencies: () => void;
  };
};

const handlerWithInternals = stripeTrueUp as HandlerWithInternals;
handlerWithInternals.__internals = {
  setDependencies,
  resetDependencies,
};

export default handlerWithInternals;
