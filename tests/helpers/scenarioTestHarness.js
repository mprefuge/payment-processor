const path = require('path');
const Module = require('module');

const additionalModulePath = path.join(__dirname, '..', 'node_modules');
const existingNodePath = process.env.NODE_PATH
  ? process.env.NODE_PATH.split(path.delimiter)
  : [];

const defaultEnv = {
  STRIPE_SECRET: 'sk_test_dummy',
  STRIPE_WEBHOOK_SECRET: 'whsec_dummy',
  SF_AUTH_MODE: 'disabled',
  ACCOUNTING_SYNC_ENABLED: 'true',
  ACCOUNTING_POSTING_STRATEGY: 'je-transfer',
  QBO_REALM_ID: '1234567890',
  QBO_CLIENT_ID: 'client-id',
  QBO_CLIENT_SECRET: 'client-secret',
  QBO_REFRESH_TOKEN: 'refresh-token',
  DISABLE_AZURE_TABLES: '1',
};

for (const [key, value] of Object.entries(defaultEnv)) {
  if (!process.env[key]) {
    process.env[key] = value;
  }
}

if (!existingNodePath.includes(additionalModulePath)) {
  process.env.NODE_PATH = [additionalModulePath, ...existingNodePath]
    .filter(Boolean)
    .join(path.delimiter);
  Module._initPaths();
}

let stripeWebhookModule;

try {
  require('ts-node/register/transpile-only');
  stripeWebhookModule = require('../../src/handlers/stripeWebhook');
} catch (sourceLoadError) {
  try {
    stripeWebhookModule = require('../../dist/handlers/stripeWebhook');
  } catch (distLoadError) {
    const error = new Error(
      'Unable to load Stripe webhook handler. Ensure ts-node is installed or run `npm run build` to generate dist files.',
    );
    error.sourceLoadError = sourceLoadError;
    error.distLoadError = distLoadError;
    throw error;
  }
}

const stripeWebhook =
  stripeWebhookModule && stripeWebhookModule.default
    ? stripeWebhookModule.default
    : stripeWebhookModule;

if (!stripeWebhook.__internals) {
  throw new Error('Stripe webhook handler does not expose internals for testing');
}

const parseEventPayload = (payload) => {
  if (typeof payload === 'string') {
    return JSON.parse(payload);
  }

  if (Buffer.isBuffer(payload)) {
    return JSON.parse(payload.toString('utf8'));
  }

  throw new Error('Unsupported payload type');
};

const createIdempotencyStore = (processedEvents) => ({
  async isProcessed(key) {
    return processedEvents.has(key);
  },
  async markProcessed(key) {
    processedEvents.add(key);
  },
  async withLock(_key, fn) {
    return await fn();
  },
  async flush() {},
});

const createMockSalesforce = (overrides = {}) => {
  const calls = {
    upserts: [],
    markPosted: [],
    findByCheckout: [],
    findByCharge: [],
  };

  const service = {
    async upsertTransactionByExternalId(dto, field, options) {
      calls.upserts.push({ dto, field, options });
      if (overrides.upsertTransactionByExternalId) {
        return await overrides.upsertTransactionByExternalId(dto, field, options);
      }
      return { id: overrides.transactionId || 'a00xx000000Scenario' };
    },
    async findTransactionIdByExternalId(field, value) {
      if (field === 'stripe_checkout_session_id__c') {
        calls.findByCheckout.push({ field, value });
        if (overrides.findCheckoutResult !== undefined) {
          return overrides.findCheckoutResult;
        }
      }

      if (field === 'stripe_charge_id__c') {
        calls.findByCharge.push({ field, value });
        if (overrides.findChargeResult !== undefined) {
          return overrides.findChargeResult;
        }
      }

      if (overrides.findTransactionIdByExternalId) {
        return await overrides.findTransactionIdByExternalId(field, value);
      }

      return null;
    },
    async markPostedToQbo(id, reference) {
      calls.markPosted.push({ id, reference });
      if (overrides.markPostedToQbo) {
        await overrides.markPostedToQbo(id, reference);
      }
    },
  };

  return { service, calls };
};

const createMockAccounting = (overrides = {}) => {
  const calls = [];

  const accounting = {
    async postChargeToQbo(payload) {
      calls.push({ type: 'charge', payload });
      if (overrides.postChargeToQbo) {
        return await overrides.postChargeToQbo(payload, calls);
      }
      return { qboId: 'qbo_charge_123', type: 'SalesReceipt' };
    },
    async postRefundToQbo(payload) {
      calls.push({ type: 'refund', payload });
      if (overrides.postRefundToQbo) {
        return await overrides.postRefundToQbo(payload, calls);
      }
      return { qboId: 'qbo_refund_123', type: 'JournalEntry' };
    },
    async postDisputeToQbo(payload) {
      calls.push({ type: 'dispute', payload });
      if (overrides.postDisputeToQbo) {
        return await overrides.postDisputeToQbo(payload, calls);
      }
      return { qboId: 'qbo_dispute_123', type: 'JournalEntry' };
    },
  };

  return { accounting, calls };
};

const runStripeEvents = async ({
  events,
  stripeClient,
  salesforceOverrides,
  accountingOverrides,
}) => {
  const processedEvents = new Set();
  const idempotencyStore = createIdempotencyStore(processedEvents);
  const { service: salesforce, calls: salesforceCalls } =
    createMockSalesforce(salesforceOverrides);
  const { accounting, calls: accountingCalls } = createMockAccounting(
    accountingOverrides,
  );

  const stripeServices = {
    verifyEvent(payload) {
      return parseEventPayload(payload);
    },
    getClient() {
      return stripeClient;
    },
  };

  stripeWebhook.__internals.setDependencies({
    stripe: stripeServices,
    idempotencyStore,
    getSalesforceSvc: async () => salesforce,
    accounting,
  });

  const responses = [];

  try {
    for (const event of events) {
      const context = {
        invocationId: `scenario-${event.id}`,
        log: (...args) => console.log('[context]', ...args),
      };

      const req = {
        headers: { 'stripe-signature': 'scenario-signature' },
        rawBody: JSON.stringify(event),
      };

      await stripeWebhook(context, req);
      responses.push({ eventId: event.id, response: context.res });
    }
  } finally {
    stripeWebhook.__internals.resetDependencies();
  }

  return {
    responses,
    processedEvents,
    salesforceCalls,
    accountingCalls,
  };
};

module.exports = {
  stripeWebhook,
  runStripeEvents,
};
