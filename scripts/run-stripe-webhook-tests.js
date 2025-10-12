#!/usr/bin/env node
/*
 * Runs Stripe CLI triggers against the local Azure Functions host and verifies
 * webhook processing via Azure Table Storage idempotency entries.
 */

const { spawn } = require('child_process');
const path = require('path');
const process = require('process');
const Stripe = require('stripe').default;
const { TableClient } = require('@azure/data-tables');

const STRIPE_API_VERSION = '2023-10-16';
const DEFAULT_WEBHOOK_URL = 'http://127.0.0.1:7071/api/stripe/webhook';
const FUNCTION_START_TIMEOUT_MS = 120_000;
const EVENT_LOOKUP_TIMEOUT_MS = 120_000;
const TABLE_POLL_INTERVAL_MS = 2_000;
const EVENT_POLL_INTERVAL_MS = 2_000;
const FUNCTION_SHUTDOWN_TIMEOUT_MS = 10_000;

const requiredEnvVars = [
  'STRIPE_TEST_SECRET_KEY',
  'STRIPE_WEBHOOK_SECRET',
  'AZURE_TABLES_CONNECTION_STRING',
  'AzureWebJobsStorage',
];

const missingEnv = requiredEnvVars.filter((name) => {
  const value = process.env[name];
  return typeof value !== 'string' || value.trim().length === 0;
});

if (missingEnv.length > 0) {
  throw new Error(`Missing required environment variables: ${missingEnv.join(', ')}`);
}

const qboEnv = (process.env.QBO_ENV || '').toLowerCase();
if (qboEnv && qboEnv !== 'sandbox') {
  throw new Error(
    `Webhook tests must run against the QBO sandbox. Set QBO_ENV to "sandbox" instead of "${process.env.QBO_ENV}".`,
  );
}

const stripeSecretKey = process.env.STRIPE_TEST_SECRET_KEY;
const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
const tableName = process.env.IDEMPOTENCY_TABLE_NAME || 'IdempotencyState';
const processedPartitionKey = process.env.IDEMPOTENCY_PROCESSED_PARTITION || 'processed';
const webhookUrl = process.env.STRIPE_WEBHOOK_URL || DEFAULT_WEBHOOK_URL;

if (typeof fetch !== 'function') {
  throw new Error('Global fetch API is required (Node.js 18+).');
}

const stripe = new Stripe(stripeSecretKey, { apiVersion: STRIPE_API_VERSION });
const tableClient = TableClient.fromConnectionString(
  process.env.AZURE_TABLES_CONNECTION_STRING,
  tableName,
);

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let lastPayoutId = null;

const randomId = (prefix) =>
  `${prefix}_${Math.random().toString(36).slice(2, 10)}_${Date.now().toString(36)}`;

const cloneStripeObject = (obj) => JSON.parse(JSON.stringify(obj));

const waitForPaymentIntentStatus = async (paymentIntentId, targetStatus) => {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const pi = await stripe.paymentIntents.retrieve(paymentIntentId);
    if (pi?.status === targetStatus) {
      return pi;
    }
    await delay(1_000);
  }
  throw new Error(`Timed out waiting for PaymentIntent ${paymentIntentId} to reach status ${targetStatus}`);
};

const createConfirmedPaymentIntent = async (amountCents) => {
  const pi = await stripe.paymentIntents.create({
    amount: amountCents,
    currency: 'usd',
    payment_method: 'pm_card_visa',
    automatic_payment_methods: {
      enabled: true,
      allow_redirects: 'never',
    },
    confirm: true,
  });

  if (pi.status !== 'succeeded') {
    return waitForPaymentIntentStatus(pi.id, 'succeeded');
  }

  return pi;
};

const waitForAvailableBalance = async (minimumCents, currency = 'usd') => {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    const balance = await stripe.balance.retrieve();
    const available = Array.isArray(balance?.available)
      ? balance.available.find((entry) => entry.currency === currency)?.amount ?? 0
      : 0;
    if (available >= minimumCents) {
      return;
    }
    await delay(2_000);
  }
  throw new Error(`Stripe balance did not reach ${minimumCents} ${currency} in time.`);
};

const waitForPayoutStatus = async (payoutId, targetStatus) => {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    const payout = await stripe.payouts.retrieve(payoutId);
    if (payout?.status === targetStatus) {
      return payout;
    }
    await delay(2_000);
  }
  throw new Error(`Timed out waiting for payout ${payoutId} to reach status ${targetStatus}`);
};

const waitForPayoutTransactions = async (payoutId) => {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    const transactions = await stripe.balanceTransactions.list({ payout: payoutId, limit: 1 });
    if (Array.isArray(transactions?.data) && transactions.data.length > 0) {
      return;
    }
    await delay(2_000);
  }
  throw new Error(`Timed out waiting for balance transactions on payout ${payoutId}`);
};

const createTestPayout = async () => {
  const payoutAmountCents = 1_000;
  await createConfirmedPaymentIntent(4_000);
  await waitForAvailableBalance(payoutAmountCents);

  let payout;
  try {
    payout = await stripe.payouts.create({
      amount: payoutAmountCents,
      currency: 'usd',
      method: 'standard',
      statement_descriptor: 'Webhook Test',
    });
  } catch (error) {
    throw new Error(
      `Failed to create test payout. Ensure your Stripe test account has an external account configured. ${error?.message ?? error}`,
    );
  }

  const settled = await waitForPayoutStatus(payout.id, 'paid');
  await waitForPayoutTransactions(settled.id);
  lastPayoutId = settled.id;
  return settled;
};

const loadLastPayoutOrCreate = async () => {
  if (!lastPayoutId) {
    return createTestPayout();
  }
  try {
    const payout = await stripe.payouts.retrieve(lastPayoutId);
    await waitForPayoutTransactions(payout.id);
    return payout;
  } catch (error) {
    console.warn(
      `⚠️  Failed to reload payout ${lastPayoutId}, creating a new test payout instead. ${error?.message ?? error}`,
    );
    return createTestPayout();
  }
};

const buildSyntheticStripeEvent = (type, stripeObject) => ({
  id: randomId(`evt_${type.replace(/\./g, '_')}`),
  object: 'event',
  api_version: STRIPE_API_VERSION,
  created: Math.floor(Date.now() / 1000),
  data: {
    object: cloneStripeObject(stripeObject),
  },
  livemode: false,
  pending_webhooks: 0,
  request: {
    id: null,
    idempotency_key: null,
  },
  type,
});

const TRIGGERS = [
  { command: 'payment_intent.succeeded', eventType: 'payment_intent.succeeded' },
  { command: 'invoice.paid', eventType: 'invoice.paid' },
  { command: 'invoice.payment_failed', eventType: 'invoice.payment_failed' },
  {
    command: 'refund.created',
    eventType: 'refund.created',
    execute: async () => {
      const pi = await createConfirmedPaymentIntent(2_000);

      await stripe.refunds.create({
        payment_intent: pi.id,
        amount: 1_000,
      });
    },
  },
  {
    eventType: 'payout.paid',
    generateEvent: async () => {
      const payout = await createTestPayout();
      return buildSyntheticStripeEvent('payout.paid', payout);
    },
  },
  {
    eventType: 'payout.reconciliation_completed',
    generateEvent: async () => {
      const payout = await loadLastPayoutOrCreate();
      return buildSyntheticStripeEvent('payout.reconciliation_completed', payout);
    },
  },
];

const spawnAndCapture = (command, args, options = {}) => {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      ...options,
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => {
      const text = chunk.toString();
      stdout += text;
      process.stdout.write(text);
    });

    child.stderr.on('data', (chunk) => {
      const text = chunk.toString();
      stderr += text;
      process.stderr.write(text);
    });

    child.on('error', (error) => {
      reject(error);
    });

    child.on('close', (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        const error = new Error(`${command} ${args.join(' ')} exited with code ${code}`);
        error.stdout = stdout;
        error.stderr = stderr;
        error.code = code;
        reject(error);
      }
    });
  });
};

const startFunctionsHost = async () => {
  const env = {
    ...process.env,
    FUNCTIONS_WORKER_RUNTIME: process.env.FUNCTIONS_WORKER_RUNTIME || 'node',
    AzureWebJobsFeatureFlags: 'EnableWorkerIndexing',
    AzureWebJobsSecretStorageType: 'files',
    AzureFunctionsJobHost__Logging__Console__IsEnabled: 'true',
  };

  const args = ['start', '--verbose', 'false'];
  const child = spawn('func', args, {
    cwd: path.resolve(__dirname, '..'),
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const readyPromise = new Promise((resolve, reject) => {
    let resolved = false;
    const timeout = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        reject(new Error('Timed out waiting for Azure Functions host to start.'));
      }
    }, FUNCTION_START_TIMEOUT_MS);

    const handleReadyOutput = (data) => {
      const text = data.toString();
      process.stdout.write(text);
      if (/stripeWebhook:\s*\[POST]/.test(text) || /Host started/i.test(text)) {
        if (!resolved) {
          resolved = true;
          clearTimeout(timeout);
          resolve();
        }
      }
      if (/Failed to process event/.test(text)) {
        console.error(text);
      }
    };

    const handleErrorOutput = (data) => {
      const text = data.toString();
      process.stderr.write(text);
      if (/Exception|Unhandled|Error/i.test(text) && !resolved) {
        resolved = true;
        clearTimeout(timeout);
        reject(new Error(`Azure Functions host error: ${text}`));
      }
    };

    child.stdout.on('data', handleReadyOutput);
    child.stderr.on('data', handleErrorOutput);

    child.on('exit', (code) => {
      if (!resolved) {
        clearTimeout(timeout);
        reject(new Error(`Azure Functions host exited with code ${code ?? 'unknown'}`));
      }
    });
  });

  await readyPromise;
  return child;
};

const stopFunctionsHost = async (child) => {
  if (!child || child.exitCode !== null) {
    return;
  }
  child.kill('SIGINT');
  const start = Date.now();
  while (child.exitCode === null && Date.now() - start < FUNCTION_SHUTDOWN_TIMEOUT_MS) {
    await delay(200);
  }
  if (child.exitCode === null) {
    child.kill('SIGKILL');
  }
};

const ensureTableExists = async () => {
  try {
    await tableClient.createTable();
  } catch (error) {
    if (!(error && typeof error === 'object' && error.statusCode === 409)) {
      throw error;
    }
  }
};

const runStripeTrigger = async (eventName) => {
  const args = ['trigger', eventName];

  const env = {
    ...process.env,
    STRIPE_API_KEY: stripeSecretKey,
  };

  await spawnAndCapture('stripe', args, { env });
};

const deliverEventToWebhook = async (event) => {
  const payload = JSON.stringify(event);
  const signatureHeader = stripe.webhooks.generateTestHeaderString({
    payload,
    secret: webhookSecret,
  });

  const response = await fetch(webhookUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Stripe-Signature': signatureHeader,
    },
    body: payload,
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(
      `Stripe webhook endpoint ${webhookUrl} responded with ${response.status}: ${text}`,
    );
  }
};

const waitForStripeEvent = async (eventType, earliestCreated) => {
  const deadline = Date.now() + EVENT_LOOKUP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const events = await stripe.events.list({
      type: eventType,
      limit: 10,
      created: { gte: earliestCreated - 5 },
    });
    const match = events.data.find((event) => event.type === eventType && event.created >= earliestCreated - 5);
    if (match) {
      return match.id;
    }
    await delay(EVENT_POLL_INTERVAL_MS);
  }

  throw new Error(`Timed out waiting for Stripe to publish ${eventType}.`);
};

const waitForIdempotencyRecord = async (eventId) => {
  const rowKey = `evt_${eventId}`;
  const deadline = Date.now() + EVENT_LOOKUP_TIMEOUT_MS;

  while (Date.now() < deadline) {
    try {
      await tableClient.getEntity(processedPartitionKey, rowKey);
      return;
    } catch (error) {
      if (error && typeof error === 'object' && error.statusCode === 404) {
        await delay(TABLE_POLL_INTERVAL_MS);
        continue;
      }
      throw error;
    }
  }

  throw new Error(`Event ${eventId} was not marked as processed in table ${tableName}.`);
};

const runBuild = async () => {
  console.log('🧱 Building Functions bundle');
  await spawnAndCapture('npm', ['run', 'build'], { cwd: path.resolve(__dirname, '..') });
};

const main = async () => {
  await runBuild();

  console.log('➡️  Preparing idempotency table');
  await ensureTableExists();

  console.log('🚀 Starting Azure Functions host');
  const host = await startFunctionsHost();

  try {
    for (const trigger of TRIGGERS) {
      console.log(`\n▶️  Triggering ${trigger.command ?? trigger.eventType}`);
      let event;
      if (typeof trigger.generateEvent === 'function') {
        event = await trigger.generateEvent();
      } else {
        const startTime = Math.floor(Date.now() / 1000);
        if (typeof trigger.execute === 'function') {
          await trigger.execute();
        } else if (trigger.command) {
          await runStripeTrigger(trigger.command);
        } else {
          throw new Error(`Trigger for ${trigger.eventType} is missing a command or generator.`);
        }
        const eventId = await waitForStripeEvent(trigger.eventType, startTime);
        console.log(`ℹ️  Stripe generated event ${eventId} (${trigger.eventType})`);
        event = await stripe.events.retrieve(eventId);
      }

      if (!event || typeof event.id !== 'string') {
        throw new Error(`Failed to load event payload for ${trigger.eventType}`);
      }
      await deliverEventToWebhook(event);
      await waitForIdempotencyRecord(event.id);
      console.log(`✅ Webhook processed ${trigger.eventType} (${event.id})`);
    }
  } finally {
    console.log('\n🛑 Stopping Azure Functions host');
    await stopFunctionsHost(host);
  }
};

main().catch((error) => {
  console.error('❌ Stripe webhook e2e tests failed:', error);
  process.exitCode = 1;
});
