import type { InvocationContext, HttpRequest } from '@azure/functions';
import Stripe from 'stripe';

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

import type { PostChargeToQboResult } from '../services/qboSvc';

import { AzureIdempotencyStore, type IdempotencyStore } from '../services/idempotencyStore';
import {
  createSalesforceSvc,
  type SalesforceSvc,
  type QuickBooksDocumentReference,
} from '../services/salesforceSvc';

const STRIPE_TRANSACTION_RECORD_TYPE_NAME = 'Stripe Transaction';
import { SalesforceService, buildSalesforceConfig } from '../services/salesforceService';
import { mapStripeToTransaction, type TransactionUpsertDTO } from '../domain/transactions';
import { ensureSalesforceIdOnCustomer } from '../stripe/utils';
import { loadConfig, normalizeTransactionCategory } from '../config/contactMatching';
import {
  fetchStripeChargesSince,
  fetchStripeRefundsSince,
  fetchStripePayoutsSince,
  fetchBalanceTransactionsForPayout,
  normalizeSince,
} from '../services/qbo/stripe/fetchStripe';

const STRIPE_API_VERSION: Stripe.LatestApiVersion = '2023-10-16';

const getDefaultStripeSecret = (): string => process.env.STRIPE_SECRET || '';

interface StripeServices {
  getClient: (livemode: boolean) => Stripe;
}

interface FetchServices {
  payments: typeof fetchStripeChargesSince;
  refunds: typeof fetchStripeRefundsSince;
  payouts: typeof fetchStripePayoutsSince;
  payoutBalance: typeof fetchBalanceTransactionsForPayout;
}

let qboFunctions: any = null;
const createNoopAccountingServices = (): AccountingServices => ({
  postChargeToQbo: async () => ({ success: false, error: 'QBO service not available' }) as any,
  postRefundToQbo: async () => ({ success: false, error: 'QBO service not available' }),
  postPayoutToQbo: async () => ({ success: false, error: 'QBO service not available' }),
});

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
      qboFunctions = createNoopAccountingServices();
    }
  }
  return qboFunctions;
};

const createAccountingServices = (): AccountingServices => ({
  postChargeToQbo: async (charge: any, options?: any) =>
    getQboFunctions().postChargeToQbo(charge, options),
  postRefundToQbo: async (refund: any, options?: any) =>
    getQboFunctions().postRefundToQbo(refund, options),
  postPayoutToQbo: async (payout: any, balanceTransactions?: any[], options?: any) =>
    getQboFunctions().postPayoutToQbo(payout, balanceTransactions, options),
});

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

interface TrueUpRequestOptions {
  bypassQbo: boolean;
  liveMode: boolean;
  from: number;
  to: number | null;
  type: 'payments' | 'refunds' | 'payouts';
  dryRun: boolean;
  resubmit: boolean;
  limit: number | null;
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

type ParsedRequestOptions =
  | { ok: true; value: TrueUpRequestOptions }
  | { ok: false; response: ReturnType<typeof respond> };

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
      return;
    },
  };
};

const buildProcessSummary = (): ProcessSummary => ({
  fetched: 0,
  processed: 0,
  skipped: 0,
  salesforceUpdates: 0,
  qboPosts: 0,
  errors: 0,
});

const createLazySalesforceGetter = () => {
  let salesforceSvc: SalesforceSvc | null = null;

  return async (): Promise<SalesforceSvc> => {
    if (!salesforceSvc) {
      salesforceSvc = await dependencies.getSalesforceSvc();
    }
    return salesforceSvc;
  };
};

const buildFetchParams = (
  upperBoundField: 'created' | 'arrival_date',
  to: number | null,
  logger: HttpContext['log']
) => (to ? { params: { [upperBoundField]: { lte: to } }, logger } : { logger });

const createStripeServices = (): StripeServices => {
  const cache = new Map<boolean, Stripe>();

  const getClient = (livemode: boolean): Stripe => {
    if (cache.has(livemode)) {
      return cache.get(livemode)!;
    }

    const secret = livemode
      ? process.env.STRIPE_LIVE_SECRET_KEY || getDefaultStripeSecret()
      : process.env.STRIPE_TEST_SECRET_KEY || getDefaultStripeSecret();

    const client = new Stripe(secret, {
      apiVersion: STRIPE_API_VERSION,
    });
    cache.set(livemode, client);
    return client;
  };

  return { getClient };
};

const createFetchServices = (): FetchServices => ({
  payments: fetchStripeChargesSince,
  refunds: fetchStripeRefundsSince,
  payouts: fetchStripePayoutsSince,
  payoutBalance: fetchBalanceTransactionsForPayout,
});

const createIdempotencyStore = (): IdempotencyStore =>
  process.env.DISABLE_AZURE_TABLES === '1' ? createInMemoryStore() : new AzureIdempotencyStore();

let defaultSalesforceSvcPromise: Promise<SalesforceSvc> | null = null;
let salesforceConnection: any = null;

export const __setSalesforceConnection = (conn: any) => {
  salesforceConnection = conn;
};

const createSalesforceGetter = (): (() => Promise<SalesforceSvc>) => {
  return async (): Promise<SalesforceSvc> => {
    if (!defaultSalesforceSvcPromise) {
      defaultSalesforceSvcPromise = (async () => {
        const service = new SalesforceService(buildSalesforceConfig());
        salesforceConnection = await service.authenticate();
        return createSalesforceSvc({ connection: salesforceConnection });
      })();
    }

    return defaultSalesforceSvcPromise;
  };
};

let defaultCrmSvcPromise: Promise<any> | null = null;
type CrmService = {
  findOrCreateCampaign: (name: string) => Promise<string>;
  authenticate?: () => Promise<void>;
  searchContact?: (input: { stripeCustomerId: string }) => Promise<Array<{ Id: string }>>;
  addCampaignMember?: (...args: any[]) => Promise<any>;
};

const createDisabledCrmService = (): CrmService => ({
  async findOrCreateCampaign(name: string): Promise<string> {
    return `701000000000000_${name}`;
  },
});

const createCrmGetter = (): (() => Promise<CrmService>) => {
  const disabledCrmService = createDisabledCrmService();

  return async (): Promise<CrmService> => {
    if (!defaultCrmSvcPromise) {
      defaultCrmSvcPromise = (async () => {
        try {
          const CrmFactory = require('../services/salesforce/crmFactory');
          const crmConfig = buildSalesforceConfig();

          const validation = CrmFactory.validateConfig('salesforce', crmConfig);
          if (!validation.isValid) {
            throw new Error(`Invalid CRM configuration: ${validation.error}`);
          }

          const crmService = CrmFactory.createCrmService('salesforce', crmConfig);
          if (typeof crmService.authenticate === 'function') {
            await crmService.authenticate();
          }
          return crmService;
        } catch (error) {
          defaultCrmSvcPromise = null;
          const message =
            error instanceof Error ? error.message : 'Unknown CRM initialization error';
          console.error('[StripeTrueUp] CRM initialization failed:', message);
          return disabledCrmService;
        }
      })();
    }

    return defaultCrmSvcPromise;
  };
};

const getCrmSvc = createCrmGetter();

const createDefaultDependencies = (): Dependencies => ({
  stripe: createStripeServices(),
  fetchers: createFetchServices(),
  idempotencyStore: createIdempotencyStore(),
  getSalesforceSvc: createSalesforceGetter(),
  accounting: createAccountingServices(),
});

let dependencies: Dependencies = createDefaultDependencies();

const mergeDependencies = (
  base: Dependencies,
  overrides: DependencyOverrides = {}
): Dependencies => ({
  stripe: overrides.stripe ? { ...base.stripe, ...overrides.stripe } : base.stripe,
  fetchers: overrides.fetchers ? { ...base.fetchers, ...overrides.fetchers } : base.fetchers,
  idempotencyStore: overrides.idempotencyStore ?? base.idempotencyStore,
  getSalesforceSvc: overrides.getSalesforceSvc ?? base.getSalesforceSvc,
  accounting: overrides.accounting
    ? { ...base.accounting, ...overrides.accounting }
    : base.accounting,
});

const setDependencies = (overrides: DependencyOverrides = {}): void => {
  dependencies = mergeDependencies(dependencies, overrides);
};

const resetDependencies = (): void => {
  defaultSalesforceSvcPromise = null;
  defaultCrmSvcPromise = null;
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

const parseModeToggle = (
  value: unknown
): { isValid: boolean; isLiveMode?: boolean; message?: string } => {
  if (value === undefined || value === null || value === '') {
    return { isValid: true };
  }

  if (typeof value !== 'string') {
    return { isValid: false, message: 'Mode must be a string value: test or live.' };
  }

  const normalized = value.trim().toLowerCase();
  if (normalized === 'live') {
    return { isValid: true, isLiveMode: true };
  }

  if (normalized === 'test' || normalized === 'sandbox') {
    return { isValid: true, isLiveMode: false };
  }

  return { isValid: false, message: 'Query parameter "mode" must be either "test" or "live".' };
};

const toTrimmedString = (value: unknown): string | null => {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

const extractSalesforceIdFromMetadata = (
  metadata: Record<string, unknown> | null | undefined
): string | null => {
  if (!metadata || typeof metadata !== 'object') {
    return null;
  }

  return (
    toTrimmedString(metadata.salesforce_id) ||
    toTrimmedString(metadata.salesforceId) ||
    toTrimmedString(metadata.SalesforceId)
  );
};

type ResolvedSalesforceReference =
  | { target: 'Contact'; id: string }
  | { target: 'Account'; id: string };

const resolveSalesforceReferenceFromMetadata = async (
  salesforce: SalesforceSvc,
  metadata: Record<string, unknown> | null | undefined,
  contextLog: (...args: unknown[]) => void,
  sourceId: string,
  sourceType: 'charge' | 'refund',
  metadataSource: 'customer' | 'charge' = 'charge'
): Promise<ResolvedSalesforceReference | null> => {
  const metadataSalesforceId = extractSalesforceIdFromMetadata(metadata);
  if (!metadataSalesforceId) {
    return null;
  }

  try {
    if (typeof salesforce.findContactIdById === 'function') {
      const validatedContactId = await salesforce.findContactIdById(metadataSalesforceId);
      if (validatedContactId) {
        contextLog('[StripeTrueUp] Resolved contact from Stripe metadata salesforce_id', {
          sourceType,
          sourceId,
          metadataSource,
          contactId: validatedContactId,
          metadataSalesforceId,
          matchPath: 'stripe_salesforce_id',
        });
        return { target: 'Contact', id: validatedContactId };
      }

      contextLog('[StripeTrueUp] Stripe metadata salesforce_id did not match a Contact', {
        sourceType,
        sourceId,
        metadataSource,
        metadataSalesforceId,
      });
    }

    if (typeof salesforce.findAccountIdById === 'function') {
      const validatedAccountId = await salesforce.findAccountIdById(metadataSalesforceId);
      if (validatedAccountId) {
        contextLog('[StripeTrueUp] Resolved account from Stripe metadata salesforce_id', {
          sourceType,
          sourceId,
          metadataSource,
          accountId: validatedAccountId,
          metadataSalesforceId,
          matchPath: 'stripe_salesforce_id',
        });
        return { target: 'Account', id: validatedAccountId };
      }

      contextLog('[StripeTrueUp] Stripe metadata salesforce_id did not match an Account', {
        sourceType,
        sourceId,
        metadataSource,
        metadataSalesforceId,
      });
    }
  } catch (error) {
    contextLog(
      '[StripeTrueUp] Failed to resolve Salesforce record from Stripe metadata salesforce_id',
      {
        sourceType,
        sourceId,
        metadataSource,
        metadataSalesforceId,
        error: error instanceof Error ? error.message : String(error),
      }
    );
  }

  return null;
};

const toEpochSeconds = (value: unknown): number => {
  try {
    return normalizeSince(value as never);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid date parameter: ${message}`);
  }
};

const parseLimit = (value: unknown): number | null => {
  if (value === undefined || value === null || value === '') {
    return null;
  }

  if (typeof value === 'number') {
    if (!Number.isInteger(value) || value <= 0) {
      throw new Error('Query parameter "limit" must be a positive integer.');
    }
    return value;
  }

  if (typeof value === 'string') {
    const normalized = value.trim();
    if (!/^\d+$/.test(normalized)) {
      throw new Error('Query parameter "limit" must be a positive integer.');
    }

    const parsed = Number.parseInt(normalized, 10);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      throw new Error('Query parameter "limit" must be a positive integer.');
    }
    return parsed;
  }

  throw new Error('Query parameter "limit" must be a positive integer.');
};

const skipUpsertWhenRequiredFieldsMissing = (
  context: HttpContext,
  summary: ProcessSummary,
  options: {
    message: string;
    idKey: string;
    idValue: string;
    transaction: { status__c?: unknown; amount_gross__c?: unknown };
  }
): boolean => {
  if (options.transaction.status__c && options.transaction.amount_gross__c) {
    return false;
  }

  context.log(options.message, {
    [options.idKey]: options.idValue,
    status: options.transaction.status__c,
    amountGross: options.transaction.amount_gross__c,
    transaction: options.transaction,
  });

  summary.skipped += 1;
  return true;
};

const shouldSkipForResubmitOrIdempotency = async (options: {
  resubmit: boolean;
  idempotencyKey: string;
  checkResubmit: () => Promise<boolean>;
}): Promise<boolean> => {
  if (options.resubmit) {
    return options.checkResubmit();
  }

  return dependencies.idempotencyStore.isProcessed(options.idempotencyKey);
};

const resolveContactIdForCampaignMembership = async (
  context: HttpContext,
  crm: CrmService,
  stripeCustomerId: string
): Promise<string | null> => {
  if (typeof crm.searchContact !== 'function') {
    return null;
  }

  try {
    context.log('[StripeTrueUp] Resolving contact from Stripe customer ID', {
      stripeCustomerId,
    });

    const contacts = await crm.searchContact({ stripeCustomerId });
    if (Array.isArray(contacts) && contacts.length > 0) {
      const contactId = contacts[0].Id;
      context.log('[StripeTrueUp] Resolved contact from Stripe customer ID', {
        stripeCustomerId,
        contactId,
      });
      return contactId;
    }

    context.log('[StripeTrueUp] No contact found for Stripe customer ID', {
      stripeCustomerId,
    });
    return null;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    context.log('[StripeTrueUp] Failed to resolve contact from Stripe customer ID', {
      stripeCustomerId,
      error: message,
    });
    return null;
  }
};

const addCampaignMembership = async (
  context: HttpContext,
  crm: CrmService,
  campaignId: string,
  contactId: string
): Promise<void> => {
  if (typeof crm.addCampaignMember !== 'function') {
    return;
  }

  try {
    context.log('[StripeTrueUp] Adding contact as campaign member', {
      campaignId,
      contactId,
    });

    const membershipResult =
      crm.addCampaignMember.length >= 2
        ? await crm.addCampaignMember(campaignId, contactId)
        : await crm.addCampaignMember({ campaignId, contactId });
    if (membershipResult?.isNew) {
      context.log('[StripeTrueUp] Contact added as new campaign member', {
        campaignId,
        contactId,
        campaignMemberId: membershipResult.id,
      });
      return;
    }

    context.log('[StripeTrueUp] Contact is already a campaign member', {
      campaignId,
      contactId,
      campaignMemberId: membershipResult?.id,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    context.log('[StripeTrueUp] Failed to add contact as campaign member', {
      campaignId,
      contactId,
      error: message,
    });
  }
};

const applyCampaignFromCategory = async (
  context: HttpContext,
  transaction: TransactionUpsertDTO,
  categoryName: string,
  chargeId: string
): Promise<void> => {
  if (transaction.campaign__c) {
    return;
  }

  try {
    context.log('[StripeTrueUp] Associating category with campaign', {
      category: categoryName,
      chargeId,
    });

    const crm = await getCrmSvc();
    const campaignId = await crm.findOrCreateCampaign(categoryName);
    if (!campaignId || typeof campaignId !== 'string' || campaignId.trim().length === 0) {
      return;
    }

    transaction.campaign__c = campaignId;
    context.log('[StripeTrueUp] Category associated with campaign', {
      category: categoryName,
      campaignId,
      chargeId,
    });

    let campaignContactId = transaction.contact__c;
    if (!campaignContactId && transaction.stripe_customer_id__c) {
      campaignContactId = await resolveContactIdForCampaignMembership(
        context,
        crm,
        transaction.stripe_customer_id__c
      );
    }

    if (campaignContactId && campaignContactId.trim().length > 0) {
      await addCampaignMembership(context, crm, campaignId, campaignContactId);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    context.log(
      '[StripeTrueUp] Failed to associate category with campaign; continuing without campaign',
      { category: categoryName, error: message, chargeId }
    );
  }
};

const isLikelySalesforceId = (value: string | null | undefined): boolean =>
  typeof value === 'string' && /^[A-Za-z0-9]{15}(?:[A-Za-z0-9]{3})?$/.test(value.trim());

const normalizeCampaignReference = async (
  context: HttpContext,
  transaction: TransactionUpsertDTO,
  chargeId: string
): Promise<void> => {
  if (!transaction.campaign__c || isLikelySalesforceId(transaction.campaign__c)) {
    return;
  }

  const campaignName = transaction.campaign__c;
  delete transaction.campaign__c;

  await applyCampaignFromCategory(context, transaction, campaignName, chargeId);
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

type SalesforceContactRecord = {
  Id: string;
  FirstName?: string | null;
  LastName?: string | null;
  Email?: string | null;
  Stripe_Customer_Id__c?: string | null;
};

const escapeSoqlString = (value: string): string => value.replace(/'/g, "\\'");

const buildContactIdentity = (
  stripeCustomer: Stripe.Customer,
  transactionName: string | null
): {
  customerName: string;
  firstName: string | null;
  lastName: string;
} => {
  const fallbackName = transactionName || stripeCustomer.name || stripeCustomer.email;
  const customerName = fallbackName || `Customer ${stripeCustomer.id}`;

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

  return {
    customerName,
    firstName,
    lastName: lastName || customerName,
  };
};

const buildContactSearchConditions = (
  stripeCustomer: Stripe.Customer,
  firstName: string | null,
  lastName: string
): string[] => {
  const whereConditions: string[] = [];

  if (stripeCustomer.id) {
    whereConditions.push(`Stripe_Customer_Id__c = '${escapeSoqlString(stripeCustomer.id)}'`);
  }

  if (stripeCustomer.email) {
    whereConditions.push(`Email = '${escapeSoqlString(stripeCustomer.email)}'`);
  }

  if (firstName && lastName) {
    whereConditions.push(
      `(FirstName = '${escapeSoqlString(firstName)}' AND LastName = '${escapeSoqlString(lastName)}')`
    );
  }

  return whereConditions;
};

const selectBestMatchingContact = (
  candidates: SalesforceContactRecord[],
  stripeCustomer: Stripe.Customer,
  firstName: string | null,
  lastName: string
): SalesforceContactRecord | null => {
  if (!Array.isArray(candidates) || candidates.length === 0) {
    return null;
  }

  const stripeIdMatch = candidates.find(
    (contact) => contact.Stripe_Customer_Id__c === stripeCustomer.id
  );
  if (stripeIdMatch) {
    return stripeIdMatch;
  }

  if (firstName && lastName) {
    const nameMatch = candidates.find((contact) => {
      const firstMatches =
        typeof contact.FirstName === 'string' &&
        contact.FirstName.toLowerCase() === firstName.toLowerCase();
      const lastMatches =
        typeof contact.LastName === 'string' &&
        contact.LastName.toLowerCase() === lastName.toLowerCase();
      return firstMatches && lastMatches;
    });

    if (nameMatch) {
      return nameMatch;
    }
  }

  return candidates[0] ?? null;
};

const buildContactUpdateFields = (
  existingContact: SalesforceContactRecord,
  stripeCustomer: Stripe.Customer,
  firstName: string | null,
  lastName: string
): Record<string, unknown> => {
  const updateFields: Record<string, unknown> = { Id: existingContact.Id };

  if (!existingContact.Stripe_Customer_Id__c && stripeCustomer.id) {
    updateFields.Stripe_Customer_Id__c = stripeCustomer.id;
  }

  if (stripeCustomer.email && stripeCustomer.email !== existingContact.Email) {
    updateFields.Email = stripeCustomer.email;
  }

  if (firstName && firstName !== existingContact.FirstName) {
    updateFields.FirstName = firstName;
  }

  if (lastName && lastName !== existingContact.LastName) {
    updateFields.LastName = lastName;
  }

  return updateFields;
};

const ensureContactRecordTypeId = async (
  connection: any,
  currentRecordTypeId: string | undefined,
  contextLog: typeof console.log
): Promise<string | undefined> => {
  if (currentRecordTypeId) {
    return currentRecordTypeId;
  }

  try {
    const queryResult: any = await connection.query(
      "SELECT Id FROM RecordType WHERE SObjectType = 'Contact' AND Name = 'Contact' LIMIT 1"
    );
    const records = Array.isArray(queryResult?.records) ? queryResult.records : [];
    if (records.length > 0 && records[0].Id) {
      return records[0].Id;
    }
  } catch (error) {
    contextLog('[StripeTrueUp] Failed to lookup Contact record type id', {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  return undefined;
};

const findOrCreateContactInSalesforce = async (
  salesforceSvc: SalesforceSvc,
  customer: Stripe.Customer | Stripe.DeletedCustomer | null,
  transactionName: string | null,
  contextLog: typeof console.log
): Promise<{ id: string } | null> => {
  let cachedContactRecordTypeId: string | undefined;
  if (!customer || customer.deleted) {
    return null;
  }

  const stripeCustomer = customer as Stripe.Customer;
  const { customerName, firstName, lastName } = buildContactIdentity(
    stripeCustomer,
    transactionName
  );

  contextLog('[StripeTrueUp] Starting contact find/create process', {
    customerId: stripeCustomer.id,
    customerName,
    firstName,
    lastName,
    email: stripeCustomer.email,
  });

  try {
    const connection = salesforceConnection || (await createSalesforceConnection());

    if (!connection) {
      contextLog('[StripeTrueUp] No Salesforce connection available');
      return null;
    }

    contextLog('[StripeTrueUp] Salesforce connection established');

    const whereConditions = buildContactSearchConditions(stripeCustomer, firstName, lastName);
    let existingContact: SalesforceContactRecord | null = null;

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
      const records = Array.isArray(result?.records)
        ? (result.records as SalesforceContactRecord[])
        : [];

      contextLog('[StripeTrueUp] SOQL query completed', {
        recordCount: records.length,
      });

      if (records.length > 0) {
        existingContact = selectBestMatchingContact(records, stripeCustomer, firstName, lastName);

        if (existingContact?.Stripe_Customer_Id__c === stripeCustomer.id) {
          contextLog('[StripeTrueUp] Found contact by Stripe Customer ID', {
            contactId: existingContact?.Id,
            stripeCustomerId: stripeCustomer.id,
          });
        } else if (
          existingContact?.FirstName &&
          existingContact?.LastName &&
          firstName &&
          existingContact.FirstName.toLowerCase() === firstName.toLowerCase() &&
          existingContact.LastName.toLowerCase() === lastName.toLowerCase()
        ) {
          contextLog('[StripeTrueUp] Found contact by name match', {
            contactId: existingContact.Id,
            firstName,
            lastName,
          });
        } else if (existingContact) {
          contextLog('[StripeTrueUp] Found contact by email', {
            contactId: existingContact.Id,
            email: stripeCustomer.email,
          });
        }
      }
    } else {
      contextLog('[StripeTrueUp] No search conditions available, will create new contact');
    }

    if (existingContact) {
      const updateFields = buildContactUpdateFields(
        existingContact,
        stripeCustomer,
        firstName,
        lastName
      );

      if (!existingContact.Stripe_Customer_Id__c && stripeCustomer.id) {
        contextLog('[StripeTrueUp] Adding Stripe Customer ID to existing contact', {
          contactId: existingContact.Id,
          stripeCustomerId: stripeCustomer.id,
        });
      }

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
            updatedFields: Object.keys(updateFields).filter((k) => k !== 'Id'),
          });
        }
      }

      return { id: existingContact.Id };
    }

    const contactRecord: Record<string, any> = {
      FirstName: firstName,
      LastName: lastName,
      Email: stripeCustomer.email || null,
      Stripe_Customer_Id__c: stripeCustomer.id,
    };

    cachedContactRecordTypeId = await ensureContactRecordTypeId(
      connection,
      cachedContactRecordTypeId,
      contextLog
    );

    if (cachedContactRecordTypeId) {
      contactRecord.RecordTypeId = cachedContactRecordTypeId;
    }

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
  } catch (error) {
    contextLog('[StripeTrueUp] Failed to find/create contact in Salesforce', {
      customerId: stripeCustomer.id,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
};

const createSalesforceConnection = async (): Promise<any> => {
  const service = new SalesforceService(buildSalesforceConfig());
  return service.authenticate();
};

const processPayments = async (
  context: HttpContext,
  stripe: Stripe,
  from: number,
  to: number | null,
  dryRun: boolean,
  resubmit: boolean,
  bypassQbo: boolean,
  limit: number | null
): Promise<ProcessSummary> => {
  const summary = buildProcessSummary();
  const params = buildFetchParams('created', to, context.log);

  const charges = await dependencies.fetchers.payments(stripe, from, params as never);
  const recordsToProcess = typeof limit === 'number' ? charges.slice(0, limit) : charges;
  summary.fetched = recordsToProcess.length;

  const ensureSalesforce = createLazySalesforceGetter();

  for (const charge of recordsToProcess) {
    try {
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

      let existingTransactionId: string | null = null;
      const shouldSkip = await shouldSkipForResubmitOrIdempotency({
        resubmit,
        idempotencyKey: key,
        checkResubmit: async () => {
          const salesforce = await ensureSalesforce();
          if (typeof salesforce.findTransactionRecordByExternalId === 'function') {
            const existingRecord = await salesforce.findTransactionRecordByExternalId(
              'stripe_charge_id__c',
              charge.id,
              STRIPE_TRANSACTION_RECORD_TYPE_NAME
            );

            if (existingRecord?.id) {
              existingTransactionId = existingRecord.id;

              if (existingRecord.contactId && existingRecord.postedToQbo === true) {
                context.log(
                  '[StripeTrueUp] Skipping charge already in Salesforce and posted to QBO',
                  {
                    chargeId: charge.id,
                    salesforceId: existingRecord.id,
                    contactId: existingRecord.contactId,
                  }
                );
                return true;
              }

              if (existingRecord.contactId && existingRecord.postedToQbo !== true) {
                context.log(
                  '[StripeTrueUp] Existing Salesforce transaction has contact but QBO posting incomplete; retrying QBO post',
                  {
                    chargeId: charge.id,
                    salesforceId: existingRecord.id,
                    postedToQbo: existingRecord.postedToQbo,
                  }
                );
                return false;
              }

              context.log(
                '[StripeTrueUp] Existing Salesforce transaction has no contact; attempting reassociation',
                {
                  chargeId: charge.id,
                  salesforceId: existingRecord.id,
                }
              );
            }

            return false;
          }

          const existingId = await salesforce.findTransactionIdByExternalId(
            'stripe_charge_id__c',
            charge.id,
            STRIPE_TRANSACTION_RECORD_TYPE_NAME
          );
          if (existingId) {
            context.log('[StripeTrueUp] Skipping charge already in Salesforce', {
              chargeId: charge.id,
              salesforceId: existingId,
            });
            return true;
          }

          return false;
        },
      });

      if (shouldSkip) {
        summary.skipped += 1;
        continue;
      }

      if (!dryRun) {
        const salesforce = await ensureSalesforce();
        const chargeObj = charge as Stripe.Charge;
        const chargeObjectMetadata = chargeObj.metadata as Record<string, unknown> | undefined;

        const stripeCustomer = await resolveCustomerForCharge(
          stripe,
          charge as Stripe.Charge,
          (...args: unknown[]) => context.log(...args)
        );

        const customerMetadata =
          stripeCustomer && !stripeCustomer.deleted
            ? ((stripeCustomer as Stripe.Customer).metadata as Record<string, unknown>) || undefined
            : undefined;
        const customerMetadataSalesforceId = extractSalesforceIdFromMetadata(customerMetadata);
        const chargeMetadataSalesforceId = extractSalesforceIdFromMetadata(chargeObjectMetadata);

        const metadataSource: 'customer' | 'charge' | null = customerMetadataSalesforceId
          ? 'customer'
          : chargeMetadataSalesforceId
            ? 'charge'
            : null;
        const selectedMetadata =
          metadataSource === 'customer'
            ? customerMetadata
            : metadataSource === 'charge'
              ? chargeObjectMetadata
              : undefined;
        const metadataSalesforceId =
          metadataSource === 'customer'
            ? customerMetadataSalesforceId
            : metadataSource === 'charge'
              ? chargeMetadataSalesforceId
              : null;

        context.log('[StripeTrueUp] Retrieved customer from Stripe', {
          chargeId: charge.id,
          customerId: stripeCustomer?.id,
          customerExists: !!stripeCustomer,
          customerDeleted: stripeCustomer?.deleted,
          metadataSalesforceId,
          metadataSource,
        });

        let contactId: string | null = null;
        let accountId: string | null = null;
        if (metadataSalesforceId && selectedMetadata) {
          const resolvedReference = await resolveSalesforceReferenceFromMetadata(
            salesforce,
            selectedMetadata,
            (...args: unknown[]) => context.log(...args),
            charge.id,
            'charge',
            metadataSource || 'charge'
          );

          if (resolvedReference?.target === 'Contact') {
            contactId = resolvedReference.id;
          } else if (resolvedReference?.target === 'Account') {
            accountId = resolvedReference.id;
          }

          if (!resolvedReference) {
            context.log(
              '[StripeTrueUp] Stripe metadata salesforce_id provided but could not be resolved; skipping Salesforce creation fallback',
              {
                chargeId: charge.id,
                metadataSalesforceId,
                metadataSource,
              }
            );
          }
        } else if (stripeCustomer && !stripeCustomer.deleted) {
          context.log('[StripeTrueUp] Falling back to existing Stripe customer matching flow', {
            chargeId: charge.id,
            customerId: stripeCustomer.id,
            matchPath: 'fallback_match',
          });
          context.log('[StripeTrueUp] Calling upsertCustomerByStripeId', {
            customerId: stripeCustomer.id,
            customerName: (stripeCustomer as Stripe.Customer).name,
            customerEmail: (stripeCustomer as Stripe.Customer).email,
          });

          try {
            const customerUpsertResult = await salesforce.upsertCustomerByStripeId({
              stripe_customer_id__c: stripeCustomer.id,
              Name:
                (stripeCustomer as Stripe.Customer).name ||
                (stripeCustomer as Stripe.Customer).email ||
                `Customer ${stripeCustomer.id}`,
              Email: (stripeCustomer as Stripe.Customer).email || null,
            });
            contactId = customerUpsertResult?.id ?? null;

            context.log('[StripeTrueUp] Contact upsert completed', {
              contactId,
              success: !!contactId,
              matchPath:
                customerUpsertResult?.created === true
                  ? 'created_new_salesforce_record'
                  : 'fallback_match',
            });

            if (stripeCustomer && contactId) {
              await ensureSalesforceIdOnCustomer(
                stripe,
                stripeCustomer.id,
                contactId,
                (...args: unknown[]) => context.log(...args)
              );
            }
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

        const paymentIntentId =
          typeof chargeObj.payment_intent === 'string'
            ? chargeObj.payment_intent
            : chargeObj.payment_intent?.id;

        const transaction = mapStripeToTransaction({
          paymentIntent: null,
          charge: chargeObj,
          balanceTransaction,
          stripeCustomer,
        });

        await normalizeCampaignReference(context, transaction, charge.id);

        if (!transaction.frequency__c && chargeObj.invoice) {
          try {
            const invoice = await stripe.invoices.retrieve(chargeObj.invoice as string);
            if (invoice.subscription) {
              const subscriptionId =
                typeof invoice.subscription === 'string'
                  ? invoice.subscription
                  : invoice.subscription.id;

              if (subscriptionId) {
                const frequency = await getFrequencyFromSubscription(
                  stripe,
                  subscriptionId,
                  (...args: unknown[]) => context.log(...args)
                );
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
            const message =
              error instanceof Error
                ? error.message
                : 'Unknown error getting frequency from subscription';
            context.log('[StripeTrueUp] Failed to get frequency from subscription for charge', {
              chargeId: charge.id,
              invoiceId: chargeObj.invoice,
              error: message,
            });
          }
        }

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

        let productName: string | null = null;
        if (paymentIntentId) {
          try {
            productName = await getProductNameFromCharge(stripe, chargeObj, (...args: unknown[]) =>
              context.log(...args)
            );
          } catch (error) {
            context.log('[StripeTrueUp] Error getting product name', {
              chargeId: charge.id,
              error: error instanceof Error ? error.message : String(error),
              stack: error instanceof Error ? error.stack : undefined,
            });
          }
        }

        const category =
          productName ||
          metadata.category ||
          metadata.Category ||
          config.transaction.defaultCategory;
        const normalizedCategory = normalizeTransactionCategory(category, config);

        if (!transaction.campaign__c && productName) {
          await applyCampaignFromCategory(context, transaction, productName, charge.id);
        }

        if (contactId) {
          transaction.contact__c = contactId;
          delete transaction.account__c;
          context.log('[StripeTrueUp] Associated contact with transaction', {
            contactId,
            transactionStripeChargeId: transaction.stripe_charge_id__c,
            matchPath: 'stripe_salesforce_id',
          });
        } else if (accountId) {
          transaction.account__c = accountId;
          delete transaction.contact__c;
          context.log('[StripeTrueUp] Associated account with transaction', {
            accountId,
            transactionStripeChargeId: transaction.stripe_charge_id__c,
            matchPath: 'stripe_salesforce_id',
          });
        } else {
          context.log('[StripeTrueUp] No Salesforce record ID to associate with transaction', {
            transactionStripeChargeId: transaction.stripe_charge_id__c,
          });
        }

        context.log('[StripeTrueUp] Upserting transaction to Salesforce', {
          chargeId: charge.id,
          contactId: transaction.contact__c,
          accountId: transaction.account__c,
          hasContact: !!transaction.contact__c,
          hasAccount: !!transaction.account__c,
        });

        if (
          skipUpsertWhenRequiredFieldsMissing(context, summary, {
            message: '[StripeTrueUp] Skipping transaction upsert due to missing required fields',
            idKey: 'chargeId',
            idValue: charge.id,
            transaction,
          })
        ) {
          continue;
        }

        const upsertResult = await salesforce.upsertTransactionByExternalId(
          transaction,
          'stripe_charge_id__c',
          existingTransactionId ? { overrideId: existingTransactionId } : undefined
        );
        summary.salesforceUpdates += 1;

        const chargeMetadata = (charge as Stripe.Charge).metadata as
          | Record<string, unknown>
          | null
          | undefined;
        const checkoutSessionStub = chargeMetadata
          ? ({
              id: `stub_${charge.id}`,
              metadata: chargeMetadata,
            } as Partial<Stripe.Checkout.Session>)
          : undefined;

        const grossAmount = Math.abs(balanceTransaction.amount ?? 0);

        if (bypassQbo) {
          context.log('[StripeTrueUp] QBO posting bypassed by override for charge', {
            chargeId: charge.id,
          });
        } else {
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
        }
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
  resubmit: boolean,
  bypassQbo: boolean,
  limit: number | null
): Promise<ProcessSummary> => {
  const summary = buildProcessSummary();
  const params = buildFetchParams('created', to, context.log);

  const refunds = await dependencies.fetchers.refunds(stripe, from, params as never);
  const recordsToProcess = typeof limit === 'number' ? refunds.slice(0, limit) : refunds;
  summary.fetched = recordsToProcess.length;

  const ensureSalesforce = createLazySalesforceGetter();

  for (const refund of recordsToProcess) {
    try {
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

      const shouldSkip = await shouldSkipForResubmitOrIdempotency({
        resubmit,
        idempotencyKey: key,
        checkResubmit: async () => {
          const salesforce = await ensureSalesforce();
          const existingId = await salesforce.findTransactionIdByExternalId(
            'stripe_refund_id__c',
            refund.id,
            STRIPE_TRANSACTION_RECORD_TYPE_NAME
          );
          if (existingId) {
            context.log('[StripeTrueUp] Skipping refund already in Salesforce', {
              refundId: refund.id,
              salesforceId: existingId,
            });
            return true;
          }

          return false;
        },
      });

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
            chargeId,
            STRIPE_TRANSACTION_RECORD_TYPE_NAME
          );
        }

        let chargeFragment: Stripe.Charge | null = null;
        if (typeof refund.charge === 'object' && refund.charge) {
          chargeFragment = refund.charge as Stripe.Charge;
        } else if (chargeId) {
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

        const chargeMetadata =
          (chargeFragment?.metadata as Record<string, unknown> | undefined) || undefined;

        let contactId: string | null = null;
        let accountId: string | null = null;
        let stripeCustomer: Stripe.Customer | Stripe.DeletedCustomer | null = null;

        if (chargeFragment && chargeFragment.customer) {
          stripeCustomer = await resolveCustomerForCharge(
            stripe,
            chargeFragment,
            (...args: unknown[]) => context.log(...args)
          );
        }

        const customerMetadata =
          stripeCustomer && !stripeCustomer.deleted
            ? ((stripeCustomer as Stripe.Customer).metadata as Record<string, unknown>) || undefined
            : undefined;
        const customerMetadataSalesforceId = extractSalesforceIdFromMetadata(customerMetadata);
        const chargeMetadataSalesforceId = extractSalesforceIdFromMetadata(chargeMetadata);
        const metadataSource: 'customer' | 'charge' | null = customerMetadataSalesforceId
          ? 'customer'
          : chargeMetadataSalesforceId
            ? 'charge'
            : null;
        const selectedMetadata =
          metadataSource === 'customer'
            ? customerMetadata
            : metadataSource === 'charge'
              ? chargeMetadata
              : undefined;
        const metadataSalesforceId =
          metadataSource === 'customer'
            ? customerMetadataSalesforceId
            : metadataSource === 'charge'
              ? chargeMetadataSalesforceId
              : null;

        if (metadataSalesforceId && selectedMetadata) {
          const resolvedReference = await resolveSalesforceReferenceFromMetadata(
            salesforce,
            selectedMetadata,
            (...args: unknown[]) => context.log(...args),
            refund.id,
            'refund',
            metadataSource || 'charge'
          );

          if (resolvedReference?.target === 'Contact') {
            contactId = resolvedReference.id;
          } else if (resolvedReference?.target === 'Account') {
            accountId = resolvedReference.id;
          }

          if (!resolvedReference) {
            context.log(
              '[StripeTrueUp] Stripe metadata salesforce_id provided on refund charge but could not be resolved; skipping Salesforce creation fallback',
              {
                refundId: refund.id,
                chargeId: chargeFragment?.id ?? chargeId,
                metadataSalesforceId,
                metadataSource,
              }
            );
          }
        } else if (chargeFragment && chargeFragment.customer) {
          context.log(
            '[StripeTrueUp] Falling back to existing Stripe customer matching flow for refund',
            {
              refundId: refund.id,
              chargeId: chargeFragment.id,
              customerId: extractStripeId(chargeFragment.customer),
              matchPath: 'fallback_match',
            }
          );
          context.log('[StripeTrueUp] Processing refund customer', {
            refundId: refund.id,
            chargeId: chargeFragment.id,
            customerId: extractStripeId(chargeFragment.customer),
          });

          context.log('[StripeTrueUp] Retrieved customer for refund', {
            refundId: refund.id,
            customerId: stripeCustomer?.id,
            customerExists: !!stripeCustomer,
            metadataSalesforceId,
            metadataSource,
          });

          if (stripeCustomer && !stripeCustomer.deleted) {
            try {
              const customerUpsertResult = await salesforce.upsertCustomerByStripeId({
                stripe_customer_id__c: stripeCustomer.id,
                Name:
                  (stripeCustomer as Stripe.Customer).name ||
                  (stripeCustomer as Stripe.Customer).email ||
                  `Customer ${stripeCustomer.id}`,
                Email: (stripeCustomer as Stripe.Customer).email || null,
              });
              contactId = customerUpsertResult?.id ?? null;

              if (stripeCustomer && contactId) {
                await ensureSalesforceIdOnCustomer(
                  stripe,
                  stripeCustomer.id,
                  contactId,
                  (...args: unknown[]) => context.log(...args)
                );
              }

              context.log('[StripeTrueUp] Contact upsert completed for refund', {
                refundId: refund.id,
                contactId,
                success: !!contactId,
                matchPath:
                  customerUpsertResult?.created === true
                    ? 'created_new_salesforce_record'
                    : 'fallback_match',
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
          ? typeof chargeFragment.payment_intent === 'string'
            ? chargeFragment.payment_intent
            : chargeFragment.payment_intent?.id
          : null;

        const transaction: TransactionUpsertDTO = mapStripeToTransaction({
          paymentIntent: null,
          charge: chargeFragment ?? null,
          balanceTransaction,
          stripeCustomer,
        });

        applyRefundSpecificFields(transaction, refund);

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

        if (parentId) {
          transaction.parent_transaction__c = parentId;
        }

        if (contactId) {
          transaction.contact__c = contactId;
          delete transaction.account__c;
          context.log('[StripeTrueUp] Associated contact with refund transaction', {
            contactId,
            refundId: refund.id,
            matchPath: 'stripe_salesforce_id',
          });
        } else if (accountId) {
          transaction.account__c = accountId;
          delete transaction.contact__c;
          context.log('[StripeTrueUp] Associated account with refund transaction', {
            accountId,
            refundId: refund.id,
            matchPath: 'stripe_salesforce_id',
          });
        } else {
          context.log(
            '[StripeTrueUp] No Salesforce record ID to associate with refund transaction',
            {
              refundId: refund.id,
            }
          );
        }

        context.log('[StripeTrueUp] Upserting refund transaction to Salesforce', {
          refundId: refund.id,
          contactId: transaction.contact__c,
          accountId: transaction.account__c,
          hasContact: !!transaction.contact__c,
          hasAccount: !!transaction.account__c,
        });

        if (
          skipUpsertWhenRequiredFieldsMissing(context, summary, {
            message:
              '[StripeTrueUp] Skipping refund transaction upsert due to missing required fields',
            idKey: 'refundId',
            idValue: refund.id,
            transaction,
          })
        ) {
          continue;
        }

        const upsertResult = await salesforce.upsertTransactionByExternalId(
          transaction,
          'stripe_refund_id__c'
        );
        summary.salesforceUpdates += 1;

        const refundAmount = Math.abs(balanceTransaction.amount ?? 0);

        if (bypassQbo) {
          context.log('[StripeTrueUp] QBO posting bypassed by override for refund', {
            refundId: refund.id,
          });
        } else {
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
            feeAmount: Math.abs(balanceTransaction.fee ?? 0),
            memo: `Stripe refund ${refund.id}`,
            date: timestampToDate(
              balanceTransaction.created ?? balanceTransaction.available_on ?? null
            ),
          });
          summary.qboPosts += 1;

          await markPosted(salesforce, upsertResult, posting);
        }
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

const applyRefundSpecificFields = (
  transaction: TransactionUpsertDTO,
  refund: Stripe.Refund
): void => {
  const refundWithLivemode = refund as Stripe.Refund & { livemode?: boolean };

  transaction.stripe_refund_id__c = refund.id;

  if (typeof refund.created === 'number' && Number.isFinite(refund.created)) {
    transaction.received_at__c = new Date(refund.created * 1000).toISOString();
  }

  if (typeof refundWithLivemode.livemode === 'boolean') {
    transaction.stripe_livemode__c = refundWithLivemode.livemode;
  }
};

const processPayouts = async (
  context: HttpContext,
  stripe: Stripe,
  from: number,
  to: number | null,
  dryRun: boolean,
  resubmit: boolean,
  bypassQbo: boolean,
  limit: number | null
): Promise<ProcessSummary> => {
  const summary = buildProcessSummary();
  const params = buildFetchParams('arrival_date', to, context.log);

  const payouts = await dependencies.fetchers.payouts(stripe, from, params as never);
  const recordsToProcess = typeof limit === 'number' ? payouts.slice(0, limit) : payouts;
  summary.fetched = recordsToProcess.length;

  const ensureSalesforce = createLazySalesforceGetter();

  for (const payout of recordsToProcess) {
    try {
      if (!payout || !payout.id) {
        summary.errors += 1;
        continue;
      }

      if (payout.status !== 'paid') {
        context.log('[StripeTrueUp] Skipping payout with non-paid status', {
          payoutId: payout.id,
          status: payout.status,
        });
        summary.skipped += 1;
        continue;
      }

      const key = `payout_${payout.id}`;

      const shouldSkip = await shouldSkipForResubmitOrIdempotency({
        resubmit,
        idempotencyKey: key,
        checkResubmit: async () => {
          const salesforce = await ensureSalesforce();
          try {
            const existingId = await salesforce.findTransactionIdByExternalId(
              'stripe_payout_id__c',
              payout.id,
              'Payout'
            );
            if (existingId) {
              context.log('[StripeTrueUp] Skipping payout already linked in Salesforce', {
                payoutId: payout.id,
                salesforceId: existingId,
              });
              return true;
            }

            return false;
          } catch (error) {
            context.log('[StripeTrueUp] Failed to check payout in Salesforce, will process', {
              payoutId: payout.id,
              error: error instanceof Error ? error.message : String(error),
            });
            return false;
          }
        },
      });

      if (shouldSkip) {
        summary.skipped += 1;
        continue;
      }

      if (!dryRun) {
        const salesforce = await ensureSalesforce();

        let balanceTransactions: any[] = [];
        if (payout.automatic) {
          try {
            balanceTransactions = await dependencies.fetchers.payoutBalance(stripe, payout.id, {
              logger: context.log,
            });
          } catch (error) {
            context.log(
              '[StripeTrueUp] Could not fetch balance transactions for automatic payout',
              {
                payoutId: payout.id,
                error: error instanceof Error ? error.message : String(error),
              }
            );
          }
        }

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
          currency_iso_code__c: (typeof payout.currency === 'string'
            ? payout.currency
            : 'usd'
          ).toUpperCase(),
          memo__c: `Stripe Payout ${payout.id} (${payout.automatic ? 'automatic' : 'manual'})`,
          received_at__c: timestampToDate(
            payout.arrival_date ?? payout.created ?? null
          ).toISOString(),
          posted_to_qbo__c: false,
          qbo_doc_type__c: null,
          qbo_doc_id__c: null,
          qbo_posted_at__c: null,
          posting_error__c: null,
        };

        try {
          if (
            skipUpsertWhenRequiredFieldsMissing(context, summary, {
              message:
                '[StripeTrueUp] Skipping payout transaction upsert due to missing required fields',
              idKey: 'payoutId',
              idValue: payout.id,
              transaction: payoutTransaction,
            })
          ) {
            continue;
          }

          await salesforce.upsertTransactionByExternalId(payoutTransaction, 'stripe_payout_id__c');
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

        if (
          balanceTransactions.length > 0 &&
          typeof salesforce.linkPayoutOnTransactions === 'function'
        ) {
          const ids = balanceTransactions
            .map((txn) => txn?.id)
            .filter((id): id is string => typeof id === 'string' && id.trim().length > 0);

          if (ids.length > 0) {
            const results = await salesforce.linkPayoutOnTransactions(payout.id, ids);
            summary.salesforceUpdates += results.length;
          }
        }

        if (bypassQbo) {
          context.log('[StripeTrueUp] QBO posting bypassed by override for payout', {
            payoutId: payout.id,
          });
        } else {
          const posting = await dependencies.accounting.postPayoutToQbo({
            amount: payoutAmount,
            memo: `Stripe payout ${payout.id}`,
            date: timestampToDate(payout.created ?? payout.arrival_date ?? null),
            payoutId: payout.id,
          });
          summary.qboPosts += 1;

          if (posting && posting.qboId) {
            try {
              const payoutTxnId = await salesforce.findTransactionIdByExternalId(
                'stripe_payout_id__c',
                payout.id,
                'Payout'
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

const validateEnvironment = (
  bypassQbo: boolean,
  liveMode: boolean
): { valid: boolean; errors: string[] } => {
  const errors: string[] = [];

  if (liveMode) {
    if (!process.env.STRIPE_LIVE_SECRET_KEY && !getDefaultStripeSecret()) {
      errors.push('STRIPE_LIVE_SECRET_KEY is not configured for live mode');
    }
  } else {
    if (!process.env.STRIPE_TEST_SECRET_KEY && !getDefaultStripeSecret()) {
      errors.push('STRIPE_TEST_SECRET_KEY is not configured for test mode');
    }
  }

  if (!process.env.SF_CLIENT_ID) {
    errors.push('SF_CLIENT_ID is not configured (Salesforce sync will fail)');
  }
  if (!process.env.SF_CLIENT_SECRET) {
    errors.push('SF_CLIENT_SECRET is not configured (Salesforce sync will fail)');
  }

  if (!bypassQbo) {
    if (!process.env.QBO_CLIENT_ID) {
      errors.push('QBO_CLIENT_ID is not configured (QuickBooks sync will fail)');
    }
    if (!process.env.QBO_CLIENT_SECRET) {
      errors.push('QBO_CLIENT_SECRET is not configured (QuickBooks sync will fail)');
    }
    if (!process.env.QBO_REALM_ID && !process.env.QBO_COMPANY_ID) {
      errors.push('QBO_REALM_ID or QBO_COMPANY_ID is not configured (QuickBooks sync will fail)');
    }
  }

  return { valid: errors.length === 0, errors };
};

const readQueryParams = (req: HttpRequest): Record<string, string | undefined> => {
  const queryRaw = (req as unknown as { query?: unknown }).query;

  if (queryRaw instanceof URLSearchParams) {
    return Object.fromEntries(queryRaw.entries());
  }

  if (queryRaw && typeof queryRaw === 'object') {
    return queryRaw as Record<string, string | undefined>;
  }

  return {};
};

const parseRequestOptions = (req: HttpRequest): ParsedRequestOptions => {
  const query = readQueryParams(req);
  const bypassQboDefault = parseBoolean(process.env.STRIPE_TRUE_UP_BYPASS_QBO, false);
  const bypassQboParam =
    query.bypassQbo ??
    query.skipQbo ??
    getHeader(req, 'x-bypass-qbo') ??
    getHeader(req, 'x-skip-qbo');
  const bypassQbo = parseBoolean(bypassQboParam, bypassQboDefault);

  const defaultLiveMode = process.env.STRIPE_TRUE_UP_MODE === 'live';
  const requestedMode = parseModeToggle(query.mode ?? getHeader(req, 'x-stripe-mode'));
  if (!requestedMode.isValid) {
    return {
      ok: false,
      response: respond(400, {
        error: 'bad_request',
        message: requestedMode.message,
      }),
    };
  }

  const liveMode =
    typeof requestedMode.isLiveMode === 'boolean' ? requestedMode.isLiveMode : defaultLiveMode;

  const fromParam = query.from;
  if (!fromParam) {
    return {
      ok: false,
      response: respond(400, {
        error: 'bad_request',
        message: 'Query parameter "from" is required.',
      }),
    };
  }

  let from: number;
  try {
    from = toEpochSeconds(fromParam);
  } catch (error) {
    return {
      ok: false,
      response: respond(400, {
        error: 'bad_request',
        message: error instanceof Error ? error.message : String(error),
      }),
    };
  }

  let to: number | null = null;
  if (query.to) {
    try {
      to = toEpochSeconds(query.to);
    } catch (error) {
      return {
        ok: false,
        response: respond(400, {
          error: 'bad_request',
          message: error instanceof Error ? error.message : String(error),
        }),
      };
    }

    if (to < from) {
      return {
        ok: false,
        response: respond(400, {
          error: 'bad_request',
          message: 'The "to" parameter must be greater than or equal to "from".',
        }),
      };
    }
  }

  const type = (query.type || 'payments').toLowerCase();
  if (!['payments', 'refunds', 'payouts'].includes(type)) {
    return {
      ok: false,
      response: respond(400, {
        error: 'bad_request',
        message: 'Query parameter "type" must be one of payments, refunds, or payouts.',
      }),
    };
  }

  let limit: number | null;
  try {
    limit = parseLimit(query.limit);
  } catch (error) {
    return {
      ok: false,
      response: respond(400, {
        error: 'bad_request',
        message: error instanceof Error ? error.message : String(error),
      }),
    };
  }

  return {
    ok: true,
    value: {
      bypassQbo,
      liveMode,
      from,
      to,
      type: type as TrueUpRequestOptions['type'],
      dryRun: parseBoolean(query.dryRun, false),
      resubmit: parseBoolean(query.resubmit, false),
      limit,
    },
  };
};

const processRecordsByType = async (
  context: InvocationContext,
  stripe: Stripe,
  options: TrueUpRequestOptions
): Promise<ProcessSummary> => {
  if (options.type === 'payments') {
    return await processPayments(
      context,
      stripe,
      options.from,
      options.to,
      options.dryRun,
      options.resubmit,
      options.bypassQbo,
      options.limit
    );
  }

  if (options.type === 'refunds') {
    return await processRefunds(
      context,
      stripe,
      options.from,
      options.to,
      options.dryRun,
      options.resubmit,
      options.bypassQbo,
      options.limit
    );
  }

  return await processPayouts(
    context,
    stripe,
    options.from,
    options.to,
    options.dryRun,
    options.resubmit,
    options.bypassQbo,
    options.limit
  );
};

const flushIdempotencyStoreIfNeeded = async (
  dryRun: boolean,
  context: InvocationContext
): Promise<void> => {
  if (dryRun) {
    return;
  }

  await dependencies.idempotencyStore.flush();
  context.log('[StripeTrueUp] Idempotency store flushed successfully');
};

const buildSuccessResponse = (options: TrueUpRequestOptions, summary: ProcessSummary) =>
  respond(200, {
    type: options.type,
    dryRun: options.dryRun,
    resubmit: options.resubmit,
    bypassQbo: options.bypassQbo,
    limit: options.limit,
    liveMode: options.liveMode,
    range: {
      from: timestampToIsoString(options.from),
      to: options.to ? timestampToIsoString(options.to) : null,
    },
    counts: summary,
  });

const buildEnvironmentErrorResponse = (errors: string[]) =>
  respond(500, {
    error: 'configuration_error',
    message: 'Required environment variables are not configured.',
    details: errors,
  });

const buildInternalErrorResponse = (error: unknown) =>
  respond(500, {
    error: 'internal_error',
    message: 'Failed to complete Stripe true-up operation.',
    details: error instanceof Error ? error.message : String(error),
  });

const runTrueUpWorkflow = async (
  context: InvocationContext,
  options: TrueUpRequestOptions
): Promise<ReturnType<typeof buildSuccessResponse>> => {
  const stripe = dependencies.stripe.getClient(options.liveMode);
  const summary = await processRecordsByType(context, stripe, options);

  await flushIdempotencyStoreIfNeeded(options.dryRun, context);

  return buildSuccessResponse(options, summary);
};

const stripeTrueUp = async (req: HttpRequest, context: InvocationContext): Promise<any> => {
  try {
    const parsedOptions = parseRequestOptions(req);
    if (!parsedOptions.ok) {
      return parsedOptions.response;
    }

    const options = parsedOptions.value;
    const envCheck = validateEnvironment(options.bypassQbo, options.liveMode);
    if (!envCheck.valid) {
      context.log('[StripeTrueUp] Environment validation failed:', envCheck.errors);
      return buildEnvironmentErrorResponse(envCheck.errors);
    }

    return await runTrueUpWorkflow(context, options);
  } catch (error) {
    context.log('[StripeTrueUp] Unhandled error', {
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    return buildInternalErrorResponse(error);
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

export { findOrCreateContactInSalesforce };

export default handlerWithInternals;
