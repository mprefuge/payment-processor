import { app } from '@azure/functions';

import './preflight';
// Removed: import './config/env' - this causes startup failures if env vars are missing
// Each handler loads env as needed

const healthCheck = require('./handlers/healthCheck');
const processTransaction = require('./handlers/processTransaction');
const stripeWebhookModule = require('./handlers/stripeWebhook');
const stripeWebhook = stripeWebhookModule.default || stripeWebhookModule;
const payoutSyncTrigger = require('./handlers/payoutSyncTrigger');
const stripeTrueUpModule = require('./handlers/stripeTrueUp');
const stripeTrueUp = stripeTrueUpModule.default || stripeTrueUpModule;

// Register HTTP-triggered functions
app.http('healthCheck', {
  methods: ['GET'],
  route: 'health',
  authLevel: 'anonymous',
  handler: healthCheck,
});

app.http('processTransaction', {
  methods: ['POST'],
  route: 'transaction',
  authLevel: 'anonymous',
  handler: processTransaction,
});

app.http('stripeWebhook', {
  methods: ['POST'],
  route: 'stripe/webhook',
  authLevel: 'function',
  handler: stripeWebhook,
});

app.http('payoutSyncTrigger', {
  methods: ['POST'],
  route: 'stripe/payout-sync',
  authLevel: 'function',
  handler: payoutSyncTrigger,
});

app.http('stripeTrueUp', {
  methods: ['GET', 'POST'],
  route: 'stripe/true-up',
  authLevel: 'function',
  handler: stripeTrueUp,
});

// Export for testing
export { healthCheck, processTransaction, stripeWebhook, payoutSyncTrigger, stripeTrueUp };
