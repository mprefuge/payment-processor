import type { FunctionHandler } from '@azure/functions';

import './preflight';
import './config/env';

const healthCheck: FunctionHandler = require('./handlers/healthCheck');
const processTransaction: FunctionHandler = require('./handlers/processTransaction');
const stripeWebhook: FunctionHandler = require('./handlers/stripeWebhook');
const payoutSyncTrigger: FunctionHandler = require('./handlers/payoutSyncTrigger');
const stripeTrueUp: FunctionHandler = require('./handlers/stripeTrueUp');

export const handlers: Record<string, FunctionHandler> = {
  healthCheck,
  processTransaction,
  stripeWebhook,
  payoutSyncTrigger,
  stripeTrueUp,
};

export { healthCheck, processTransaction, stripeWebhook, payoutSyncTrigger, stripeTrueUp };
