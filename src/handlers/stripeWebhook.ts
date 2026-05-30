import Stripe from 'stripe';

import env from '../config/env';
import { logger } from '../lib/logger';
import { isRequestLimitExceeded } from '../lib/salesforceErrors';
import { AzureIdempotencyStore, type IdempotencyStore } from '../services/idempotencyStore';
import { createSalesforceSvc, type SalesforceSvc } from '../services/salesforceSvc';
import { SalesforceService, buildSalesforceConfig } from '../services/salesforceService';
import type { UpsertResult } from 'jsforce/lib/types';
import {
  postChargeToQbo,
  postRefundToQbo,
  postDisputeToQbo,
  postDisputeReversalToQbo,
  postPayoutToQbo,
} from '../services/qboSvc';
import {
  type DependencyOverrides,
  type HttpContext,
  type StripeWebhookDependencies,
  type StripeWebhookRequest,
  type RefundReceiptAccountingAdapter,
  type PayoutAccountingAdapter,
  type StripeQuickBooksDocument,
} from '../stripe/types';
import { createMockStripeServices } from '../stripe/mock';
import { serviceContainer } from '../services/container';
import { stripeClientFactory } from '../services/stripeClientFactory';

const STRIPE_API_VERSION: Stripe.LatestApiVersion = '2023-10-16';

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

const addTrimmedUniqueValue = (values: string[], value: unknown): void => {
  if (typeof value !== 'string') {
    return;
  }

  const trimmed = value.trim();
  if (!trimmed || values.includes(trimmed)) {
    return;
  }

  values.push(trimmed);
};

const collectWebhookSecrets = (): string[] => {
  const secrets: string[] = [];

  addTrimmedUniqueValue(secrets, env.stripe.webhookSecret);
  addTrimmedUniqueValue(secrets, process.env.STRIPE_WEBHOOK_SECRET);
  addTrimmedUniqueValue(secrets, process.env.STRIPE_WEBHOOK_SECRET_TEST);
  addTrimmedUniqueValue(secrets, process.env.STRIPE_WEBHOOK_SECRET_LIVE);

  const accountSecrets = process.env.STRIPE_WEBHOOK_SECRETS;
  if (typeof accountSecrets === 'string' && accountSecrets.trim().length > 0) {
    const entries = accountSecrets.split(',');
    for (const entry of entries) {
      const trimmedEntry = entry.trim();
      if (!trimmedEntry) {
        continue;
      }

      const segments = trimmedEntry.split(':').map((segment) => segment.trim());
      addTrimmedUniqueValue(secrets, segments.length >= 2 ? segments[1] : segments[0]);
    }
  }

  return secrets;
};

const verifyEventWithSecrets = (
  client: Stripe,
  payload: Buffer | string,
  signature: string,
  secrets: string[]
): Stripe.Event => {
  if (secrets.length === 0) {
    throw new Error('No Stripe webhook secret configured.');
  }

  let lastError: unknown;
  for (const secret of secrets) {
    try {
      return client.webhooks.constructEvent(payload, signature, secret);
    } catch (error) {
      lastError = error;
    }
  }

  throw (lastError as Error) || new Error('Stripe webhook signature verification failed.');
};

const createStripeServices = (): StripeWebhookDependencies['stripe'] => {
  if (env.testMode) {
    return createMockStripeServices();
  }

  const defaultClient = stripeClientFactory.getDefaultClient({ apiVersion: STRIPE_API_VERSION });

  const getClient = (livemode: boolean): Stripe =>
    stripeClientFactory.getClient(livemode, { apiVersion: STRIPE_API_VERSION });

  return {
    verifyEvent: (payload, signature) =>
      verifyEventWithSecrets(defaultClient, payload, signature, collectWebhookSecrets()),
    getClient,
  };
};

let defaultSalesforceSvcPromise: Promise<SalesforceSvc> | null = null;
type CrmService = {
  findOrCreateCampaign: (name: string) => Promise<string>;
  authenticate?: () => Promise<void>;
};

const createDisabledCrmSvc = (): CrmService => ({
  async findOrCreateCampaign(name: string): Promise<string> {
    return `701000000000000_${name}`;
  },
});

const createDisabledSalesforceSvc = (): SalesforceSvc => {
  const disabledUpsertResult = { success: true, id: '', errors: [] } as unknown as UpsertResult;

  return {
    async upsertTransactionByExternalId(): Promise<UpsertResult> {
      return disabledUpsertResult;
    },
    async linkPayoutOnTransactions(): Promise<UpsertResult[]> {
      return [];
    },
    async markPostedToQbo(): Promise<void> {
      return;
    },
    async clearStaleQboDocReference(): Promise<void> {
      return;
    },
    async findTransactionIdByExternalId(): Promise<string | null> {
      return null;
    },
    async upsertCustomerByStripeId(): Promise<UpsertResult> {
      return disabledUpsertResult;
    },
  };
};

const createCachedServiceGetter = <T>(options: {
  disabledService: T;
  unsupportedAuthModeMessage: string;
  getCachedPromise: () => Promise<T> | null;
  setCachedPromise: (promise: Promise<T> | null) => void;
  initialize: () => Promise<T>;
  onInitializationError?: (error: unknown) => void;
  /**
   * When true, initialization errors are re-thrown rather than swallowed.
   * The caller receives a rejected Promise and any dependent webhook processing
   * will return HTTP 503 (retryable) instead of silently succeeding with a
   * no-op service.
   */
  rethrowOnError?: boolean;
}): (() => Promise<T>) => {
  if (env.salesforce.authMode === 'disabled') {
    return async () => options.disabledService;
  }

  if (env.salesforce.authMode !== 'client-credentials') {
    throw new Error(options.unsupportedAuthModeMessage);
  }

  return async (): Promise<T> => {
    const cachedPromise = options.getCachedPromise();
    if (cachedPromise) {
      return cachedPromise;
    }

    const initializedPromise = (async () => {
      try {
        return await options.initialize();
      } catch (error) {
        options.setCachedPromise(null);
        options.onInitializationError?.(error);
        if (options.rethrowOnError) {
          throw error;
        }
        return options.disabledService;
      }
    })();

    options.setCachedPromise(initializedPromise);
    return initializedPromise;
  };
};

const createSalesforceGetter = (): (() => Promise<SalesforceSvc>) => {
  const disabledSvc = createDisabledSalesforceSvc();

  return createCachedServiceGetter({
    disabledService: disabledSvc,
    unsupportedAuthModeMessage: `Unsupported Salesforce auth mode: ${env.salesforce.authMode}`,
    getCachedPromise: () => defaultSalesforceSvcPromise,
    setCachedPromise: (promise) => {
      defaultSalesforceSvcPromise = promise;
    },
    initialize: async () => {
      const service = new SalesforceService(buildSalesforceConfig());
      const connection = await service.authenticate();
      return createSalesforceSvc({ connection });
    },
    // Log the failure so it is visible in Application Insights, then re-throw
    // so the in-flight webhook request returns HTTP 503 (Stripe will retry)
    // rather than silently succeeding with a no-op service that drops all writes.
    onInitializationError: (error) => {
      logger.error(
        '[StripeWebhook] Salesforce authentication failed; returning HTTP 503 so Stripe retries',
        {
          error: error instanceof Error ? error.message : String(error),
        }
      );
    },
    rethrowOnError: true,
  });
};

let defaultCrmSvcPromise: Promise<CrmService> | null = null;

const isCriticalSalesforceError = (error: unknown): boolean => isRequestLimitExceeded(error);

const createCrmGetter = (): (() => Promise<CrmService>) => {
  const disabledCrmSvc = createDisabledCrmSvc();

  return createCachedServiceGetter({
    disabledService: disabledCrmSvc,
    unsupportedAuthModeMessage: `Unsupported Salesforce auth mode for CRM: ${env.salesforce.authMode}`,
    getCachedPromise: () => defaultCrmSvcPromise,
    setCachedPromise: (promise) => {
      defaultCrmSvcPromise = promise;
    },
    initialize: async () => {
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
    },
    onInitializationError: (error) => {
      const message = error instanceof Error ? error.message : 'Unknown CRM initialization error';
      logger.error('[StripeWebhook] CRM initialization failed:', message);
      if (isCriticalSalesforceError(error)) {
        throw error;
      }
    },
  });
};

const sumRefundLineAmounts = (lines: { amountCents: number }[]): number =>
  lines.reduce((total, line) => total + Math.max(0, Math.trunc(line.amountCents || 0)), 0);

const toQuickBooksDocument = (result: {
  qboId: string;
  type: string;
}): StripeQuickBooksDocument => ({
  id: result.qboId,
  type: result.type,
});

const postWhenAmountPositive = async (
  amountCents: number,
  post: () => Promise<{ qboId: string; type: string }>
): Promise<StripeQuickBooksDocument | null> => {
  if (amountCents <= 0) {
    return null;
  }

  const result = await post();
  return toQuickBooksDocument(result);
};

const createRefundReceiptAdapter = (): RefundReceiptAccountingAdapter => ({
  async upsertRefundReceipt(input) {
    const totalCents = sumRefundLineAmounts(input.lines ?? []);
    return postWhenAmountPositive(totalCents, () =>
      postRefundToQbo({
        amount: totalCents,
        feeAmount: Math.max(0, Math.trunc(input.feeAmountCents ?? 0)),
        memo: input.memo,
        date: input.txnDate,
        refundId: input.stripeRefundId,
      })
    );
  },
});

const createPayoutAdapter = (): PayoutAccountingAdapter => ({
  async upsertDeposit(input) {
    const amountCents = Math.abs(Math.trunc(input.totalAmountCents ?? 0));
    return postWhenAmountPositive(amountCents, () =>
      postPayoutToQbo({
        amount: amountCents,
        memo: input.memo,
        date: input.txnDate,
        payoutId: input.payout?.id,
      })
    );
  },
  async markDepositForReview() {
    return;
  },
});

const createAccountingDependencies = (): StripeWebhookDependencies['accounting'] => ({
  postChargeToQbo,
  postRefundToQbo,
  postDisputeToQbo,
  postDisputeReversalToQbo,
  refundReceipts: createRefundReceiptAdapter(),
  payouts: createPayoutAdapter(),
});

const createDefaultDependencies = (): StripeWebhookDependencies => {
  // Azure Functions Consumption Plan sets WEBSITE_INSTANCE_ID when running in
  // Azure.  DISABLE_AZURE_TABLES=1 disables the distributed lock entirely and
  // must never be used in multi-instance deployments.
  if (process.env.DISABLE_AZURE_TABLES === '1' && process.env.WEBSITE_INSTANCE_ID) {
    throw new Error(
      'DISABLE_AZURE_TABLES=1 cannot be used in Azure deployments. ' +
        'This setting disables distributed locking and idempotency persistence, which ' +
        'is only safe for local development. Remove DISABLE_AZURE_TABLES from your ' +
        'Azure Function App configuration.'
    );
  }

  return {
    stripe: createStripeServices(),
    idempotencyStore:
      process.env.DISABLE_AZURE_TABLES === '1'
        ? createInMemoryStore()
        : new AzureIdempotencyStore(),
    getSalesforceSvc: createSalesforceGetter(),
    getCrmSvc: createCrmGetter(),
    accounting: createAccountingDependencies(),
  };
};

let dependencies: StripeWebhookDependencies | null = null;

const getDependencies = (): StripeWebhookDependencies => {
  if (!dependencies) {
    dependencies = createDefaultDependencies();
  }
  return dependencies;
};

const mergeDependencies = (
  defaultDeps: StripeWebhookDependencies,
  overrides: DependencyOverrides
): StripeWebhookDependencies => ({
  stripe: { ...defaultDeps.stripe, ...overrides.stripe },
  idempotencyStore: overrides.idempotencyStore ?? defaultDeps.idempotencyStore,
  getSalesforceSvc: overrides.getSalesforceSvc ?? defaultDeps.getSalesforceSvc,
  getCrmSvc: overrides.getCrmSvc ?? defaultDeps.getCrmSvc,
  accounting: { ...defaultDeps.accounting, ...overrides.accounting },
});

const setDependencies = (overrides?: DependencyOverrides) => {
  if (overrides) {
    serviceContainer.setTestDependencies(mergeDependencies(createDefaultDependencies(), overrides));
  } else {
    serviceContainer.setTestDependencies(undefined);
  }
};

const resetDependencies = (): void => {
  defaultSalesforceSvcPromise = null;
  defaultCrmSvcPromise = null;
  dependencies = null;
};

const stripeWebhook = async (request: StripeWebhookRequest, context: HttpContext): Promise<any> => {
  const processor = serviceContainer.getStripeWebhookProcessor();
  return await processor.handle(request, context);
};

type HandlerWithInternals = typeof stripeWebhook & {
  __internals?: {
    setDependencies: (overrides?: DependencyOverrides) => void;
    resetDependencies: () => void;
  };
};

const handlerWithInternals = stripeWebhook as HandlerWithInternals;
handlerWithInternals.__internals = {
  setDependencies,
  resetDependencies,
};

export { handlerWithInternals as default, createDefaultDependencies, getDependencies };
