import Stripe from 'stripe';

import env from '../config/env';
import { logger } from '../lib/logger';
import { AzureIdempotencyStore, type IdempotencyStore } from '../services/idempotencyStore';
import { createSalesforceSvc, type SalesforceSvc } from '../services/salesforceSvc';
import { SalesforceService, buildSalesforceConfig } from '../services/salesforceService';
import type { UpsertResult } from 'jsforce/lib/types';
import {
  postChargeToQbo,
  postRefundToQbo,
  postDisputeToQbo,
  postPayoutToQbo,
} from '../services/qboSvc';
import {
  type DependencyOverrides,
  type HttpContext,
  type StripeWebhookDependencies,
  type StripeWebhookRequest,
  type RefundReceiptAccountingAdapter,
  type PayoutAccountingAdapter,
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

const createStripeServices = (): StripeWebhookDependencies['stripe'] => {
  if (env.testMode) {
    return createMockStripeServices();
  }

  const defaultClient = stripeClientFactory.getDefaultClient({ apiVersion: STRIPE_API_VERSION });

  const collectWebhookSecrets = (): string[] => {
    const secrets: string[] = [];

    const add = (value: unknown) => {
      if (typeof value !== 'string') {
        return;
      }

      const trimmed = value.trim();
      if (!trimmed || secrets.includes(trimmed)) {
        return;
      }

      secrets.push(trimmed);
    };

    add(env.stripe.webhookSecret);
    add(process.env.STRIPE_WEBHOOK_SECRET);
    add(process.env.STRIPE_WEBHOOK_SECRET_TEST);
    add(process.env.STRIPE_WEBHOOK_SECRET_LIVE);

    const accountSecrets = process.env.STRIPE_WEBHOOK_SECRETS;
    if (typeof accountSecrets === 'string' && accountSecrets.trim().length > 0) {
      const entries = accountSecrets.split(',');
      for (const entry of entries) {
        const trimmedEntry = entry.trim();
        if (!trimmedEntry) {
          continue;
        }

        const segments = trimmedEntry.split(':').map((segment) => segment.trim());
        if (segments.length >= 2) {
          add(segments[1]);
        } else {
          add(segments[0]);
        }
      }
    }

    return secrets;
  };

  const getClient = (livemode: boolean): Stripe =>
    stripeClientFactory.getClient(livemode, { apiVersion: STRIPE_API_VERSION });

  return {
    verifyEvent: (payload, signature) => {
      const secrets = collectWebhookSecrets();
      if (secrets.length === 0) {
        throw new Error('No Stripe webhook secret configured.');
      }

      let lastError: unknown;
      for (const secret of secrets) {
        try {
          return defaultClient.webhooks.constructEvent(payload, signature, secret);
        } catch (error) {
          lastError = error;
        }
      }

      throw (lastError as Error) || new Error('Stripe webhook signature verification failed.');
    },
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
    async findTransactionIdByExternalId(): Promise<string | null> {
      return null;
    },
    async upsertCustomerByStripeId(): Promise<UpsertResult> {
      return disabledUpsertResult;
    },
  };
};

const createSalesforceGetter = (): (() => Promise<SalesforceSvc>) => {
  const disabledSvc = createDisabledSalesforceSvc();

  if (env.salesforce.authMode === 'disabled') {
    return async () => disabledSvc;
  }

  if (env.salesforce.authMode !== 'client-credentials') {
    throw new Error(`Unsupported Salesforce auth mode: ${env.salesforce.authMode}`);
  }

  return async (): Promise<SalesforceSvc> => {
    if (!defaultSalesforceSvcPromise) {
      defaultSalesforceSvcPromise = (async () => {
        try {
          const service = new SalesforceService(buildSalesforceConfig());
          const connection = await service.authenticate();
          return createSalesforceSvc({ connection });
        } catch (error) {
          defaultSalesforceSvcPromise = null;
          return disabledSvc;
        }
      })();
    }

    return defaultSalesforceSvcPromise;
  };
};

let defaultCrmSvcPromise: Promise<CrmService> | null = null;

const createCrmGetter = (): (() => Promise<CrmService>) => {
  const disabledCrmSvc = createDisabledCrmSvc();

  if (env.salesforce.authMode === 'disabled') {
    return async () => disabledCrmSvc;
  }

  if (env.salesforce.authMode !== 'client-credentials') {
    throw new Error(`Unsupported Salesforce auth mode for CRM: ${env.salesforce.authMode}`);
  }

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
          logger.error('[StripeWebhook] CRM initialization failed:', message);
          return disabledCrmSvc;
        }
      })();
    }

    return defaultCrmSvcPromise;
  };
};

const sumRefundLineAmounts = (lines: { amountCents: number }[]): number =>
  lines.reduce((total, line) => total + Math.max(0, Math.trunc(line.amountCents || 0)), 0);

const createRefundReceiptAdapter = (): RefundReceiptAccountingAdapter => ({
  async upsertRefundReceipt(input) {
    const totalCents = sumRefundLineAmounts(input.lines ?? []);
    if (totalCents <= 0) {
      return null;
    }

    const result = await postRefundToQbo({
      amount: totalCents,
      memo: input.memo,
      date: input.txnDate,
    });

    return { id: result.qboId, type: result.type };
  },
});

const createPayoutAdapter = (): PayoutAccountingAdapter => ({
  async upsertDeposit(input) {
    const amountCents = Math.abs(Math.trunc(input.totalAmountCents ?? 0));
    if (amountCents <= 0) {
      return null;
    }

    const result = await postPayoutToQbo({
      amount: amountCents,
      memo: input.memo,
      date: input.txnDate,
      payoutId: input.payout?.id,
    });

    return { id: result.qboId, type: result.type };
  },
  async markDepositForReview() {
    return;
  },
});

const createDefaultDependencies = (): StripeWebhookDependencies => ({
  stripe: createStripeServices(),
  idempotencyStore:
    process.env.DISABLE_AZURE_TABLES === '1' ? createInMemoryStore() : new AzureIdempotencyStore(),
  getSalesforceSvc: createSalesforceGetter(),
  getCrmSvc: createCrmGetter(),
  accounting: {
    postChargeToQbo,
    postRefundToQbo,
    postDisputeToQbo,
    refundReceipts: createRefundReceiptAdapter(),
    payouts: createPayoutAdapter(),
  },
});

let dependencies: StripeWebhookDependencies | null = null;

const getDependencies = (): StripeWebhookDependencies => {
  if (!dependencies) {
    dependencies = createDefaultDependencies();
  }
  return dependencies;
};

const setDependencies = (overrides?: DependencyOverrides) => {
  if (overrides) {
    const defaultDeps = createDefaultDependencies();
    const mergedDeps: StripeWebhookDependencies = {
      stripe: { ...defaultDeps.stripe, ...overrides.stripe },
      idempotencyStore: overrides.idempotencyStore ?? defaultDeps.idempotencyStore,
      getSalesforceSvc: overrides.getSalesforceSvc ?? defaultDeps.getSalesforceSvc,
      getCrmSvc: overrides.getCrmSvc ?? defaultDeps.getCrmSvc,
      accounting: { ...defaultDeps.accounting, ...overrides.accounting },
    };
    serviceContainer.setTestDependencies(mergedDeps);
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
