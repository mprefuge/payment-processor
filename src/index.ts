import { app } from '@azure/functions';
import {
  registerApiKeySecuritySchema,
  registerFunction,
  registerOpenAPIHandler,
  registerSwaggerUIHandler,
  OpenAPIObjectConfig,
} from 'azure-functions-openapi';
import { z } from 'zod';

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
const qboCustomersSyncModule = require('./handlers/qboCustomersSync');
const qboCustomersSync = qboCustomersSyncModule.default || qboCustomersSyncModule;
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
      url: '/',
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

const functionCodeQuerySecurity = registerApiKeySecuritySchema('code', 'query');
const functionKeyHeaderSecurity = registerApiKeySecuritySchema('x-functions-key', 'header');
const functionAuthSecurity = [functionCodeQuerySecurity, functionKeyHeaderSecurity];

const BoolLikeQuerySchema = z.enum(['true', 'false', '1', '0', 'yes', 'no', 'on', 'off']);
const PositiveIntLikeSchema = z.string().regex(/^\d+$/);
const ModeQuerySchema = z.enum(['test', 'live']);

const TransactionFrequencySchema = z.enum(['onetime', 'week', 'biweek', 'month', 'year']);
const AmountSchema = z.union([z.number().int().positive(), PositiveIntLikeSchema]);
const OptionalFeeAmountSchema = z
  .union([z.number().int().nonnegative(), PositiveIntLikeSchema])
  .optional();

const TransactionAddressSchema = z
  .object({
    line1: z.string().optional(),
    line2: z.string().optional(),
    city: z.string().optional(),
    state: z.string().optional(),
    postal_code: z.string().optional(),
    postalCode: z.string().optional(),
    country: z.string().optional(),
  })
  .passthrough();

const TransactionCustomerSchema = z
  .object({
    email: z.string().email(),
    firstname: z.string().optional(),
    lastname: z.string().optional(),
    firstName: z.string().optional(),
    lastName: z.string().optional(),
    phone: z.string().optional(),
    address: z.union([TransactionAddressSchema, z.string()]).optional(),
    city: z.string().optional(),
    state: z.string().optional(),
    zipcode: z.string().optional(),
    postalCode: z.string().optional(),
  })
  .passthrough();

const CommonTransactionFieldsSchema = {
  amount: AmountSchema,
  frequency: TransactionFrequencySchema,
  metadata: z.record(z.unknown()).optional(),
  attribution: z.string().optional(),
  coverFee: z.boolean().optional(),
  feeAmount: OptionalFeeAmountSchema,
  paymentMethod: z.enum(['card', 'card_present', 'us_bank_account', 'amex']).optional(),
  category: z.string().optional(),
  transactionType: z.string().optional(),
};

const ProcessTransactionRequestSchema = z.union([
  z
    .object({
      ...CommonTransactionFieldsSchema,
      customer: TransactionCustomerSchema,
    })
    .passthrough(),
  z
    .object({
      ...CommonTransactionFieldsSchema,
      email: z.string().email(),
      firstname: z.string().min(1),
      lastname: z.string().min(1),
      phone: z.string().optional(),
      address: z.union([TransactionAddressSchema, z.string()]).optional(),
      city: z.string().optional(),
      state: z.string().optional(),
      zipcode: z.string().optional(),
      postalCode: z.string().optional(),
    })
    .passthrough(),
]);

const StripeWebhookHeadersSchema = z
  .object({
    'stripe-signature': z.string().min(1),
  })
  .passthrough();

const PayoutSyncQuerySchema = z
  .object({
    lookbackDays: PositiveIntLikeSchema.optional(),
    mode: ModeQuerySchema.optional(),
  })
  .passthrough();

const StripeTrueUpQuerySchema = z
  .object({
    from: z.string().min(1),
    to: z.string().optional(),
    type: z.enum(['payments', 'refunds', 'payouts']).optional(),
    mode: ModeQuerySchema.optional(),
    dryRun: BoolLikeQuerySchema.optional(),
    resubmit: BoolLikeQuerySchema.optional(),
    bypassQbo: BoolLikeQuerySchema.optional(),
    skipQbo: BoolLikeQuerySchema.optional(),
    limit: PositiveIntLikeSchema.optional(),
  })
  .passthrough();

const ManualQboSyncRequestSchema = z
  .object({
    type: z.enum(['sales-receipt', 'journal-entry', 'bank-deposit']),
    data: z.record(z.unknown()),
  })
  .passthrough();

const SalesforcePaymentsSyncQuerySchema = z
  .object({
    mode: ModeQuerySchema.optional(),
    dryRun: BoolLikeQuerySchema.optional(),
    exampleLimit: PositiveIntLikeSchema.optional(),
    format: z.enum(['csv']).optional(),
    cursor: z.string().optional(),
    pageSize: PositiveIntLikeSchema.optional(),
    maxPages: PositiveIntLikeSchema.optional(),
    maxRuntimeMs: PositiveIntLikeSchema.optional(),
    maxRecords: PositiveIntLikeSchema.optional(),
    includeCustomerLookup: BoolLikeQuerySchema.optional(),
  })
  .passthrough();

const QboCustomersSyncQuerySchema = z
  .object({
    dryRun: BoolLikeQuerySchema.optional(),
    syncMode: z.enum(['create-and-update', 'create-only', 'update-only']).optional(),
    overwrite: BoolLikeQuerySchema.optional(),
    pageSize: PositiveIntLikeSchema.optional(),
    maxPages: PositiveIntLikeSchema.optional(),
    maxRuntimeMs: PositiveIntLikeSchema.optional(),
    includeInactive: BoolLikeQuerySchema.optional(),
    exampleLimit: PositiveIntLikeSchema.optional(),
  })
  .passthrough();

const documents = [
  registerOpenAPIHandler('anonymous', openAPIConfig, '3.1.0', 'json'),
  registerOpenAPIHandler('anonymous', openAPIConfig, '3.1.0', 'yaml'),
];

registerSwaggerUIHandler('anonymous', 'api', documents);

// Register HTTP-triggered functions
registerFunction('healthCheck', 'Returns overall health and integration statuses', {
  handler: healthCheck,
  description:
    'Use to validate connectivity to configured downstream dependencies and verify runtime health.',
  tags: ['Health'],
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
  description: 'Creates and processes a transaction request into downstream payment/CRM workflows.',
  tags: ['Transactions'],
  methods: ['POST'],
  authLevel: 'anonymous',
  azureFunctionRoutePrefix: 'api',
  route: 'transaction',
  request: {
    query: z
      .object({
        mode: ModeQuerySchema.optional(),
        livemode: BoolLikeQuerySchema.optional(),
      })
      .passthrough(),
    body: {
      content: {
        'application/json': { schema: ProcessTransactionRequestSchema },
      },
    },
  },
  responses: {
    200: { description: 'Transaction processed (checkout session created)' },
    400: { description: 'Invalid transaction payload' },
    500: { description: 'Processing error' },
  },
});

registerFunction('stripeWebhook', 'Stripe webhook receiver', {
  handler: stripeWebhook,
  description: 'Receives Stripe webhook events and routes them to the appropriate domain handlers.',
  tags: ['Stripe'],
  security: functionAuthSecurity,
  methods: ['POST'],
  authLevel: 'function',
  azureFunctionRoutePrefix: 'api',
  route: 'stripe/webhook',
  request: {
    headers: StripeWebhookHeadersSchema,
    body: {
      content: {
        'application/json': { schema: z.record(z.unknown()) },
      },
    },
  },
  responses: {
    200: { description: 'Webhook processed or duplicate acknowledged' },
    400: { description: 'Missing/invalid Stripe signature or invalid payload' },
  },
});

registerFunction('payoutSyncTrigger', 'Trigger payout sync with Stripe', {
  handler: payoutSyncTrigger,
  description: 'Manually triggers payout synchronization and reconciliation flow with Stripe/QBO.',
  tags: ['Stripe'],
  security: functionAuthSecurity,
  methods: ['POST'],
  authLevel: 'function',
  azureFunctionRoutePrefix: 'api',
  route: 'stripe/payout-sync',
  request: {
    query: PayoutSyncQuerySchema,
  },
  responses: {
    200: { description: 'Sync completed' },
    207: { description: 'Sync completed with partial errors' },
    500: { description: 'Sync failed' },
  },
});

registerFunction('stripeTrueUp', 'Stripe true‑up support', {
  handler: stripeTrueUp,
  description: 'Runs Stripe true-up operations for payment reconciliation.',
  tags: ['Stripe'],
  security: functionAuthSecurity,
  methods: ['GET', 'POST'],
  authLevel: 'function',
  azureFunctionRoutePrefix: 'api',
  route: 'stripe/true-up',
  request: {
    query: StripeTrueUpQuerySchema,
  },
  responses: {
    200: { description: 'True‑up operation complete' },
    400: { description: 'Invalid or missing query parameters' },
    500: { description: 'True‑up operation failed' },
  },
});

registerFunction('manualQboSync', 'Manually trigger QuickBooks Online sync', {
  handler: manualQboSync,
  description: 'Starts an on-demand QuickBooks Online synchronization cycle.',
  tags: ['QBO'],
  security: functionAuthSecurity,
  methods: ['POST'],
  authLevel: 'function',
  azureFunctionRoutePrefix: 'api',
  route: 'qbo/manual-sync',
  request: {
    body: {
      content: {
        'application/json': { schema: ManualQboSyncRequestSchema },
      },
    },
  },
  responses: {
    200: { description: 'QuickBooks manual sync succeeded' },
    400: { description: 'Invalid manual sync request' },
    500: { description: 'QuickBooks sync failure' },
  },
});

registerFunction('salesforcePaymentsSync', 'Salesforce payments synchronization', {
  handler: salesforcePaymentsSync,
  description: 'Triggers synchronization of payments from Stripe into Salesforce records.',
  tags: ['Salesforce'],
  security: functionAuthSecurity,
  methods: ['GET', 'POST'],
  authLevel: 'function',
  azureFunctionRoutePrefix: 'api',
  route: 'stripe/salesforce-payments-sync',
  request: {
    query: SalesforcePaymentsSyncQuerySchema,
  },
  responses: {
    200: { description: 'Sync succeeded' },
    500: { description: 'Sync failed' },
  },
});

registerFunction('qboCustomersSync', 'QBO customer sync to Salesforce contacts', {
  handler: qboCustomersSync,
  description:
    'Synchronizes QuickBooks Online customers into Salesforce Contacts with dry-run and duplicate checks.',
  tags: ['QBO', 'Salesforce'],
  security: functionAuthSecurity,
  methods: ['GET', 'POST'],
  authLevel: 'function',
  azureFunctionRoutePrefix: 'api',
  route: 'qbo/customers-salesforce-sync',
  request: {
    query: QboCustomersSyncQuerySchema,
  },
  responses: {
    200: { description: 'Customer sync completed' },
    500: { description: 'Customer sync failed' },
  },
});

// define simple event registration schema
const EventRegistrationSchema = z.object({
  eventId: z.string(),
  contact: z
    .object({
      email: z.string().email(),
      firstName: z.string(),
      lastName: z.string(),
      phone: z.string().optional(),
      company: z.string().optional(),
      mailingStreet: z.string().optional(),
      mailingCity: z.string().optional(),
      mailingState: z.string().optional(),
      mailingPostalCode: z.string().optional(),
      mailingCountry: z.string().optional(),
      customFields: z.record(z.unknown()).optional(),
    })
    .passthrough(),
  paymentMethodId: z.string().optional(),
  customFields: z.record(z.unknown()).optional(),
  notes: z.string().optional(),
});

registerFunction('eventRegistration', 'Register for an event', {
  handler: eventRegistration,
  description: 'Creates an event registration, including optional payment setup when required.',
  tags: ['Events'],
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
  description: 'Checks in an event registrant by registrationId or by email+eventId lookup.',
  tags: ['Events'],
  security: functionAuthSecurity,
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
  description: 'Returns currently active events and front-end theme/payment configuration.',
  tags: ['Events'],
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
  description: 'Serves the event registration landing page HTML document.',
  tags: ['Events'],
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
  qboCustomersSync,
  eventRegistration,
  eventCheckIn,
};

// expose the OpenAPI configuration/documents for testing or external use
export { openAPIConfig, documents };
