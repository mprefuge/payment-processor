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

const loadHandler = (modulePath: string): any => {
  const loadedModule = require(modulePath);
  return loadedModule.default || loadedModule;
};

const healthCheck = loadHandler('./handlers/healthCheck');
const processTransaction = loadHandler('./handlers/processTransaction');
const stripeWebhook = loadHandler('./handlers/stripeWebhook');
const payoutSyncTrigger = loadHandler('./handlers/payoutSyncTrigger');
const stripeTrueUp = loadHandler('./handlers/stripeTrueUp');
const manualQboSync = loadHandler('./handlers/manualQboSync');
const salesforcePaymentsSync = loadHandler('./handlers/salesforcePaymentsSync');
const qboCustomersSync = loadHandler('./handlers/qboCustomersSync');
const salesforceRecordQboSync = loadHandler('./handlers/salesforceRecordQboSync');
const qboReceiptsSync = loadHandler('./handlers/qboReceiptsSync');
const testArtifactCleanup = loadHandler('./handlers/testArtifactCleanup');
const stripeDuplicateCheck = loadHandler('./handlers/stripeDuplicateCheck');
const donationFormBuilder = loadHandler('./handlers/donationFormBuilder');
const donationFormConfigSave = loadHandler('./handlers/donationFormConfigSave');
const donationFormConfigUpdate = loadHandler('./handlers/donationFormConfigUpdate');
const donationFormConfigList = loadHandler('./handlers/donationFormConfigList');
const donationFormConfigGet = loadHandler('./handlers/donationFormConfigGet');
const donationFormConfigDelete = loadHandler('./handlers/donationFormConfigDelete');
const donationFormEmbed = loadHandler('./handlers/donationFormEmbed');
const donationFormSfObjects = loadHandler('./handlers/donationFormSfObjects');
const donationFormSfFields = loadHandler('./handlers/donationFormSfFields');

// configure the Azure Functions runtime and add OpenAPI/Swagger support
app.setup({ enableHttpStream: true });

// OpenAPI configuration used by azure-functions-openapi
const SWAGGER_UI_ROUTE = 'swagger';
const OPENAPI_VERSION = '3.1.0';

const functionAuthInstructions =
  'Protected operations require an Azure Functions host key. In Swagger UI, use either the `x-functions-key` header or the `code` query parameter. ' +
  'For Stripe-affecting operations, prefer test mode first (`mode=test`, `livemode=false`, or equivalent query flags) before validating live-mode behavior.';

const openAPIConfig: OpenAPIObjectConfig = {
  info: {
    title: 'Payment Processor API',
    version: process.env.npm_package_version || '1.0.0',
    description:
      'HTTP endpoints exposed by the payment processor Azure Function. This Swagger surface is intended for post-deployment validation of health, payment flows, reconciliation jobs, and external-system sync paths.\n\n' +
      functionAuthInstructions,
  },
  servers: [
    {
      url: '/',
    },
  ],
  externalDocs: {
    description: 'Deployment checklist and environment requirements',
    url: '/docs/ENVIRONMENT_VARIABLES.md',
  },
  tags: [
    { name: 'Health', description: 'Health check and diagnostics' },
    { name: 'Transactions', description: 'Transaction processing endpoints' },
    { name: 'Stripe', description: 'Stripe webhook and helper functions' },
    { name: 'QBO', description: 'QuickBooks Online sync endpoints' },
    { name: 'Salesforce', description: 'Salesforce sync endpoints' },
    { name: 'Builder', description: 'Donation form builder and embed endpoints' },
  ],
};

const API_ROUTE_PREFIX = 'api';

const functionCodeQuerySecurity = registerApiKeySecuritySchema('code', 'query');
const functionKeyHeaderSecurity = registerApiKeySecuritySchema('x-functions-key', 'header');
const functionAuthSecurity = [functionCodeQuerySecurity, functionKeyHeaderSecurity];

const withAnonymousAuth = <T extends Record<string, unknown>>(options: T) => ({
  authLevel: 'anonymous' as const,
  azureFunctionRoutePrefix: API_ROUTE_PREFIX,
  ...options,
});

const withFunctionAuth = <T extends Record<string, unknown>>(options: T) => ({
  security: functionAuthSecurity,
  authLevel: 'function' as const,
  azureFunctionRoutePrefix: API_ROUTE_PREFIX,
  ...options,
});

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

const TestArtifactCleanupRequestSchema = z
  .object({
    tag: z.string().min(1),
    dryRun: z.boolean().optional(),
    liveMode: z.boolean().optional(),
    systems: z.array(z.enum(['stripe', 'salesforce', 'qbo'])).optional(),
    deleteSalesforceContacts: z.boolean().optional(),
    maxStripeCustomers: z.number().int().positive().max(500).optional(),
    maxQboDocuments: z.number().int().positive().max(500).optional(),
  })
  .passthrough();

const SalesforcePaymentsSyncQuerySchema = z
  .object({
    mode: ModeQuerySchema.optional(),
    dryRun: BoolLikeQuerySchema.optional(),
    salesforceId: z.string().optional(),
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

const SalesforceRecordQboSyncQuerySchema = z
  .object({
    salesforceId: z.string(),
    dryRun: BoolLikeQuerySchema.optional(),
    importQboReceipts: BoolLikeQuerySchema.optional(),
    debug: BoolLikeQuerySchema.optional(),
  })
  .passthrough();

const QboReceiptsSyncQuerySchema = z
  .object({
    dryRun: BoolLikeQuerySchema.optional(),
    debug: BoolLikeQuerySchema.optional(),
    limit: PositiveIntLikeSchema.optional(),
    start_date: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional(),
    end_date: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional(),
    start_position: PositiveIntLikeSchema.optional(),
    max_results: PositiveIntLikeSchema.optional(),
  })
  .passthrough();

const StripeDuplicateCheckQuerySchema = z
  .object({
    system: z.enum(['qbo', 'salesforce', 'both']).optional(),
    deleteDuplicates: BoolLikeQuerySchema.optional(),
    dryRun: BoolLikeQuerySchema.optional(),
    startDate: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional(),
    endDate: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional(),
  })
  .passthrough();

const GenericObjectSchema = z.record(z.unknown());
const GenericSuccessResponseSchema = z
  .object({
    success: z.boolean(),
  })
  .passthrough();
const GenericErrorResponseSchema = z
  .object({
    error: z.string(),
    message: z.string().optional(),
    details: z.unknown().optional(),
  })
  .passthrough();
const TransactionCreatedResponseSchema = z
  .object({
    url: z.string(),
    id: z.string(),
  })
  .passthrough();

const asNamedExample = (summary: string, value: unknown, description?: string) => ({
  summary,
  description,
  value,
});

const processTransactionExample = {
  amount: 5000,
  frequency: 'onetime',
  attribution: 'Annual Fund',
  metadata: {
    campaign: 'Annual Fund',
    source_test_tag: 'deployment-smoke',
  },
  customer: {
    email: 'micah.test@example.com',
    firstname: 'Micah',
    lastname: 'Test',
    phone: '555-0100',
    address: {
      line1: '123 Main St',
      city: 'Anytown',
      state: 'CA',
      postal_code: '12345',
      country: 'US',
    },
  },
};

const recurringTransactionExample = {
  amount: 2500,
  frequency: 'month',
  attribution: 'Monthly Partners',
  category: 'Recurring Giving',
  transactionType: 'Monthly Donation',
  customer: {
    email: 'micah.test.recurring@example.com',
    firstname: 'Micah',
    lastname: 'Recurring',
    phone: '555-0101',
    address: {
      line1: '456 Oak Ave',
      city: 'Austin',
      state: 'TX',
      postal_code: '78701',
      country: 'US',
    },
  },
  metadata: {
    campaign: 'Monthly Partners',
    source_test_tag: 'swagger-recurring',
  },
};

const coverFeeTransactionExample = {
  amount: 10000,
  frequency: 'onetime',
  coverFee: true,
  feeAmount: 325,
  attribution: 'Gala Sponsorship',
  customer: {
    email: 'micah.test.coverfee@example.com',
    firstname: 'Micah',
    lastname: 'CoverFee',
    phone: '555-0102',
    address: {
      line1: '789 Pine Rd',
      city: 'Denver',
      state: 'CO',
      postal_code: '80202',
      country: 'US',
    },
  },
  metadata: {
    campaign: 'Spring Gala',
    source_test_tag: 'swagger-cover-fees',
  },
};

const qboOverrideTransactionExample = {
  amount: 9050,
  frequency: 'onetime',
  attribution: 'Events',
  category: 'Events',
  transactionType: 'Ticket Purchase',
  customer: {
    email: 'micah.test.qbo@example.com',
    firstname: 'Micah',
    lastname: 'QboOverride',
  },
  metadata: {
    campaign: 'Benefit Dinner',
    source_test_tag: 'swagger-qbo-overrides',
    qbo_product_service: 'Event Revenue|QBO_ITEM_EVENT',
    qbo_description: 'Benefit dinner ticket',
    qbo_quantity: '2',
    qbo_rate: '45.25',
    qbo_amount: '90.50',
    qbo_service_date: '2026-04-05',
    qbo_class_ref: 'Events|QBO_CLASS_EVENTS',
  },
};

const processTransactionExamples = {
  oneTimeDonation: asNamedExample(
    'One-time donation',
    processTransactionExample,
    'Baseline deployed smoke test for checkout session creation.'
  ),
  recurringDonation: asNamedExample(
    'Recurring donation',
    recurringTransactionExample,
    'Validates recurring frequency and monthly giving setup.'
  ),
  coverFees: asNamedExample(
    'Cover fees donation',
    coverFeeTransactionExample,
    'Exercises cover-fee calculation and metadata propagation.'
  ),
  qboOverrides: asNamedExample(
    'QBO sales receipt overrides',
    qboOverrideTransactionExample,
    'Exercises QuickBooks sales-receipt override metadata for item, class, quantity, rate, and service date.'
  ),
};

const processTransactionResponseExample = {
  id: 'cs_test_123',
  url: 'https://checkout.stripe.com/c/pay/cs_test_123',
};

const healthCheckResponseExample = {
  status: 'healthy',
  timestamp: '2026-04-05T15:20:00.000Z',
  integrations: {
    stripe: { ok: true },
    salesforce: { ok: true },
    quickbooks: { ok: true },
  },
};

const payoutSyncResponseExample = {
  summary: {
    lookbackDays: 7,
    total: 3,
    processed: 3,
    skipped: 0,
    errors: 0,
  },
  processed: [{ payoutId: 'po_123', status: 'processed' }],
  skipped: [],
  errors: [],
};

const payoutSyncResponseWithErrorsExample = {
  ...payoutSyncResponseExample,
  summary: {
    ...payoutSyncResponseExample.summary,
    errors: 1,
  },
  errors: [{ payoutId: 'po_456', message: 'Salesforce update failed' }],
};

const stripeWebhookEventExample = {
  id: 'evt_123',
  object: 'event',
  type: 'payment_intent.succeeded',
  livemode: false,
  data: {
    object: {
      id: 'pi_123',
      object: 'payment_intent',
      amount: 5000,
      currency: 'usd',
      status: 'succeeded',
    },
  },
};

const stripeTrueUpResponseExample = {
  type: 'payments',
  dryRun: true,
  resubmit: false,
  bypassQbo: false,
  limit: 25,
  liveMode: false,
  range: {
    from: '2026-04-01T00:00:00.000Z',
    to: '2026-04-05T00:00:00.000Z',
  },
  counts: {
    fetched: 10,
    processed: 10,
    skipped: 0,
    salesforceUpdates: 10,
    qboPosts: 10,
    errors: 0,
  },
};

const stripeTrueUpPaymentsExample = {
  from: '2026-04-01T00:00:00Z',
  to: '2026-04-05T00:00:00Z',
  type: 'payments',
  mode: 'test',
  dryRun: 'true',
  resubmit: 'false',
  limit: '25',
};

const stripeTrueUpRefundsExample = {
  from: '2026-04-01T00:00:00Z',
  to: '2026-04-05T00:00:00Z',
  type: 'refunds',
  mode: 'test',
  dryRun: 'true',
  resubmit: 'true',
  bypassQbo: 'true',
  limit: '10',
};

const stripeTrueUpPayoutsExample = {
  from: '2026-04-01T00:00:00Z',
  to: '2026-04-05T00:00:00Z',
  type: 'payouts',
  mode: 'test',
  dryRun: 'true',
  limit: '10',
};

const manualQboSyncExample = {
  type: 'sales-receipt',
  data: {
    DocNumber: 'MANUAL-1001',
    TxnDate: '2026-04-05',
    PrivateNote: 'Manual Swagger verification',
    CustomerRef: { name: 'Micah Test', value: '123' },
    Line: [
      {
        Amount: 50,
        DetailType: 'SalesItemLineDetail',
        Description: 'Swagger validation receipt',
        SalesItemLineDetail: {
          ItemRef: { name: 'Donation', value: '45' },
          Qty: 1,
          UnitPrice: 50,
        },
      },
    ],
  },
};

const manualQboJournalEntryExample = {
  type: 'journal-entry',
  data: {
    DocNumber: 'MANUAL-JE-1001',
    TxnDate: '2026-04-05',
    PrivateNote: 'Manual Swagger journal entry validation',
    Line: [
      {
        Amount: 100,
        DetailType: 'JournalEntryLineDetail',
        Description: 'Revenue',
        JournalEntryLineDetail: {
          PostingType: 'Credit',
          AccountRef: { name: 'Revenue', value: '200' },
        },
      },
      {
        Amount: 100,
        DetailType: 'JournalEntryLineDetail',
        Description: 'Stripe Clearing',
        JournalEntryLineDetail: {
          PostingType: 'Debit',
          AccountRef: { name: 'Stripe Clearing', value: '201' },
        },
      },
    ],
  },
};

const manualQboBankDepositExample = {
  type: 'bank-deposit',
  data: {
    DocNumber: 'MANUAL-DEP-1001',
    TxnDate: '2026-04-05',
    PrivateNote: 'Manual Swagger bank deposit validation',
    DepositToAccountRef: { name: 'Operating Bank', value: '300' },
    Line: [
      {
        Amount: 250,
        DetailType: 'DepositLineDetail',
        Description: 'Stripe payout deposit',
        DepositLineDetail: {
          AccountRef: { name: 'Stripe Clearing', value: '301' },
        },
      },
    ],
  },
};

const manualQboSyncExamples = {
  salesReceipt: asNamedExample(
    'Sales receipt',
    manualQboSyncExample,
    'Creates a manual sales receipt in QuickBooks.'
  ),
  journalEntry: asNamedExample(
    'Journal entry',
    manualQboJournalEntryExample,
    'Creates a manual journal entry for accounting validation.'
  ),
  bankDeposit: asNamedExample(
    'Bank deposit',
    manualQboBankDepositExample,
    'Creates a manual bank deposit for payout validation.'
  ),
};

const manualQboSyncResponseExample = {
  success: true,
  type: 'sales-receipt',
  result: {
    id: '987',
  },
};

const cleanupExample = {
  tag: 'deployment-smoke-20260405',
  dryRun: true,
  systems: ['stripe', 'salesforce', 'qbo'],
  deleteSalesforceContacts: true,
  maxStripeCustomers: 25,
  maxQboDocuments: 25,
};

const cleanupLiveDeleteExample = {
  tag: 'deployment-smoke-20260405',
  dryRun: false,
  systems: ['stripe', 'salesforce', 'qbo'],
  deleteSalesforceContacts: true,
  maxStripeCustomers: 100,
  maxQboDocuments: 100,
};

const cleanupExamples = {
  dryRun: asNamedExample(
    'Dry-run cleanup',
    cleanupExample,
    'Preview tagged artifacts before deleting them.'
  ),
  delete: asNamedExample(
    'Delete tagged artifacts',
    cleanupLiveDeleteExample,
    'Actually removes tagged test artifacts after validation completes.'
  ),
};

const cleanupResponseExample = {
  success: true,
  dryRun: true,
  summary: {
    stripe: { matched: 2, deleted: 0 },
    salesforce: { matched: 1, deleted: 0 },
    qbo: { matched: 1, deleted: 0 },
  },
  errors: [],
};

const salesforcePaymentsSyncResponseExample = {
  success: true,
  dryRun: true,
  testMode: true,
  dryRunForcedByTestMode: false,
  pagination: {
    pageSize: 100,
    maxPages: 1,
    maxRuntimeMs: 30000,
    maxRecords: 100,
    pagesProcessed: 1,
    recordsProcessed: 3,
    requestedCursor: null,
    nextCursor: null,
    hasMore: false,
    stopReason: 'completed',
    continuationRecommended: false,
  },
  paymentCount: 3,
  counts: {
    totalPayments: 3,
  },
  examplePayloads: [],
  errors: [],
};

const salesforcePaymentsSyncCsvResponseExample = {
  status: 200,
  headers: {
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': 'attachment; filename="stripe-payments-export-20260405.csv"',
    'X-Has-More': 'false',
    'X-Next-Cursor': '',
    'X-Stop-Reason': 'completed',
  },
};

const qboCustomersSyncResponseExample = {
  success: true,
  dryRun: true,
  syncMode: 'create-and-update',
  overwrite: false,
  pagination: {
    pageSize: 250,
    maxPages: 1,
    pagesProcessed: 1,
    hasMore: false,
    nextStartPosition: null,
    stopReason: 'completed',
  },
  counts: {
    totalQboCustomers: 12,
    alreadyExistInSalesforce: 7,
    notInSalesforce: 5,
    willBeCreated: 5,
    wouldUpdate: 2,
    duplicateConflicts: 0,
    created: 0,
    updated: 0,
    skippedByMode: 0,
    errors: 0,
  },
  samples: {
    duplicates: [],
    willCreate: [],
    matched: [],
    errors: [],
  },
};

const qboCustomersSyncCreateOnlyResponseExample = {
  ...qboCustomersSyncResponseExample,
  syncMode: 'create-only',
  counts: {
    ...qboCustomersSyncResponseExample.counts,
    alreadyExistInSalesforce: 4,
    notInSalesforce: 8,
    willBeCreated: 8,
    wouldUpdate: 0,
    skippedByMode: 4,
  },
};

const qboReceiptsSyncResponseExample = {
  success: true,
  dryRun: true,
  debug: false,
  limit: 25,
  startDate: '2026-04-01',
  endDate: '2026-04-05',
  startPosition: 1,
  maxResults: 200,
  summary: {
    processedCount: 4,
    plannedCount: 2,
    syncedCount: 0,
    alreadySyncedCount: 1,
    noCustomerSalesforceIdCount: 1,
    noSalesforceRecordCount: 0,
    skippedCount: 0,
    errorCount: 0,
    results: [],
  },
};

const qboReceiptsSyncLiveResponseExample = {
  ...qboReceiptsSyncResponseExample,
  dryRun: false,
  summary: {
    ...qboReceiptsSyncResponseExample.summary,
    syncedCount: 2,
    plannedCount: 2,
  },
};

const salesforceRecordQboSyncResponseExample = {
  success: true,
  dryRun: true,
  importQboReceipts: false,
  debug: false,
  summary: {
    resolvedSalesforceObjectType: 'Contact',
    linkedQuickBooksCustomerId: '456',
    conflicts: [],
    transactionMatches: [],
    manualReviewItems: [],
  },
};

const salesforceRecordQboSyncImportReceiptsResponseExample = {
  ...salesforceRecordQboSyncResponseExample,
  importQboReceipts: true,
  summary: {
    ...salesforceRecordQboSyncResponseExample.summary,
    transactionMatches: [{ source: 'receipt', action: 'imported' }],
  },
};

const documents = ['json', 'yaml'].map((format) =>
  registerOpenAPIHandler('anonymous', openAPIConfig, OPENAPI_VERSION, format as 'json' | 'yaml')
);

registerSwaggerUIHandler('anonymous', API_ROUTE_PREFIX, documents, {
  route: SWAGGER_UI_ROUTE,
});

// Register HTTP-triggered functions
registerFunction('healthCheck', 'Returns overall health and integration statuses', {
  handler: healthCheck,
  description:
    'Use to validate connectivity to configured downstream dependencies and verify runtime health. This is the recommended first check after deployment.',
  tags: ['Health'],
  operationId: 'healthCheck',
  methods: ['GET'],
  ...withAnonymousAuth({}),
  route: 'health',
  responses: {
    200: {
      description: 'Service healthy',
      content: {
        'application/json': {
          schema: GenericObjectSchema,
          example: healthCheckResponseExample,
        },
      },
    },
  },
});

registerFunction('donationFormBuilder', 'Render the drag-and-drop donation form builder UI', {
  handler: donationFormBuilder,
  description:
    'Serves a self-contained WYSIWYG builder for composing a hosted donation form configuration and publishing an embed-ready config URL.',
  tags: ['Builder'],
  operationId: 'donationFormBuilder',
  methods: ['GET'],
  ...withAnonymousAuth({}),
  route: 'form-builder',
  responses: {
    200: {
      description: 'Builder HTML page',
      content: {
        'text/html': {
          schema: z.string(),
        },
      },
    },
  },
});

registerFunction('donationFormConfigSave', 'Save a donation form configuration', {
  handler: donationFormConfigSave,
  description:
    'Persists a donation form configuration and returns the configuration URL plus a ready-to-paste embed snippet.',
  tags: ['Builder'],
  operationId: 'donationFormConfigSave',
  methods: ['POST'],
  ...withFunctionAuth({}),
  route: 'form-builder/configs',
  responses: {
    201: {
      description: 'Config saved',
      content: {
        'application/json': {
          schema: GenericSuccessResponseSchema,
        },
      },
    },
  },
});

registerFunction('donationFormConfigList', 'List published donation form configurations', {
  handler: donationFormConfigList,
  description:
    'Returns a list of existing donation form configurations so they can be selected and edited in the builder.',
  tags: ['Builder'],
  operationId: 'donationFormConfigList',
  methods: ['GET'],
  ...withAnonymousAuth({}),
  route: 'form-builder/configs',
  responses: {
    200: {
      description: 'Config list',
      content: {
        'application/json': {
          schema: GenericSuccessResponseSchema,
        },
      },
    },
  },
});

registerFunction('donationFormConfigGet', 'Fetch a published donation form configuration', {
  handler: donationFormConfigGet,
  description: 'Returns a previously published donation form configuration as JSON.',
  tags: ['Builder'],
  operationId: 'donationFormConfigGet',
  methods: ['GET'],
  ...withAnonymousAuth({}),
  route: 'form-builder/configs/{configId}',
  responses: {
    200: {
      description: 'Config JSON',
      content: {
        'application/json': {
          schema: GenericSuccessResponseSchema,
        },
      },
    },
    404: {
      description: 'Config not found',
      content: {
        'application/json': {
          schema: GenericErrorResponseSchema,
        },
      },
    },
  },
});

registerFunction('donationFormConfigDelete', 'Delete a published donation form configuration', {
  handler: donationFormConfigDelete,
  description: 'Deletes a previously published donation form configuration.',
  tags: ['Builder'],
  operationId: 'donationFormConfigDelete',
  methods: ['DELETE'],
  ...withFunctionAuth({}),
  route: 'form-builder/configs/{configId}',
  responses: {
    200: {
      description: 'Config deleted',
      content: {
        'application/json': {
          schema: GenericSuccessResponseSchema,
        },
      },
    },
    404: {
      description: 'Config not found',
      content: {
        'application/json': {
          schema: GenericErrorResponseSchema,
        },
      },
    },
  },
});

registerFunction('donationFormConfigUpdate', 'Update an existing donation form configuration', {
  handler: donationFormConfigUpdate,
  description: 'Updates a previously saved donation form configuration by ID.',
  tags: ['Builder'],
  operationId: 'donationFormConfigUpdate',
  methods: ['PUT'],
  ...withFunctionAuth({}),
  route: 'form-builder/configs/{configId}',
  responses: {
    200: {
      description: 'Config updated',
      content: {
        'application/json': {
          schema: GenericSuccessResponseSchema,
        },
      },
    },
    400: {
      description: 'Bad request',
      content: {
        'application/json': {
          schema: GenericErrorResponseSchema,
        },
      },
    },
    404: {
      description: 'Config not found',
      content: {
        'application/json': {
          schema: GenericErrorResponseSchema,
        },
      },
    },
  },
});

registerFunction('donationFormEmbed', 'Return the embed runtime for a published donation form', {
  handler: donationFormEmbed,
  description:
    'Returns a JavaScript embed that loads a published donation form configuration URL and renders the hosted Stripe checkout form.',
  tags: ['Builder'],
  operationId: 'donationFormEmbed',
  methods: ['GET'],
  ...withAnonymousAuth({}),
  route: 'form-builder/embed.js',
  responses: {
    200: {
      description: 'Embed JavaScript',
      content: {
        'application/javascript': {
          schema: z.string(),
        },
      },
    },
  },
});

registerFunction('donationFormSfObjects', 'List available Salesforce objects for field mapping', {
  handler: donationFormSfObjects,
  description:
    'Returns the list of Salesforce objects available for form field mapping in the donation form builder.',
  tags: ['Builder'],
  operationId: 'donationFormSfObjects',
  methods: ['GET'],
  ...withFunctionAuth({}),
  route: 'form-builder/sf/objects',
  responses: {
    200: {
      description: 'Object list',
      content: { 'application/json': { schema: GenericSuccessResponseSchema } },
    },
    503: {
      description: 'Salesforce not configured',
      content: { 'application/json': { schema: GenericErrorResponseSchema } },
    },
  },
});

registerFunction('donationFormSfFields', 'List Salesforce fields for a given object', {
  handler: donationFormSfFields,
  description:
    'Describes the writable fields of a Salesforce object, filtered for use in the form-builder field-mapping panel.',
  tags: ['Builder'],
  operationId: 'donationFormSfFields',
  methods: ['GET'],
  ...withFunctionAuth({}),
  route: 'form-builder/sf/fields/{objectName}',
  responses: {
    200: {
      description: 'Field list',
      content: { 'application/json': { schema: GenericSuccessResponseSchema } },
    },
    404: {
      description: 'Object not found',
      content: { 'application/json': { schema: GenericErrorResponseSchema } },
    },
    503: {
      description: 'Salesforce not configured',
      content: { 'application/json': { schema: GenericErrorResponseSchema } },
    },
  },
});

// transaction endpoint expects a request body matching transactionUpsertHttpBodySchema
registerFunction('processTransaction', 'Process a payment transaction', {
  handler: processTransaction,
  description:
    'Creates and processes a transaction request into downstream payment/CRM workflows. Use this from Swagger to confirm Stripe checkout session creation and downstream CRM preparation. Prefer `mode=test` or `livemode=false` during deployed verification.',
  tags: ['Transactions'],
  operationId: 'processTransaction',
  methods: ['POST'],
  ...withAnonymousAuth({}),
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
        'application/json': {
          schema: ProcessTransactionRequestSchema,
          example: processTransactionExample,
          examples: processTransactionExamples,
        },
      },
    },
  },
  responses: {
    200: {
      description: 'Transaction processed (checkout session created)',
      content: {
        'application/json': {
          schema: TransactionCreatedResponseSchema,
          example: processTransactionResponseExample,
          examples: {
            checkoutSessionCreated: asNamedExample(
              'Checkout session created',
              processTransactionResponseExample,
              'Typical response from a successful transaction request.'
            ),
          },
        },
      },
    },
    400: {
      description: 'Invalid transaction payload',
      content: {
        'application/json': {
          schema: GenericErrorResponseSchema,
          example: { error: 'validation_error', message: 'Invalid transaction payload.' },
        },
      },
    },
    500: {
      description: 'Processing error',
      content: {
        'application/json': {
          schema: GenericErrorResponseSchema,
          example: { error: 'processing_error', message: 'Failed to create checkout session.' },
        },
      },
    },
  },
});

registerFunction('stripeWebhook', 'Stripe webhook receiver', {
  handler: stripeWebhook,
  description:
    'Receives Stripe webhook events and routes them to the appropriate domain handlers. This endpoint is typically exercised by Stripe directly rather than from Swagger, but the schema is included for completeness.',
  tags: ['Stripe'],
  operationId: 'stripeWebhook',
  methods: ['POST'],
  ...withFunctionAuth({}),
  route: 'stripe/webhook',
  request: {
    headers: StripeWebhookHeadersSchema,
    body: {
      content: {
        'application/json': {
          schema: z.record(z.unknown()),
          example: stripeWebhookEventExample,
          examples: {
            paymentIntentSucceeded: asNamedExample(
              'payment_intent.succeeded',
              stripeWebhookEventExample,
              'Representative Stripe webhook payload skeleton for success handling.'
            ),
          },
        },
      },
    },
  },
  responses: {
    200: {
      description: 'Webhook processed or duplicate acknowledged',
      content: {
        'application/json': {
          schema: GenericObjectSchema,
          example: { received: true, eventType: 'payment_intent.succeeded' },
        },
      },
    },
    400: {
      description: 'Missing/invalid Stripe signature or invalid payload',
      content: {
        'application/json': {
          schema: GenericErrorResponseSchema,
          example: { received: false, error: 'invalid_signature' },
        },
      },
    },
  },
});

registerFunction('payoutSyncTrigger', 'Trigger payout sync with Stripe', {
  handler: payoutSyncTrigger,
  description:
    'Manually triggers payout synchronization and reconciliation flow with Stripe/QBO. Use this after deployment to verify payout ingestion paths against a bounded lookback window.',
  tags: ['Stripe'],
  operationId: 'payoutSyncTrigger',
  methods: ['POST'],
  ...withFunctionAuth({}),
  route: 'stripe/payout-sync',
  request: {
    query: PayoutSyncQuerySchema,
  },
  responses: {
    200: {
      description: 'Sync completed',
      content: {
        'application/json': {
          schema: GenericObjectSchema,
          example: payoutSyncResponseExample,
          examples: {
            fullSuccess: asNamedExample(
              'Successful payout sync',
              payoutSyncResponseExample,
              'All payouts in the lookback window processed successfully.'
            ),
          },
        },
      },
    },
    207: {
      description: 'Sync completed with partial errors',
      content: {
        'application/json': {
          schema: GenericObjectSchema,
          example: payoutSyncResponseWithErrorsExample,
          examples: {
            partialFailure: asNamedExample(
              'Partial payout sync failure',
              payoutSyncResponseWithErrorsExample,
              'One or more payouts failed while others completed.'
            ),
          },
        },
      },
    },
    500: {
      description: 'Sync failed',
      content: {
        'application/json': {
          schema: GenericErrorResponseSchema,
          example: { error: 'Processing failed', message: 'Unexpected payout sync error.' },
        },
      },
    },
  },
});

registerFunction('stripeTrueUp', 'Stripe true-up support', {
  handler: stripeTrueUp,
  description:
    'Runs Stripe true-up operations for payment reconciliation. This is one of the main deployed verification tools for replaying recent payments, refunds, or payouts through downstream sync logic.',
  tags: ['Stripe'],
  operationId: 'stripeTrueUp',
  methods: ['GET', 'POST'],
  ...withFunctionAuth({}),
  route: 'stripe/true-up',
  request: {
    query: StripeTrueUpQuerySchema,
  },
  responses: {
    200: {
      description: 'True-up operation complete',
      content: {
        'application/json': {
          schema: GenericObjectSchema,
          example: stripeTrueUpResponseExample,
          examples: {
            paymentsDryRun: asNamedExample(
              'Payments dry-run',
              {
                request: stripeTrueUpPaymentsExample,
                response: stripeTrueUpResponseExample,
              },
              'Dry-run reconciliation for recent payments.'
            ),
            refundsReplay: asNamedExample(
              'Refund replay',
              {
                request: stripeTrueUpRefundsExample,
                response: {
                  ...stripeTrueUpResponseExample,
                  type: 'refunds',
                  resubmit: true,
                },
              },
              'Replay refund handling without posting to QuickBooks.'
            ),
            payoutsDryRun: asNamedExample(
              'Payout dry-run',
              {
                request: stripeTrueUpPayoutsExample,
                response: {
                  ...stripeTrueUpResponseExample,
                  type: 'payouts',
                },
              },
              'Validate payout reconciliation path from Swagger.'
            ),
          },
        },
      },
    },
    400: {
      description: 'Invalid or missing query parameters',
      content: {
        'application/json': {
          schema: GenericErrorResponseSchema,
          example: { error: 'bad_request', message: 'Query parameter "from" is required.' },
        },
      },
    },
    500: {
      description: 'True-up operation failed',
      content: {
        'application/json': {
          schema: GenericErrorResponseSchema,
          example: {
            error: 'internal_error',
            message: 'Failed to complete Stripe true-up operation.',
          },
        },
      },
    },
  },
});

registerFunction('manualQboSync', 'Manually trigger QuickBooks Online sync', {
  handler: manualQboSync,
  description:
    'Starts an on-demand QuickBooks Online synchronization cycle. Use this from Swagger for targeted QuickBooks document validation when credentials and account mappings are configured.',
  tags: ['QBO'],
  operationId: 'manualQboSync',
  methods: ['POST'],
  ...withFunctionAuth({}),
  route: 'qbo/manual-sync',
  request: {
    body: {
      content: {
        'application/json': {
          schema: ManualQboSyncRequestSchema,
          example: manualQboSyncExample,
          examples: manualQboSyncExamples,
        },
      },
    },
  },
  responses: {
    200: {
      description: 'QuickBooks manual sync succeeded',
      content: {
        'application/json': {
          schema: GenericObjectSchema,
          example: manualQboSyncResponseExample,
          examples: {
            qboDocumentCreated: asNamedExample(
              'QuickBooks document created',
              manualQboSyncResponseExample,
              'Successful manual QuickBooks sync result.'
            ),
          },
        },
      },
    },
    400: {
      description: 'Invalid manual sync request',
      content: {
        'application/json': {
          schema: GenericErrorResponseSchema,
          example: {
            error: 'validation_error',
            message: 'Unsupported QuickBooks document payload.',
          },
        },
      },
    },
    500: {
      description: 'QuickBooks sync failure',
      content: {
        'application/json': {
          schema: GenericErrorResponseSchema,
          example: { error: 'internal_error', message: 'QuickBooks sync failed.' },
        },
      },
    },
  },
});

registerFunction('testArtifactCleanup', 'Clean up tagged external test artifacts', {
  handler: testArtifactCleanup,
  description:
    'Finds tagged Stripe, Salesforce, and QuickBooks test artifacts and deletes or expires them. Defaults to dry-run mode unless dryRun=false is supplied.',
  tags: ['Stripe', 'Salesforce', 'QBO'],
  operationId: 'testArtifactCleanup',
  methods: ['POST'],
  ...withFunctionAuth({}),
  route: 'ops/test-artifact-cleanup',
  request: {
    body: {
      content: {
        'application/json': {
          schema: TestArtifactCleanupRequestSchema,
          example: cleanupExample,
          examples: cleanupExamples,
        },
      },
    },
  },
  responses: {
    200: {
      description: 'Cleanup summary completed',
      content: {
        'application/json': {
          schema: GenericObjectSchema,
          example: cleanupResponseExample,
          examples: {
            dryRunSummary: asNamedExample(
              'Dry-run cleanup summary',
              cleanupResponseExample,
              'Preview summary before deleting any records.'
            ),
            deletedSummary: asNamedExample(
              'Deleted cleanup summary',
              {
                ...cleanupResponseExample,
                dryRun: false,
                summary: {
                  stripe: { matched: 2, deleted: 2 },
                  salesforce: { matched: 1, deleted: 1 },
                  qbo: { matched: 1, deleted: 1 },
                },
              },
              'Artifacts were actually deleted.'
            ),
          },
        },
      },
    },
    400: {
      description: 'Invalid cleanup request',
      content: {
        'application/json': {
          schema: GenericErrorResponseSchema,
          example: { error: 'validation_error', message: 'A cleanup tag is required.' },
        },
      },
    },
    500: {
      description: 'Cleanup execution failed',
      content: {
        'application/json': {
          schema: GenericErrorResponseSchema,
          example: { error: 'internal_error', message: 'Cleanup execution failed.' },
        },
      },
    },
  },
});

registerFunction('salesforcePaymentsSync', 'Salesforce payments synchronization', {
  handler: salesforcePaymentsSync,
  description:
    'Triggers synchronization of payments from Stripe into Salesforce records. Use this in Swagger to validate downstream transaction mapping without waiting for webhooks or scheduled jobs.',
  tags: ['Salesforce'],
  operationId: 'salesforcePaymentsSync',
  methods: ['GET', 'POST'],
  ...withFunctionAuth({}),
  route: 'stripe/salesforce-payments-sync',
  request: {
    query: SalesforcePaymentsSyncQuerySchema,
  },
  responses: {
    200: {
      description: 'Sync succeeded',
      content: {
        'application/json': {
          schema: GenericObjectSchema,
          example: salesforcePaymentsSyncResponseExample,
          examples: {
            dryRunJson: asNamedExample(
              'Dry-run JSON summary',
              salesforcePaymentsSyncResponseExample,
              'Recommended first pass when validating the Stripe-to-Salesforce sync route.'
            ),
            csvExportMode: asNamedExample(
              'CSV export mode',
              salesforcePaymentsSyncCsvResponseExample,
              'Illustrates the CSV response/header shape when `format=csv` is used.'
            ),
          },
        },
      },
    },
    500: {
      description: 'Sync failed',
      content: {
        'application/json': {
          schema: GenericErrorResponseSchema,
          example: {
            error: 'internal_error',
            message: 'Failed to sync Stripe payments to Salesforce.',
          },
        },
      },
    },
  },
});

registerFunction('qboCustomersSync', 'QBO customer sync to Salesforce contacts', {
  handler: qboCustomersSync,
  description:
    'Synchronizes QuickBooks Online customers into Salesforce Contacts with dry-run and duplicate checks.',
  tags: ['QBO', 'Salesforce'],
  operationId: 'qboCustomersSync',
  methods: ['GET', 'POST'],
  ...withFunctionAuth({}),
  route: 'qbo/customers-salesforce-sync',
  request: {
    query: QboCustomersSyncQuerySchema,
  },
  responses: {
    200: {
      description: 'Customer sync completed',
      content: {
        'application/json': {
          schema: GenericSuccessResponseSchema,
          example: qboCustomersSyncResponseExample,
          examples: {
            createAndUpdateDryRun: asNamedExample(
              'Create-and-update dry-run',
              qboCustomersSyncResponseExample,
              'Default preview mode for customer syncing.'
            ),
            createOnlyDryRun: asNamedExample(
              'Create-only dry-run',
              qboCustomersSyncCreateOnlyResponseExample,
              'Shows behavior when updates are skipped and only missing contacts would be created.'
            ),
          },
        },
      },
    },
    500: {
      description: 'Customer sync failed',
      content: {
        'application/json': {
          schema: GenericErrorResponseSchema,
          example: {
            error: 'internal_error',
            message: 'Failed to sync QBO customers to Salesforce.',
          },
        },
      },
    },
  },
});

registerFunction('qboReceiptsSync', 'Sync QuickBooks sales receipts to Salesforce transactions', {
  handler: qboReceiptsSync,
  description:
    'Pages through QuickBooks Online sales receipts (all or up to a limit), resolves each customer ' +
    'to a Salesforce Contact or Account via the customer "Salesforce ID" custom field, and imports ' +
    'unsynced receipts as Salesforce Transaction__c records. Supports dry-run mode.',
  tags: ['QBO', 'Salesforce'],
  operationId: 'qboReceiptsSync',
  methods: ['GET', 'POST'],
  ...withFunctionAuth({}),
  route: 'qbo/receipts-salesforce-sync',
  request: {
    query: QboReceiptsSyncQuerySchema,
  },
  responses: {
    200: {
      description: 'Receipt sync completed - see summary for per-receipt outcomes',
      content: {
        'application/json': {
          schema: GenericSuccessResponseSchema,
          example: qboReceiptsSyncResponseExample,
          examples: {
            dryRunReceiptImport: asNamedExample(
              'Dry-run receipt import',
              qboReceiptsSyncResponseExample,
              'Preview which receipts would sync into Salesforce.'
            ),
            liveReceiptImport: asNamedExample(
              'Live receipt import',
              qboReceiptsSyncLiveResponseExample,
              'Shows a successful mutating import run.'
            ),
          },
        },
      },
    },
    500: {
      description: 'Unhandled error during receipt sync',
      content: {
        'application/json': {
          schema: GenericErrorResponseSchema,
          example: {
            error: 'internal_error',
            message: 'Failed to sync QuickBooks receipts to Salesforce.',
          },
        },
      },
    },
  },
});

registerFunction(
  'salesforceRecordQboSync',
  'Sync QuickBooks and Salesforce for one Salesforce record',
  {
    handler: salesforceRecordQboSync,
    description:
      'Resolves a Salesforce Contact or Account by Id, links the matching QuickBooks customer, syncs supported transactions, and can optionally import unmatched QBO sales receipts into Salesforce with a dry-run summary.',
    tags: ['QBO', 'Salesforce'],
    operationId: 'salesforceRecordQboSync',
    methods: ['GET', 'POST'],
    ...withFunctionAuth({}),
    route: 'qbo/salesforce-record-sync',
    request: {
      query: SalesforceRecordQboSyncQuerySchema,
    },
    responses: {
      200: {
        description: 'Single-record sync completed',
        content: {
          'application/json': {
            schema: GenericSuccessResponseSchema,
            example: salesforceRecordQboSyncResponseExample,
            examples: {
              linkOnlyDryRun: asNamedExample(
                'Link-only dry-run',
                salesforceRecordQboSyncResponseExample,
                'Validates a single Salesforce-to-QBO link without importing receipts.'
              ),
              importReceiptsDryRun: asNamedExample(
                'Import receipts for one Salesforce record',
                salesforceRecordQboSyncImportReceiptsResponseExample,
                'Validates the single-record sync path including receipt import planning.'
              ),
            },
          },
        },
      },
      400: {
        description: 'Invalid sync request',
        content: {
          'application/json': {
            schema: GenericErrorResponseSchema,
            example: { error: 'bad_request', message: 'salesforceId is required.' },
          },
        },
      },
      404: {
        description: 'Salesforce record not found',
        content: {
          'application/json': {
            schema: GenericErrorResponseSchema,
            example: {
              error: 'salesforce_record_not_found',
              message: 'No Contact or Account was found for Salesforce ID 003xx0000000001.',
            },
          },
        },
      },
      409: {
        description: 'Link conflict or unresolved customer',
        content: {
          'application/json': {
            schema: GenericErrorResponseSchema,
            example: {
              error: 'link_conflict',
              message: 'Conflicting Salesforce/QuickBooks linking data was found.',
            },
          },
        },
      },
      500: {
        description: 'Single-record sync failed',
        content: {
          'application/json': {
            schema: GenericErrorResponseSchema,
            example: {
              error: 'internal_error',
              message: 'Failed to sync the Salesforce record with QuickBooks.',
            },
          },
        },
      },
    },
  }
);

registerFunction(
  'stripeDuplicateCheck',
  'Detect and optionally remove duplicate records based on matching Stripe IDs',
  {
    handler: stripeDuplicateCheck,
    description:
      'Scans QuickBooks Online and/or Salesforce for records that share the same Stripe ID. ' +
      'Duplicate QBO documents are identified by a shared Stripe ID suffix in their DocNumber ' +
      '(CHG-, CHGJE-, PO- prefixes). Duplicate Salesforce Transaction__c records are identified ' +
      'by repeating values in any of the ten Stripe ID fields. ' +
      'Set deleteDuplicates=true with dryRun=false to permanently remove extras (oldest record is kept).',
    tags: ['QBO', 'Salesforce'],
    operationId: 'stripeDuplicateCheck',
    methods: ['GET'],
    ...withFunctionAuth({}),
    route: 'ops/stripe-duplicate-check',
    request: {
      query: StripeDuplicateCheckQuerySchema,
    },
    responses: {
      200: {
        description: 'Duplicate check completed — see duplicateGroups for findings',
        content: {
          'application/json': {
            schema: GenericSuccessResponseSchema,
            example: {
              success: true,
              dryRun: true,
              deleteDuplicates: false,
              dateRange: { startDate: null, endDate: null },
              qbo: { checked: 42, duplicateGroups: [], deleted: 0, errors: [] },
              salesforce: { checked: 38, duplicateGroups: [], deleted: 0, errors: [] },
            },
          },
        },
      },
      500: {
        description: 'Unhandled error during duplicate check',
        content: {
          'application/json': {
            schema: GenericErrorResponseSchema,
            example: {
              error: 'internal_error',
              message: 'Unexpected error during duplicate check.',
            },
          },
        },
      },
    },
  }
);

// Export for testing
export {
  healthCheck,
  processTransaction,
  stripeWebhook,
  payoutSyncTrigger,
  stripeTrueUp,
  manualQboSync,
  testArtifactCleanup,
  salesforcePaymentsSync,
  qboCustomersSync,
  salesforceRecordQboSync,
  stripeDuplicateCheck,
  donationFormBuilder,
  donationFormConfigSave,
  donationFormConfigUpdate,
  donationFormConfigList,
  donationFormConfigGet,
  donationFormConfigDelete,
  donationFormEmbed,
};

// expose the OpenAPI configuration/documents for testing or external use
export { openAPIConfig, documents };
