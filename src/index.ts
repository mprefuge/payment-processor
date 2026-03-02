import { app } from '@azure/functions';

import './preflight';

const healthCheck = require('./handlers/healthCheck');
const processTransaction = require('./handlers/processTransaction');
const stripeWebhookModule = require('./handlers/stripeWebhook');
const stripeWebhook = stripeWebhookModule.default || stripeWebhookModule;
const payoutSyncTrigger = require('./handlers/payoutSyncTrigger');
const stripeTrueUpModule = require('./handlers/stripeTrueUp');
const stripeTrueUp = stripeTrueUpModule.default || stripeTrueUpModule;
const manualQboSyncModule = require('./handlers/manualQboSync');
const manualQboSync = manualQboSyncModule.default || manualQboSyncModule;
const salesforcePaymentsSyncModule = require('./handlers/salesforcePaymentsSync');
const salesforcePaymentsSync =
  salesforcePaymentsSyncModule.default || salesforcePaymentsSyncModule;
const eventRegistrationModule = require('./handlers/eventRegistration');
const eventRegistration = eventRegistrationModule.default || eventRegistrationModule;
const eventCheckInModule = require('./handlers/eventCheckIn');
const eventCheckIn = eventCheckInModule.default || eventCheckInModule;

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

app.http('manualQboSync', {
  methods: ['POST'],
  route: 'qbo/manual-sync',
  authLevel: 'function',
  handler: manualQboSync,
});

app.http('salesforcePaymentsSync', {
  methods: ['GET', 'POST'],
  route: 'stripe/salesforce-payments-sync',
  authLevel: 'function',
  handler: salesforcePaymentsSync,
});

app.http('eventRegistration', {
  methods: ['POST'],
  route: 'events/register',
  authLevel: 'anonymous',
  handler: eventRegistration,
});

app.http('eventCheckIn', {
  methods: ['POST'],
  route: 'events/checkin',
  authLevel: 'function',
  handler: eventCheckIn,
});

app.http('eventConfig', {
  methods: ['GET'],
  route: 'events/config',
  authLevel: 'anonymous',
  handler: async (request, context) => {
    try {
      // Get Salesforce connection
      const CrmFactory = require('./services/salesforce/crmFactory');
      const crmConfig = {
        provider: 'salesforce',
        config: {
          clientId: process.env.SF_CLIENT_ID,
          clientSecret: process.env.SF_CLIENT_SECRET,
          loginUrl: process.env.SF_LOGIN_URL || 'https://login.salesforce.com',
        },
      };
      const crmService = CrmFactory.createCrmService(crmConfig.provider, crmConfig.config);
      const salesforceConnection = await crmService.authenticate();

      // Create event service and get active events
      const { createEventSvc } = require('./services/eventSvc');
      const { stripeClientFactory } = require('./services/stripeClientFactory');
      const stripeClient = stripeClientFactory.getClient(false);
      const eventSvc = createEventSvc({
        salesforceConnection,
        stripeClient,
      });

      const events = await eventSvc.getActiveEvents();

      // Load theme from static config (could also be made dynamic if needed)
      const staticConfig = require('./config/events.config.json');

      const eventConfig = {
        events,
        theme: staticConfig.theme,
        stripe: staticConfig.stripe,
        salesforce: staticConfig.salesforce,
      };

      return {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(eventConfig),
      };
    } catch (error) {
      context.error('Error loading event config:', error);
      return {
        status: 500,
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          error: 'Failed to load event configuration',
          details: error instanceof Error ? error.message : 'Unknown error',
        }),
      };
    }
  },
});

app.http('eventLandingPage', {
  methods: ['GET'],
  route: 'events',
  authLevel: 'anonymous',
  handler: async (request, context) => {
    const fs = require('fs');
    const path = require('path');
    const htmlPath = path.join(__dirname, 'public', 'event-registration.html');
    const html = fs.readFileSync(htmlPath, 'utf-8');
    return {
      status: 200,
      headers: {
        'Content-Type': 'text/html',
      },
      body: html,
    };
  },
});

// Export for testing
export {
  healthCheck,
  processTransaction,
  stripeWebhook,
  payoutSyncTrigger,
  stripeTrueUp,
  manualQboSync,
  salesforcePaymentsSync,
  eventRegistration,
  eventCheckIn,
};
