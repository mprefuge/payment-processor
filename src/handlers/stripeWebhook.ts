import Stripe from 'stripe';
import jsforce from 'jsforce';

import env from '../config/env';
import { logger } from '../lib/logger';
import { AzureIdempotencyStore, type IdempotencyStore } from '../services/idempotencyStore';
import { createSalesforceSvc, type SalesforceSvc } from '../services/salesforceSvc';
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
      // no-op
    },
  };
};

const createStripeServices = (): StripeWebhookDependencies['stripe'] => {
  // If TEST_MODE is enabled, use mock services instead of real Stripe API
  if (env.testMode) {
    return createMockStripeServices();
  }

  const defaultClient = new Stripe(env.stripe.secret, {
    apiVersion: STRIPE_API_VERSION,
  });

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

  return {
    verifyEvent: (payload, signature) =>
      defaultClient.webhooks.constructEvent(payload, signature, env.stripe.webhookSecret),
    getClient,
  };
};

let defaultSalesforceSvcPromise: Promise<SalesforceSvc> | null = null;

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
  };
};

const resolveSalesforceUsername = (): string | undefined =>
  env.salesforce.username ||
  process.env.SALESFORCE_USERNAME ||
  process.env.SF_USERNAME ||
  undefined;

const resolveSalesforcePassword = (): string | undefined =>
  process.env.SALESFORCE_PASSWORD || process.env.SF_PASSWORD || undefined;

const resolveSalesforceSecurityToken = (): string =>
  process.env.SALESFORCE_SECURITY_TOKEN || process.env.SF_SECURITY_TOKEN || '';

const resolveSalesforceLoginUrl = (): string =>
  env.salesforce.loginUrl ||
  process.env.SALESFORCE_LOGIN_URL ||
  process.env.SF_LOGIN_URL ||
  'https://login.salesforce.com';

const createSalesforceGetter = (): (() => Promise<SalesforceSvc>) => {
  const disabledSvc = createDisabledSalesforceSvc();

  if (env.salesforce.authMode === 'disabled') {
    return async () => disabledSvc;
  }

  if (env.salesforce.authMode !== 'username-password') {
    throw new Error(`Unsupported Salesforce auth mode: ${env.salesforce.authMode}`);
  }

  return async (): Promise<SalesforceSvc> => {
    if (!defaultSalesforceSvcPromise) {
      defaultSalesforceSvcPromise = (async () => {
        try {
          const username = resolveSalesforceUsername();
          const password = resolveSalesforcePassword();
          const securityToken = resolveSalesforceSecurityToken();
          const loginUrl = resolveSalesforceLoginUrl();

          if (!username || !password) {
            throw new Error('Salesforce credentials are not configured.');
          }

          const connection = new jsforce.Connection({ loginUrl });
          await connection.login(username, `${password}${securityToken}`);
          return createSalesforceSvc({ connection });
        } catch (error) {
          defaultSalesforceSvcPromise = null;

          const message =
            error instanceof Error ? error.message : 'Unknown Salesforce initialization error';
          // Falling back to disabled Salesforce service on initialization error
          // This prevents the webhook from failing when Salesforce is misconfigured

          return disabledSvc;
        }
      })();
    }

    return defaultSalesforceSvcPromise;
  };
};

let defaultCrmSvcPromise: any = null;

const createCrmGetter = (): (() => Promise<any>) => {
  if (env.salesforce.authMode === 'disabled') {
    // Return a disabled/mock CRM service
    return async () => ({
      async findOrCreateCampaign(name: string): Promise<string> {
        // In test/disabled mode, just return a fake ID
        return `701000000000000_${name}`;
      },
    });
  }

  if (env.salesforce.authMode !== 'username-password') {
    throw new Error(`Unsupported Salesforce auth mode for CRM: ${env.salesforce.authMode}`);
  }

  return async (): Promise<any> => {
    if (!defaultCrmSvcPromise) {
      defaultCrmSvcPromise = (async () => {
        try {
          const CrmFactory = require('../services/salesforce/crmFactory');
          const username = resolveSalesforceUsername();
          const password = resolveSalesforcePassword();
          const securityToken = resolveSalesforceSecurityToken();
          const loginUrl = resolveSalesforceLoginUrl();

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
          logger.error('[StripeWebhook] CRM initialization failed:', message);
          
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
  dependencies = null; // Reset to null so it's recreated on next call
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
