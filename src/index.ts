import { app } from '@azure/functions';
import { registerFunction, registerOpenAPIHandler, registerSwaggerUIHandler, OpenAPIObjectConfig } from 'azure-functions-openapi';
import { z } from 'zod';
import { transactionUpsertHttpBodySchema } from './domain/transactions';

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

// configure the Azure Functions runtime and add OpenAPI/Swagger support
app.setup({ enableHttpStream: true });

// OpenAPI configuration used by azure-functions-openapi
const openAPIConfig: OpenAPIObjectConfig = {
  info: {
    title: 'Payment Processor API',
    version: process.env.npm_package_version || '1.0.0',
    description: 'HTTP endpoints exposed by the payment processor function',
  },
  servers: [
    {
      url: '{protocol}://{host}/api',
      variables: {
        protocol: { default: 'https' },
        host: { default: 'localhost:7071' },
      },
    },
  ],
  tags: [
    { name: 'Health', description: 'Health check and diagnostics' },
    { name: 'Transactions', description: 'Transaction processing endpoints' },
    { name: 'Stripe', description: 'Stripe webhook and helper functions' },
    { name: 'QBO', description: 'QuickBooks Online sync endpoints' },
    { name: 'Salesforce', description: 'Salesforce sync endpoints' },
    { name: 'Events', description: 'Event registration and check‑in' },
  ],
};

const documents = [
  registerOpenAPIHandler('anonymous', openAPIConfig, '3.1.0', 'json'),
  registerOpenAPIHandler('anonymous', openAPIConfig, '3.1.0', 'yaml'),
];

registerSwaggerUIHandler('anonymous', 'api', documents);

// Register HTTP-triggered functions
registerFunction('healthCheck', 'Returns overall health and integration statuses', {
  handler: healthCheck,
  methods: ['GET'],
  authLevel: 'anonymous',
  azureFunctionRoutePrefix: 'api',
  route: 'health',
  responses: {
    200: { description: 'Service healthy' },
  },
});

// transaction endpoint expects a request body matching transactionUpsertHttpBodySchema
registerFunction('processTransaction', 'Process a payment transaction', {
  handler: processTransaction,
  methods: ['POST'],
  authLevel: 'anonymous',
  azureFunctionRoutePrefix: 'api',
  route: 'transaction',
  request: {
    body: {
      content: {
        'application/json': { schema: transactionUpsertHttpBodySchema },
      },
    },
  },
  responses: {
    200: { description: 'Transaction processed' },
    400: { description: 'Invalid transaction payload' },
  },
});

registerFunction('stripeWebhook', 'Stripe webhook receiver', {
  handler: stripeWebhook,
  methods: ['POST'],
  authLevel: 'function',
  azureFunctionRoutePrefix: 'api',
  route: 'stripe/webhook',
  responses: { 200: { description: 'Webhook received' } },
});

registerFunction('payoutSyncTrigger', 'Trigger payout sync with Stripe', {
  handler: payoutSyncTrigger,
  methods: ['POST'],
  authLevel: 'function',
  azureFunctionRoutePrefix: 'api',
  route: 'stripe/payout-sync',
  responses: { 200: { description: 'Sync initiated' } },
});

registerFunction('stripeTrueUp', 'Stripe true‑up support', {
  handler: stripeTrueUp,
  methods: ['GET', 'POST'],
  authLevel: 'function',
  azureFunctionRoutePrefix: 'api',
  route: 'stripe/true-up',
  responses: { 200: { description: 'True‑up operation complete' } },
});

registerFunction('manualQboSync', 'Manually trigger QuickBooks Online sync', {
  handler: manualQboSync,
  methods: ['POST'],
  authLevel: 'function',
  azureFunctionRoutePrefix: 'api',
  route: 'qbo/manual-sync',
  responses: { 200: { description: 'Sync started' } },
});

registerFunction('salesforcePaymentsSync', 'Salesforce payments synchronization', {
  handler: salesforcePaymentsSync,
  methods: ['GET', 'POST'],
  authLevel: 'function',
  azureFunctionRoutePrefix: 'api',
  route: 'stripe/salesforce-payments-sync',
  responses: { 200: { description: 'Sync success' } },
});

// define simple event registration schema
const EventRegistrationSchema = z.object({
  eventId: z.string(),
  contact: z.object({
    email: z.string().email(),
    firstName: z.string(),
    lastName: z.string(),
  }).passthrough(),
  paymentMethodId: z.string().optional(),
  customFields: z.record(z.any()).optional(),
  notes: z.string().optional(),
});

registerFunction('eventRegistration', 'Register for an event', {
  handler: eventRegistration,
  methods: ['POST'],
  authLevel: 'anonymous',
  azureFunctionRoutePrefix: 'api',
  route: 'events/register',
  request: {
    body: { content: { 'application/json': { schema: EventRegistrationSchema } } },
  },
  responses: {
    200: { description: 'Registration successful' },
    400: { description: 'Invalid request' },
    404: { description: 'Event not found' },
  },
});

const EventCheckInSchema = z
  .object({
    registrationId: z.string().optional(),
    email: z.string().email().optional(),
    eventId: z.string().optional(),
  })
  .refine(
    (data) => !!data.registrationId || (data.email && data.eventId),
    {
      message: 'registrationId or both email and eventId must be supplied',
    }
  );

registerFunction('eventCheckIn', 'Check in an event attendee', {
  handler: eventCheckIn,
  methods: ['POST'],
  authLevel: 'function',
  azureFunctionRoutePrefix: 'api',
  route: 'events/checkin',
  request: { body: { content: { 'application/json': { schema: EventCheckInSchema } } } },
  responses: { 200: { description: 'Check‑in outcome' }, 400: { description: 'Bad request' } },
});

registerFunction('eventConfig', 'Retrieve event configuration with theme', {
  handler: async (request: any, context: any) => {
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
  azureFunctionRoutePrefix: 'api',
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'events/config',
  responses: { 200: { description: 'Configuration object' }, 500: { description: 'Server error' } },
});

registerFunction('eventLandingPage', 'Serve static event landing page html', {
  handler: async (request: any, context: any) => {
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
  azureFunctionRoutePrefix: 'api',
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'events',
  responses: { 200: { description: 'HTML landing page' } },
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

// expose the OpenAPI configuration/documents for testing or external use
export { openAPIConfig, documents };
