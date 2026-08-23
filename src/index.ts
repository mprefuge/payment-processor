import { app } from '@azure/functions';
import {
  extendZodWithOpenApi,
  registerApiKeySecuritySchema,
  registerFunction,
  registerOpenAPIHandler,
  registerSwaggerUIHandler,
  OpenAPIObjectConfig,
} from 'azure-functions-openapi';
import { z } from 'zod';

import './preflight';

// Enables `.openapi({ example })` on Zod schemas so Swagger UI pre-fills "Try it out"
// with working values instead of blank boxes. Must run before any schema below is built.
extendZodWithOpenApi(z);

/**
 * Every example payload on this surface carries this tag, in metadata and in memos.
 *
 * It is what makes Swagger usable as a staged test harness: exercise a stage, inspect
 * the records it produced, then remove exactly those records with
 * `POST /api/ops/test-artifact-cleanup` using the same tag. Anything created from the
 * examples below is reachable that way; anything created with a different tag is not.
 *
 * Change the suffix per run (e.g. `swagger-manual-2026-07-28`) when you want one run's
 * records to be separable from another's.
 */
const SWAGGER_TEST_TAG = 'swagger-manual-test';

/** Recognisable across Stripe, Salesforce and QuickBooks when scanning for leftovers. */
const SWAGGER_TEST_EMAIL = 'swagger.test@example.invalid';

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
const testArtifactVerify = loadHandler('./handlers/testArtifactVerify');
const stripeDuplicateCheck = loadHandler('./handlers/stripeDuplicateCheck');
const dailyReconciliation = loadHandler('./handlers/dailyReconciliation');
const { dailyReconciliationTimer } = (() => {
  const mod = require('./handlers/dailyReconciliation');
  return { dailyReconciliationTimer: mod.dailyReconciliationTimer };
})();
const donationFormBuilder = loadHandler('./handlers/donationFormBuilder');
const donationFormConfigSave = loadHandler('./handlers/donationFormConfigSave');
const donationFormConfigUpdate = loadHandler('./handlers/donationFormConfigUpdate');
const donationFormConfigList = loadHandler('./handlers/donationFormConfigList');
const donationFormConfigGet = loadHandler('./handlers/donationFormConfigGet');
const donationFormConfigDelete = loadHandler('./handlers/donationFormConfigDelete');
const donationFormEmbed = loadHandler('./handlers/donationFormEmbed');
const donationFormSfObjects = loadHandler('./handlers/donationFormSfObjects');
const donationFormSfFields = loadHandler('./handlers/donationFormSfFields');

// The staged test harness is authored in TypeScript with named exports, so it is imported
// directly rather than through loadHandler (which exists for the CommonJS .js handlers).
import {
  opsTestDonation,
  opsTestQuickbooks,
  opsTestSalesforce,
  opsTestStripe,
} from './handlers/opsTestHarness';
import {
  DEFAULT_TEST_ARTIFACT_TAG,
  SyntheticDonationSchema,
} from './services/testHarness/syntheticDonation';

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
      '## Using this page as a staged test harness\n\n' +
      'Each stage of the pipeline can be exercised on its own, with a prefilled example, without waiting for a Checkout session to be completed and settled. Work down the list; every step is safe to repeat.\n\n' +
      '### Rehearse a stage before you run it\n\n' +
      'The `POST /api/ops/test/*` endpoints render exactly what a stage *would* send — QuickBooks document JSON, the Salesforce field map, the Stripe Checkout Session arguments — and by default send none of it. `dryRun` is `true` unless you pass `dryRun=false`, and a dry run performs no outbound **write** — it creates nothing anywhere — so these are safe to hammer. A dry run reads only when you asked about something only the remote system can describe (a `chargeId`); an inline donation payload makes no outbound call at all. Every response says which under `outboundReads`. `POST /api/ops/test/donation` walks one synthetic gift through all three in order. Anything a non-dry-run call creates is tagged for `POST /api/ops/test-artifact-cleanup`.\n\n' +
      '1. **`GET /api/health`** — confirms Stripe, Salesforce, QuickBooks, SendGrid and storage are all reachable, and that the QuickBooks refresh token still exchanges. Start here; if anything is unhealthy the later stages will fail in confusing ways.\n' +
      '2. **`POST /api/transaction`** — creates a Stripe Checkout session and upserts the Salesforce Contact and Transaction\\_\\_c. This is the donor-facing entry point. It does *not* complete a payment, so no charge, no QuickBooks document.\n' +
      '3. **`POST /api/qbo/manual-sync`** — posts a Salesforce transaction to QuickBooks as a SalesReceipt, JournalEntry or BankDeposit. **This is the fastest way to test the accounting path**, because it needs no Stripe charge at all.\n' +
      '4. **`POST /api/qbo/receipts-salesforce-sync`** and **`/api/qbo/customers-salesforce-sync`** — batch Salesforce → QuickBooks sync. Run with `dryRun=true` first.\n' +
      '5. **`POST /api/stripe/true-up`** — reconciliation and backfill over a date window, per object type (`payments`, `refunds`, `payouts`).\n' +
      '6. **`GET /api/ops/stripe-duplicate-check`** — confirms the stages above did not double-post.\n' +
      '7. **`POST /api/ops/test-artifact-verify`** — reads back the records step 2 created and reports, field by field, whether each one was populated and linked correctly. Wait ~60s after step 2 so the Stripe and Salesforce search indexes catch up.\n' +
      '8. **`POST /api/ops/test-artifact-cleanup`** — removes everything the run created. **Run this last, and only once the records have been inspected and confirmed.**\n\n' +
      '### Cleanup contract\n\n' +
      `Every example payload on this page is tagged \`source_test_tag: ${SWAGGER_TEST_TAG}\`. Passing that same tag to the cleanup endpoint removes exactly the records these examples created, across Stripe, Salesforce and QuickBooks. Records created with a different tag, or with none, are not reachable that way and must be removed by hand — so keep the tag in place when editing an example.\n\n` +
      'Run cleanup with `dryRun: true` first to see what would be deleted.\n\n' +
      '### Stripe webhook ingress\n\n' +
      '`POST /api/stripe/webhook` carries simulated payloads for every event type the processor handles, but it verifies `stripe-signature` and will reject an unsigned body from this page. Replay signed events with the Stripe CLI (`stripe trigger`, `stripe events resend`). See that endpoint for details.\n\n' +
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
    { name: 'Ops', description: 'Operational reconciliation and diagnostic endpoints' },
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
  paymentMethod: z.enum(['card', 'card_present', 'us_bank_account', 'amex', 'wallet']).optional(),
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
    lookbackDays: PositiveIntLikeSchema.optional().openapi({
      example: '7',
      description: 'How far back to scan for payouts.',
    }),
    mode: ModeQuerySchema.optional().openapi({ example: 'test' }),
  })
  .passthrough();

const StripeTrueUpQuerySchema = z
  .object({
    from: z.string().min(1).openapi({
      example: '2026-07-01T00:00:00Z',
      description: 'Start of the window to scan. Required.',
    }),
    to: z
      .string()
      .optional()
      .openapi({ example: '2026-07-31T23:59:59Z', description: 'End of the window.' }),
    type: z.enum(['payments', 'refunds', 'payouts']).optional().openapi({
      example: 'payments',
      description: 'Which Stripe object to reconcile. Run each in turn to cover all three paths.',
    }),
    mode: ModeQuerySchema.optional().openapi({ example: 'test' }),
    dryRun: BoolLikeQuerySchema.optional().openapi({
      example: 'true',
      description: 'START HERE. Reports what would be posted without writing to QuickBooks.',
    }),
    resubmit: BoolLikeQuerySchema.optional().openapi({
      example: 'false',
      description:
        'Note the inverted risk: resubmit=false checks only the idempotency marker, while resubmit=true also performs a Salesforce existence check.',
    }),
    bypassQbo: BoolLikeQuerySchema.optional().openapi({
      example: 'true',
      description: 'Exercises the Salesforce half alone, leaving the ledger untouched.',
    }),
    skipQbo: BoolLikeQuerySchema.optional().openapi({ example: 'false' }),
    limit: PositiveIntLikeSchema.optional().openapi({
      example: '5',
      description: 'Cap the batch while validating. Keep small for a manual test pass.',
    }),
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

const VerificationObjectKeySchema = z.enum([
  'stripe.customer',
  'stripe.checkout_session',
  'salesforce.Contact',
  'salesforce.Transaction__c',
]);

const TestArtifactVerifyRequestSchema = z
  .object({
    tag: z.string().min(1),
    liveMode: z.boolean().optional(),
    checkoutSessionId: z.string().min(1).optional(),
    expected: z.record(VerificationObjectKeySchema, z.record(z.unknown())).optional(),
    optionalFields: z.record(VerificationObjectKeySchema, z.array(z.string())).optional(),
    requireOptional: z.boolean().optional(),
    maxStripeCustomers: z.number().int().positive().max(500).optional(),
  })
  .passthrough();

const SalesforcePaymentsSyncQuerySchema = z
  .object({
    mode: ModeQuerySchema.optional().openapi({ example: 'test' }),
    dryRun: BoolLikeQuerySchema.optional().openapi({
      example: 'true',
      description: 'START HERE. Reports the planned Salesforce writes without making them.',
    }),
    salesforceId: z.string().optional().openapi({
      example: 'a0X5f000001AbCdEAK',
      description: 'Target a single Transaction__c instead of a batch.',
    }),
    exampleLimit: PositiveIntLikeSchema.optional().openapi({ example: '3' }),
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
    dryRun: BoolLikeQuerySchema.optional().openapi({
      example: 'true',
      description: 'START HERE. Lists the QuickBooks customers that would be created or updated.',
    }),
    syncMode: z
      .enum(['create-and-update', 'create-only', 'update-only'])
      .optional()
      .openapi({ example: 'create-only' }),
    overwrite: BoolLikeQuerySchema.optional().openapi({ example: 'false' }),
    pageSize: PositiveIntLikeSchema.optional(),
    maxPages: PositiveIntLikeSchema.optional(),
    maxRuntimeMs: PositiveIntLikeSchema.optional(),
    includeInactive: BoolLikeQuerySchema.optional(),
    exampleLimit: PositiveIntLikeSchema.optional(),
  })
  .passthrough();

const SalesforceRecordQboSyncQuerySchema = z
  .object({
    salesforceId: z.string().openapi({
      example: '0035f00000AbCdEAAV',
      description: 'Salesforce Contact or Account Id to reconcile against QuickBooks. Required.',
    }),
    dryRun: BoolLikeQuerySchema.optional().openapi({
      example: 'true',
      description: 'START HERE. Returns a summary of planned backfills, creates and conflicts.',
    }),
    importQboReceipts: BoolLikeQuerySchema.optional().openapi({ example: 'false' }),
    debug: BoolLikeQuerySchema.optional().openapi({ example: 'true' }),
  })
  .passthrough();

const QboReceiptsSyncQuerySchema = z
  .object({
    dryRun: BoolLikeQuerySchema.optional().openapi({
      example: 'true',
      description: 'START HERE. Lists the SalesReceipts that would be posted to QuickBooks.',
    }),
    debug: BoolLikeQuerySchema.optional().openapi({ example: 'true' }),
    limit: PositiveIntLikeSchema.optional().openapi({
      example: '5',
      description: 'Keep small for a manual validation pass.',
    }),
    qboIds: z.string().optional(),
    resyncFromSalesforce: BoolLikeQuerySchema.optional().openapi({ example: 'false' }),
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
    system: z.enum(['qbo', 'salesforce', 'both']).optional().openapi({ example: 'both' }),
    deleteDuplicates: BoolLikeQuerySchema.optional().openapi({
      example: 'false',
      description: 'Leave false while validating. Setting it true deletes ledger documents.',
    }),
    dryRun: BoolLikeQuerySchema.optional().openapi({ example: 'true' }),
    onlyPayouts: BoolLikeQuerySchema.optional().openapi({ example: 'false' }),
    inspectStripeId: z.string().optional().openapi({
      example: 'ch_3PqExampleChargeId',
      description: 'Inspect one Stripe id across both systems.',
    }),
    fetchLineDescriptions: BoolLikeQuerySchema.optional(),
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
  status: 'ok',
  timestamp: '2026-04-05T15:20:00.000Z',
  uptime: 3600.42,
  version: '1.0.0',
  connections: [
    {
      name: 'stripe_live',
      type: 'stripe',
      healthy: true,
      status: 'healthy',
      message: 'Stripe live connection healthy',
      details: {},
    },
    {
      name: 'crm_salesforce',
      type: 'crm',
      healthy: true,
      status: 'healthy',
      message: 'Salesforce connection healthy',
      details: {},
    },
    {
      name: 'accounting_quickbooks',
      type: 'accounting',
      healthy: true,
      status: 'healthy',
      message: 'quickbooks health check completed | Token refresh confirmed (tokens persisted)',
      details: {},
    },
  ],
  components: [
    { component: 'stripe_live', status: 'healthy', healthy: true },
    { component: 'crm_salesforce', status: 'healthy', healthy: true },
    { component: 'accounting_quickbooks', status: 'healthy', healthy: true },
  ],
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

/**
 * Simulated Stripe webhook payloads, one per stage of the pipeline.
 *
 * These exist so each downstream path can be exercised on its own, in any order,
 * without waiting for a real Checkout session to be completed and settled. They are
 * shaped to be complete enough to actually drive the handlers — a bare
 * `{ id, type }` skeleton is rejected or no-ops long before it reaches Salesforce
 * or QuickBooks.
 *
 * IMPORTANT — signature. `POST /api/stripe/webhook` verifies `stripe-signature`
 * against the configured webhook secret, so a payload pasted into Swagger is
 * rejected with 400 `invalid_signature` unless you sign it. Sign one with:
 *
 *   stripe trigger payment_intent.succeeded         # end-to-end via the Stripe CLI
 *   stripe events resend evt_xxx --webhook-endpoint we_xxx
 *
 * Do NOT reach for TEST_MODE=true to bypass this. It swaps the whole Stripe client
 * for a mock that both skips verification and FABRICATES the event objects, so the
 * payload you post is not the one processed — and on a live deployment it lets
 * anyone post unauthenticated events straight into the ledger.
 *
 * The endpoints below the webhook are plain JSON over a function key and can be
 * driven directly from Swagger. Use those to test the Salesforce and QuickBooks
 * stages; use the Stripe CLI for the ingress stage.
 *
 * Every payload is tagged with SWAGGER_TEST_TAG so the records it produces can be
 * removed afterwards via POST /api/ops/test-artifact-cleanup with the same tag.
 */
const stripeWebhookTestMetadata = {
  source_test_tag: SWAGGER_TEST_TAG,
  memo__c: `Swagger simulated event | [source_test_tag:${SWAGGER_TEST_TAG}]`,
};

/** Stage 1 — a successful charge: Salesforce Transaction__c + QuickBooks SalesReceipt. */
const stripeWebhookEventExample = {
  id: 'evt_swagger_pi_succeeded',
  object: 'event',
  api_version: '2023-10-16',
  created: 1_800_000_000,
  type: 'payment_intent.succeeded',
  livemode: false,
  data: {
    object: {
      id: 'pi_swagger_test_001',
      object: 'payment_intent',
      amount: 5000,
      amount_received: 5000,
      currency: 'usd',
      status: 'succeeded',
      customer: 'cus_swagger_test',
      created: 1_800_000_000,
      metadata: stripeWebhookTestMetadata,
      charges: {
        object: 'list',
        data: [
          {
            id: 'ch_swagger_test_001',
            object: 'charge',
            amount: 5000,
            currency: 'usd',
            status: 'succeeded',
            paid: true,
            livemode: false,
            created: 1_800_000_000,
            balance_transaction: 'txn_swagger_test_001',
            receipt_url: 'https://pay.stripe.com/receipts/swagger_test',
            metadata: stripeWebhookTestMetadata,
            billing_details: {
              name: 'Swagger Test Donor',
              email: SWAGGER_TEST_EMAIL,
              phone: '+15555550100',
            },
            payment_method_details: {
              type: 'card',
              card: { brand: 'visa', last4: '4242' },
            },
          },
        ],
      },
    },
  },
};

/** Stage 2 — refund: Transaction__c refund row + QuickBooks RefundReceipt / credit. */
const stripeWebhookRefundExample = {
  id: 'evt_swagger_refund_created',
  object: 'event',
  api_version: '2023-10-16',
  created: 1_800_003_600,
  type: 'refund.created',
  livemode: false,
  data: {
    object: {
      id: 're_swagger_test_001',
      object: 'refund',
      amount: 2500,
      currency: 'usd',
      status: 'succeeded',
      charge: 'ch_swagger_test_001',
      payment_intent: 'pi_swagger_test_001',
      balance_transaction: 'txn_swagger_refund_001',
      created: 1_800_003_600,
      reason: 'requested_by_customer',
      metadata: stripeWebhookTestMetadata,
    },
  },
};

/** Stage 3 — lost dispute: QuickBooks JournalEntry for the loss plus the dispute fee. */
const stripeWebhookDisputeExample = {
  id: 'evt_swagger_dispute_closed',
  object: 'event',
  api_version: '2023-10-16',
  created: 1_800_007_200,
  type: 'charge.dispute.closed',
  livemode: false,
  data: {
    object: {
      id: 'dp_swagger_test_001',
      object: 'dispute',
      amount: 5000,
      currency: 'usd',
      status: 'lost',
      reason: 'fraudulent',
      charge: 'ch_swagger_test_001',
      payment_intent: 'pi_swagger_test_001',
      created: 1_800_007_200,
      balance_transactions: [
        {
          id: 'txn_swagger_dispute_001',
          object: 'balance_transaction',
          amount: -5000,
          fee: 1500,
          net: -6500,
          currency: 'usd',
          type: 'adjustment',
          created: 1_800_007_200,
        },
      ],
      metadata: stripeWebhookTestMetadata,
    },
  },
};

/** Stage 4 — payout: QuickBooks Transfer from Stripe Clearing to the operating bank. */
const stripeWebhookPayoutExample = {
  id: 'evt_swagger_payout_paid',
  object: 'event',
  api_version: '2023-10-16',
  created: 1_800_010_800,
  type: 'payout.paid',
  livemode: false,
  data: {
    object: {
      id: 'po_swagger_test_001',
      object: 'payout',
      amount: 4550,
      currency: 'usd',
      status: 'paid',
      automatic: true,
      // arrival_date drives the QuickBooks TxnDate on every posting path. It is
      // typically ~2 business days after `created`; keep both so the dedup window
      // is exercised realistically.
      created: 1_800_010_800,
      arrival_date: 1_800_183_600,
      balance_transaction: 'txn_swagger_payout_001',
      metadata: stripeWebhookTestMetadata,
    },
  },
};

/** Stage 5 — recurring gift billed out of band, no payment intent. */
const stripeWebhookInvoicePaidExample = {
  id: 'evt_swagger_invoice_paid',
  object: 'event',
  api_version: '2023-10-16',
  created: 1_800_014_400,
  type: 'invoice.paid',
  livemode: false,
  data: {
    object: {
      id: 'in_swagger_test_001',
      object: 'invoice',
      // Distinct per billing period. Identity keys on this, never on `subscription`,
      // which is shared by every gift in the series.
      subscription: 'sub_swagger_test_series',
      customer: 'cus_swagger_test',
      customer_email: SWAGGER_TEST_EMAIL,
      amount_paid: 5000,
      total: 5000,
      currency: 'usd',
      paid_out_of_band: true,
      collection_method: 'send_invoice',
      created: 1_800_014_400,
      status_transitions: { paid_at: 1_800_014_400 },
      metadata: stripeWebhookTestMetadata,
    },
  },
};

/** Stage 6 — credit note issued against an invoice. */
const stripeWebhookCreditNoteExample = {
  id: 'evt_swagger_credit_note',
  object: 'event',
  api_version: '2023-10-16',
  created: 1_800_018_000,
  type: 'credit_note.created',
  livemode: false,
  data: {
    object: {
      id: 'cn_swagger_test_001',
      object: 'credit_note',
      invoice: 'in_swagger_test_001',
      customer: 'cus_swagger_test',
      amount: 1500,
      currency: 'usd',
      status: 'issued',
      number: 'CN-SWAGGER-001',
      reason: 'order_change',
      created: 1_800_018_000,
      metadata: stripeWebhookTestMetadata,
    },
  },
};

const stripeWebhookStageExamples = {
  stage1ChargeSucceeded: asNamedExample(
    'Stage 1 - payment_intent.succeeded',
    stripeWebhookEventExample,
    'Charge posted: upserts Transaction__c and posts a QuickBooks SalesReceipt. Run this first; later stages reference its charge and payment intent ids.'
  ),
  stage2Refund: asNamedExample(
    'Stage 2 - refund.created',
    stripeWebhookRefundExample,
    'Partial refund of the stage 1 charge. Note that charge.refunded only processes a single refund; subscribe refund.created so second and later partial refunds are recorded.'
  ),
  stage3DisputeLost: asNamedExample(
    'Stage 3 - charge.dispute.closed (lost)',
    stripeWebhookDisputeExample,
    'Chargeback: posts a QuickBooks JournalEntry for the loss and the dispute fee. Change status to "won" to exercise the reversal path.'
  ),
  stage4Payout: asNamedExample(
    'Stage 4 - payout.paid',
    stripeWebhookPayoutExample,
    'Settlement: posts a QuickBooks Transfer dated by arrival_date. Re-post it to confirm the duplicate guard holds rather than booking the payout twice.'
  ),
  stage5InvoicePaid: asNamedExample(
    'Stage 5 - invoice.paid (out of band)',
    stripeWebhookInvoicePaidExample,
    'Recurring gift with no payment intent. Send it twice with different invoice ids and the same subscription to confirm each period gets its own Transaction__c.'
  ),
  stage6CreditNote: asNamedExample(
    'Stage 6 - credit_note.created',
    stripeWebhookCreditNoteExample,
    'Credit note against the stage 5 invoice.'
  ),
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

// Mirrors the handler's ManualSyncResponse: the id is returned at the top level, and the
// resolved customer is echoed back so the caller can see who the document was attributed to.
const manualQboSyncResponseExample = {
  success: true,
  id: '987',
  type: 'sales-receipt',
  docNumber: 'MAN-2026-0729114500',
  customerId: '77',
  customerName: 'Acme Foundation',
};

// ---------------------------------------------------------------------------
// /api/ops/test/* — the staged test harness
// ---------------------------------------------------------------------------

/**
 * Default cleanup tag for the harness endpoints.
 *
 * Distinct from SWAGGER_TEST_TAG above so a harness run can be cleaned up without also
 * sweeping away records created by the `POST /api/transaction` examples, and vice versa.
 */
const TEST_HARNESS_TAG = DEFAULT_TEST_ARTIFACT_TAG;

const TestHarnessQuerySchema = z
  .object({
    dryRun: BoolLikeQuerySchema.optional().openapi({
      example: 'true',
      description:
        'Defaults to TRUE. A dry run writes nothing — no record is created in Stripe, ' +
        'Salesforce or QuickBooks. It reads only where you asked about something only the ' +
        'remote system can describe (a `chargeId`); an inline donation payload makes no ' +
        'outbound call at all. The response reports which under `outboundReads`. Pass ' +
        '`false` only when you intend the endpoint to write.',
    }),
    tag: z
      .string()
      .optional()
      .openapi({
        example: TEST_HARNESS_TAG,
        description:
          'Cleanup tag stamped on anything a non-dry-run call creates. Pass the same value to ' +
          '`POST /api/ops/test-artifact-cleanup?tag=…` afterwards.',
      }),
  })
  .passthrough();

const TestHarnessStripeQuerySchema = z
  .object({
    dryRun: BoolLikeQuerySchema.optional().openapi({
      example: 'true',
      description:
        'Defaults to TRUE. A dry run constructs no Stripe client and makes no Stripe call.',
    }),
    tag: z.string().optional().openapi({ example: TEST_HARNESS_TAG }),
    mode: ModeQuerySchema.optional().openapi({
      example: 'test',
      description:
        'Only `test` is accepted when dryRun=false. `live` is rejected — this harness will not create a chargeable session.',
    }),
  })
  .passthrough();

const TestHarnessRequestSchema = z
  .object({
    donation: SyntheticDonationSchema,
    dryRun: z.boolean().optional().openapi({
      example: true,
      description: 'Defaults to true. Set false to let the endpoint actually write.',
    }),
    tag: z.string().optional().openapi({ example: TEST_HARNESS_TAG }),
  })
  .passthrough();

const TestHarnessQuickbooksRequestSchema = z
  .object({
    donation: SyntheticDonationSchema.optional(),
    chargeId: z
      .string()
      .optional()
      .openapi({
        example: 'ch_3ABC123def456',
        description:
          'Preview a real Stripe charge instead of a synthetic donation. Works on a dry run: ' +
          'resolving the charge is a read-only Stripe retrieve, and this path posts nothing ' +
          'to QuickBooks either way.',
      }),
    dryRun: z.boolean().optional().openapi({ example: true }),
    tag: z.string().optional().openapi({ example: TEST_HARNESS_TAG }),
  })
  .passthrough();

const testHarnessDonationExample = {
  grossCents: 10300,
  coveredFeeCents: 300,
  processorFeeCents: 329,
  donor: {
    email: SWAGGER_TEST_EMAIL,
    firstName: 'Harness',
    lastName: 'Testcase',
  },
  date: '2026-08-20',
  designation: 'General Fund',
  frequency: 'onetime',
  paymentMethod: 'card',
  category: 'Donation',
  transactionType: 'Donation',
  livemode: false,
};

const testHarnessRecurringDonationExample = {
  ...testHarnessDonationExample,
  frequency: 'month',
  grossCents: 5000,
  coveredFeeCents: 0,
  processorFeeCents: 175,
};

/** No processorFeeCents: the charge has not settled, so the fee is unknown, not zero. */
const testHarnessUnsettledDonationExample = (() => {
  const { processorFeeCents: _omitted, ...rest } = testHarnessDonationExample;
  return { ...rest, paymentMethod: 'us_bank_account' };
})();

const testHarnessRequestExample = {
  dryRun: true,
  tag: TEST_HARNESS_TAG,
  donation: testHarnessDonationExample,
};

const testHarnessExamples = {
  oneTimeCardGift: asNamedExample(
    'One-time card gift, fee covered',
    testHarnessRequestExample,
    'A $100.00 gift with a $3.00 covered fee, charged as $103.00, with a $3.29 Stripe fee.'
  ),
  recurringGift: asNamedExample(
    'Monthly recurring gift',
    { dryRun: true, tag: TEST_HARNESS_TAG, donation: testHarnessRecurringDonationExample },
    'Selects subscription mode, so donor intent is mirrored onto subscription_data.metadata.'
  ),
  unsettledAchGift: asNamedExample(
    'ACH gift Stripe has not settled',
    { dryRun: true, tag: TEST_HARNESS_TAG, donation: testHarnessUnsettledDonationExample },
    'processorFeeCents omitted: every fee-derived number renders as explicitly unknown, never 0.'
  ),
};

const testHarnessQuickbooksExamples = {
  ...testHarnessExamples,
  existingCharge: asNamedExample(
    'Preview a real Stripe charge',
    { dryRun: true, tag: TEST_HARNESS_TAG, chargeId: 'ch_3ABC123def456' },
    'A plain dry run. Reads the charge and its balance transaction from Stripe and renders ' +
      'the documents it would produce. Reads only — nothing is written anywhere.'
  ),
};

const testHarnessQuickbooksResponseExample = {
  success: true,
  dryRun: true,
  tag: TEST_HARNESS_TAG,
  source: 'synthetic',
  outboundReads: {
    performed: false,
    services: [],
    detail:
      'None. No outbound call of any kind was made — not a read, not a write. This response ' +
      'is a pure function of the request body.',
  },
  writesNothing:
    'Nothing was posted. QuickBooks was not contacted, and no QuickBooks reference was resolved.',
  amounts: {
    grossCents: 10300,
    feeAvailable: true,
    feeCents: 329,
    netCents: 9971,
    currency: 'usd',
    txnDate: '2026-08-20',
  },
  memo: `Stripe charge ch_test0123456789abcdef | [source_test_tag:${TEST_HARNESS_TAG}]`,
  strategies: [
    {
      strategy: 'sales-receipt',
      active: false,
      documents: [
        { order: 1, entity: 'SalesReceipt', docNumber: 'CHG-20260820-0123456789ab' },
        { order: 2, entity: 'JournalEntry', docNumber: 'FEE-20260820-0123456789ab' },
      ],
    },
    {
      strategy: 'je-transfer',
      active: true,
      documents: [{ order: 1, entity: 'JournalEntry', docNumber: 'CHGJE-20260820-23456789ab' }],
    },
  ],
};

const testHarnessSalesforceResponseExample = {
  success: true,
  dryRun: true,
  tag: TEST_HARNESS_TAG,
  contact: {
    object: 'Contact',
    wouldCreate: {
      Stripe_Customer_Id__c: 'cus_test0123456789ab',
      LastName: 'Testcase',
      FirstName: 'Harness',
      Email: SWAGGER_TEST_EMAIL,
    },
  },
  transaction: {
    object: 'Transaction__c',
    externalIdField: 'Stripe_Payment_Intent_Id__c',
    fields: {
      Amount_Gross__c: 103,
      Amount_Fee__c: 3.29,
      Amount_Net__c: 99.71,
      Cover_Fees_Amount__c: 3,
      Frequency__c: 'onetime',
      Payment_Method__c: 'card',
      Stripe_Livemode__c: false,
    },
  },
  skippedByNullMeansUnknown: [],
};

const testHarnessStripeResponseExample = {
  success: true,
  dryRun: true,
  tag: TEST_HARNESS_TAG,
  mode: 'payment',
  checkoutSessionCreateArgs: {
    mode: 'payment',
    payment_method_types: ['card'],
    line_items: [{ price_data: { currency: 'usd', unit_amount: 10300 }, quantity: 1 }],
    metadata: {
      category: 'Donation',
      frequency: 'onetime',
      transactionType: 'Donation',
      cover_fees: 'true',
      cover_fees_amount: '300',
      source_test_tag: TEST_HARNESS_TAG,
    },
    payment_intent_data: {
      metadata: {
        frequency: 'onetime',
        cover_fees_amount: '300',
        source_test_tag: TEST_HARNESS_TAG,
      },
    },
  },
};

const testHarnessDonationResponseExample = {
  success: true,
  dryRun: true,
  tag: TEST_HARNESS_TAG,
  writesNothing: 'Nothing was created anywhere. No Stripe, Salesforce or QuickBooks call was made.',
  trace: [
    {
      step: 1,
      stage: 'stripe',
      title: 'Donation form creates a Checkout Session',
      outcome: 'rendered',
    },
    {
      step: 2,
      stage: 'salesforce',
      title: 'payment_intent.succeeded upserts Contact and Transaction__c',
      outcome: 'rendered',
    },
    {
      step: 3,
      stage: 'quickbooks',
      title: 'The accounting path posts the charge',
      outcome: 'rendered',
    },
  ],
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

const verifyExample = {
  tag: 'deployment-smoke-20260405',
  liveMode: false,
  checkoutSessionId: 'cs_test_123',
  expected: {
    'salesforce.Transaction__c': {
      Amount_Gross__c: 53.25,
      Frequency__c: 'onetime',
      Attribution__c: 'Annual Fund',
      Currency_ISO_Code__c: 'USD',
    },
  },
};

const verifyStrictExample = {
  ...verifyExample,
  requireOptional: true,
};

const verifyExamples = {
  standard: asNamedExample(
    'Verify one flow',
    verifyExample,
    'Checks every field the transaction endpoint routes into Stripe and Salesforce. Fields that depend on org configuration are reported as warnings.'
  ),
  strict: asNamedExample(
    'Verify strictly',
    verifyStrictExample,
    'Promotes org-configuration-dependent fields (record types, LeadSource) to hard failures.'
  ),
};

const verifyResponseExample = {
  tag: 'deployment-smoke-20260405',
  marker: '[source_test_tag:deployment-smoke-20260405]',
  liveMode: false,
  ok: true,
  requireOptional: false,
  stripeCustomerId: 'cus_123',
  checkoutSessionId: 'cs_test_123',
  salesforceContactId: '0035f00000AbCdEAAV',
  salesforceTransactionId: 'a0X5f000001AbCdEAK',
  counts: { checked: 60, ok: 59, missing: 0, mismatched: 0, notApplicable: 1 },
  failures: [],
  warnings: [],
  objects: [
    {
      object: 'salesforce.Transaction__c',
      found: true,
      recordId: 'a0X5f000001AbCdEAK',
      counts: { checked: 18, ok: 17, missing: 0, mismatched: 0, notApplicable: 1 },
      fields: [{ field: 'Amount_Gross__c', status: 'ok', required: true, actual: 53.25 }],
    },
  ],
};

const verifyFailureResponseExample = {
  ...verifyResponseExample,
  ok: false,
  counts: { checked: 60, ok: 57, missing: 1, mismatched: 1, notApplicable: 1 },
  failures: [
    'salesforce.Transaction__c.Campaign__c: not populated',
    'salesforce.Transaction__c.Amount_Gross__c: expected 53.25, got 50',
  ],
  warnings: ['salesforce.Contact.LeadSource: not populated'],
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
  qboIds: ['501', '502'],
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
        // Prefilled to test deliberately. This endpoint is anonymous and creates real
        // records — a Stripe customer and Checkout session, plus a Salesforce Contact
        // and Transaction__c. Leaving the selector blank in Swagger means an operator
        // validating the deployment can omit it and silently inherit whichever mode the
        // server defaults to.
        mode: ModeQuerySchema.optional().openapi({
          example: 'test',
          description:
            'Selects the Stripe key used for this request. Keep `test` for validation runs; `live` moves real money.',
        }),
        livemode: BoolLikeQuerySchema.optional().openapi({
          example: 'false',
          description: 'Alternative to `mode`. Keep false for validation runs.',
        }),
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
    'Receives Stripe webhook events and routes them to the appropriate domain handlers.\n\n' +
    'The body examples below are simulated payloads for each stage of the pipeline — charge, refund, dispute, payout, out-of-band invoice, credit note — so each downstream path can be exercised on its own without waiting for a real Checkout session to settle.\n\n' +
    '**These cannot be sent from Swagger as-is.** The handler verifies `stripe-signature` against the configured webhook secret and returns 400 `invalid_signature` for an unsigned body. Replay a signed event with the Stripe CLI instead:\n\n' +
    '    stripe trigger payment_intent.succeeded\n' +
    '    stripe events resend evt_xxx --webhook-endpoint we_xxx\n\n' +
    'Do not enable `TEST_MODE` to work around this: it replaces the Stripe client with a mock that skips verification **and fabricates the event objects**, so the payload you post is not the one processed — and on a live deployment it would let anyone post unauthenticated events into the ledger.\n\n' +
    'To test the Salesforce and QuickBooks stages directly from Swagger, use the operational endpoints (QBO and Ops tags), which take plain JSON over a function key.',
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
          examples: stripeWebhookStageExamples,
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

registerFunction('opsTestQuickbooks', 'Preview the QuickBooks documents a donation would post', {
  handler: opsTestQuickbooks,
  description:
    'Renders the exact QuickBooks document JSON a donation would produce, under **both** posting strategies, and posts none of it by default.\n\n' +
    'It exists because there is no other way to see that JSON before it lands in the books: `POST /api/qbo/manual-sync` has no dry-run mode, and QuickBooks has a single un-branched credential set, so exercising the accounting path against production writes a real document into the real company file.\n\n' +
    '### Input\n\n' +
    'Either an inline `donation` payload (gross cents, covered fee cents, donor, date, designation) or a `chargeId` for a charge that already exists in Stripe. Both work on a dry run.\n\n' +
    '### What a dry run does and does not do\n\n' +
    'A dry run performs no outbound **write**: it creates nothing in QuickBooks, Stripe or Salesforce. It does read when you supply a `chargeId`, because only Stripe can describe an existing charge — the charge and its balance transaction are fetched with retrieves, and nothing is written. Previewing a real charge is what this endpoint is chiefly for, so it does not require you to switch writing on merely to look. An inline `donation` payload makes no outbound call of any kind. Every response reports which it was under `outboundReads`, naming the service read.\n\n' +
    '### What comes back\n\n' +
    'For each strategy: every document, in order, with its DocNumber, its AccountRefs and ItemRefs, and the resolved gross / fee / net. DocNumbers come from the same `buildDocNumber` the posting path uses, so a collision is visible here before it is a duplicate in QuickBooks. AccountRef `value` fields carry the configured *name* rather than a QuickBooks id, because resolving an id is a call this endpoint does not make.\n\n' +
    '**An unresolvable processor fee renders as `feeCents: null` with `feeAvailable: false`, never as 0.** A charge Stripe has not settled — an ACH debit, typically — has no balance transaction, and reporting its fee as zero would read as "Stripe charged nothing" instead of "nobody knows yet".\n\n' +
    '### What `dryRun=false` touches\n\n' +
    'QuickBooks, and nothing else. With an inline donation it calls `postChargeToQbo`, creating the documents shown under the ACTIVE strategy in the connected company file. Each one carries `[source_test_tag:<tag>]` in its `PrivateNote`, so `POST /api/ops/test-artifact-cleanup?tag=<tag>` can find and remove it. A `chargeId` request never posts, on a dry run or otherwise — it reads Stripe and stops there. Stripe and Salesforce are never written by this endpoint.\n\n' +
    'A non-dry-run call with an unknown processor fee is refused rather than posting a guess.',
  tags: ['Ops', 'QBO'],
  operationId: 'opsTestQuickbooks',
  methods: ['POST'],
  ...withFunctionAuth({}),
  route: 'ops/test/quickbooks',
  request: {
    query: TestHarnessQuerySchema,
    body: {
      content: {
        'application/json': {
          schema: TestHarnessQuickbooksRequestSchema,
          example: testHarnessRequestExample,
          examples: testHarnessQuickbooksExamples,
        },
      },
    },
  },
  responses: {
    200: {
      description: 'Documents rendered (and posted, when dryRun=false)',
      content: {
        'application/json': {
          schema: GenericObjectSchema,
          example: testHarnessQuickbooksResponseExample,
          examples: {
            bothStrategies: asNamedExample(
              'Both posting strategies rendered',
              testHarnessQuickbooksResponseExample,
              'sales-receipt produces a receipt plus a paired FEE- journal entry; je-transfer produces one combined entry.'
            ),
            unknownFee: asNamedExample(
              'Unsettled charge — fee unknown',
              {
                ...testHarnessQuickbooksResponseExample,
                amounts: {
                  ...testHarnessQuickbooksResponseExample.amounts,
                  feeAvailable: false,
                  feeCents: null,
                  netCents: null,
                  feeSource: 'UNKNOWN — no balance transaction. This is not a fee of 0.',
                },
              },
              'No balance transaction: the fee is null, and the paired FEE- entry is absent.'
            ),
          },
        },
      },
    },
    400: {
      description:
        'Invalid donation payload, a malformed chargeId, or dryRun=false with an unknown processor fee',
      content: {
        'application/json': {
          schema: GenericErrorResponseSchema,
          example: {
            error: 'invalid_charge_id',
            message: '"ch_nope" is not a Stripe charge id. Expected a ch_… (or legacy py_…) id.',
          },
        },
      },
    },
    404: {
      description: 'The requested Stripe charge does not exist',
      content: {
        'application/json': {
          schema: GenericErrorResponseSchema,
          example: {
            error: 'charge_not_found',
            message: 'Stripe has no charge ch_… in the requested mode.',
          },
        },
      },
    },
    500: {
      description: 'Rendering failed',
      content: {
        'application/json': {
          schema: GenericErrorResponseSchema,
          example: { error: 'internal_error', message: 'Failed to render the QuickBooks preview.' },
        },
      },
    },
  },
});

registerFunction('opsTestSalesforce', 'Preview the Salesforce fields a donation would write', {
  handler: opsTestSalesforce,
  description:
    'Renders the `Contact` and `Transaction__c` field map the `payment_intent.succeeded` webhook would write for a donation, without opening a Salesforce connection.\n\n' +
    'The map is produced by `mapStripeToTransaction` — the same function the webhook calls — and then by `sanitizeTransactionRecord`, the same function `upsertTransaction` applies immediately before DML. It is a preview of the real write, not a second implementation of it.\n\n' +
    '### What to look at\n\n' +
    "`highlights` pulls out the fields that go wrong most often: `Cover_Fees_Amount__c`, `Amount_Fee__c`, `Frequency__c`, `Payment_Method__c` and `Stripe_Livemode__c`. Note that `Cover_Fees_Amount__c` is donor intent (what the donor chose to add) while `Amount_Fee__c` is Stripe's own fee — different numbers, and a frequent source of confusion.\n\n" +
    '`skippedByNullMeansUnknown` lists the fields that would be **dropped from the write** because they are null and appear in the null-means-unknown set (`frequency__c`, `cover_fees__c`, `cover_fees_amount__c`). Null there means "this writer could not determine it", never "clear the value in Salesforce" — the skip is what stops an upsert from wiping donor intent minutes after the gift. The list is computed by the real rule, so it reflects the actual behaviour.\n\n' +
    'The `Contact` is always rendered in its CREATE shape. The live path first queries by `Stripe_Customer_Id__c`, then `Email`, then first+last name, and updates the best match instead — but running that query is a read against the org, and this endpoint makes no outbound call on a dry run.\n\n' +
    '### What a dry run does and does not do\n\n' +
    'A dry run performs no outbound **write**: it creates nothing in Stripe, Salesforce or QuickBooks. This endpoint takes an inline `donation` payload only, so a dry run here makes no outbound call of **any** kind — the response is a pure function of the request body. `outboundReads` on the response says so explicitly, and names the service read when there is one.\n\n' +
    '### What `dryRun=false` touches\n\n' +
    'Salesforce, and nothing else. It find-or-creates the Contact and upserts the `Transaction__c` by `Stripe_Payment_Intent_Id__c`. Both records are removable afterwards: `Memo__c` carries `[source_test_tag:<tag>]` for a human reading the row, and because `Memo__c` is a Long Text Area that SOQL cannot filter, the cleanup tag is also embedded in the synthetic `Stripe_Customer_Id__c` written to the Contact **and** the `Transaction__c` — the one field on both objects a SOQL `LIKE` can match. `POST /api/ops/test-artifact-cleanup?tag=<tag>` queries on it directly, so it finds these rows even though the customer exists nowhere in Stripe. Stripe and QuickBooks are never touched.',
  tags: ['Ops', 'Salesforce'],
  operationId: 'opsTestSalesforce',
  methods: ['POST'],
  ...withFunctionAuth({}),
  route: 'ops/test/salesforce',
  request: {
    query: TestHarnessQuerySchema,
    body: {
      content: {
        'application/json': {
          schema: TestHarnessRequestSchema,
          example: testHarnessRequestExample,
          examples: testHarnessExamples,
        },
      },
    },
  },
  responses: {
    200: {
      description: 'Field map rendered (and written, when dryRun=false)',
      content: {
        'application/json': {
          schema: GenericObjectSchema,
          example: testHarnessSalesforceResponseExample,
          examples: {
            fieldMap: asNamedExample(
              'Contact and Transaction__c field map',
              testHarnessSalesforceResponseExample,
              'Exactly what the webhook path would send, after the null-means-unknown rule.'
            ),
          },
        },
      },
    },
    400: {
      description: 'Invalid synthetic donation payload',
      content: {
        'application/json': {
          schema: GenericErrorResponseSchema,
          example: { error: 'invalid_donation', message: 'donor.email: Invalid email' },
        },
      },
    },
    500: {
      description: 'Rendering failed',
      content: {
        'application/json': {
          schema: GenericErrorResponseSchema,
          example: { error: 'internal_error', message: 'Failed to render the Salesforce preview.' },
        },
      },
    },
  },
});

registerFunction('opsTestStripe', 'Preview the Checkout Session a donation would create', {
  handler: opsTestStripe,
  description:
    'Renders the exact `stripe.checkout.sessions.create` argument object the donation form would send, without contacting Stripe.\n\n' +
    'The arguments come from `buildCheckoutSessionParams`, the same function `POST /api/transaction` calls — split out of `createCheckoutSession` so it can run without a Stripe client. Line items, `payment_method_types` and metadata mirroring are therefore the real ones.\n\n' +
    '### What to look at\n\n' +
    '`mode` resolves to `payment` for a one-time gift and `subscription` for anything recurring.\n\n' +
    '`metadata` is reported three times over, and the difference matters: Stripe does **not** copy Checkout Session metadata onto the PaymentIntent or the Subscription it creates. Donor intent — `frequency`, `cover_fees_amount` — is only visible to the `payment_intent.succeeded` webhook because it is mirrored onto `payment_intent_data.metadata` (one-time) or `subscription_data.metadata` (recurring). A key present on the session but missing from the mirror is a key Salesforce will never see.\n\n' +
    '### What a dry run does and does not do\n\n' +
    'A dry run performs no outbound **write**: it creates nothing in Stripe, Salesforce or QuickBooks. This endpoint takes an inline `donation` payload only, so a dry run here makes no outbound call of **any** kind — the response is a pure function of the request body. `outboundReads` on the response says so explicitly, and names the service read when there is one.\n\n' +
    '### What `dryRun=false` touches\n\n' +
    'Stripe, and **only in test mode**. A live-mode request is rejected outright: a harness that can create a live Checkout Session is a harness that can take real money from a real card. The customer is resolved first through `resolveStripeCustomerId` — the same find-or-create `POST /api/transaction` uses — because Stripe rejects a `customer:` it never issued; the `customer` field a dry run renders is a placeholder, not a sendable id. The customer carries `source_test_tag=<tag>` in its metadata, as do the created session and the mirrored `payment_intent_data` / `subscription_data` metadata, which is the key `POST /api/ops/test-artifact-cleanup?tag=<tag>` searches on. Salesforce and QuickBooks are never touched.',
  tags: ['Ops', 'Stripe'],
  operationId: 'opsTestStripe',
  methods: ['POST'],
  ...withFunctionAuth({}),
  route: 'ops/test/stripe',
  request: {
    query: TestHarnessStripeQuerySchema,
    body: {
      content: {
        'application/json': {
          schema: TestHarnessRequestSchema,
          example: testHarnessRequestExample,
          examples: testHarnessExamples,
        },
      },
    },
  },
  responses: {
    200: {
      description: 'Create arguments rendered (and the session created, when dryRun=false)',
      content: {
        'application/json': {
          schema: GenericObjectSchema,
          example: testHarnessStripeResponseExample,
          examples: {
            oneTime: asNamedExample(
              'One-time gift — mode: payment',
              testHarnessStripeResponseExample,
              'Metadata is mirrored onto payment_intent_data so the webhook can read donor intent.'
            ),
          },
        },
      },
    },
    400: {
      description: 'Invalid payload, or a live-mode non-dry-run request',
      content: {
        'application/json': {
          schema: GenericErrorResponseSchema,
          example: {
            error: 'live_mode_not_permitted',
            message: 'A non-dry-run Stripe call from this test harness is restricted to test mode.',
          },
        },
      },
    },
    500: {
      description: 'Rendering failed',
      content: {
        'application/json': {
          schema: GenericErrorResponseSchema,
          example: { error: 'internal_error', message: 'Failed to render the Stripe preview.' },
        },
      },
    },
  },
});

registerFunction('opsTestDonation', 'Trace one donation through all three systems', {
  handler: opsTestDonation,
  description:
    'Runs a single synthetic donation through Stripe, Salesforce and QuickBooks in pipeline order and returns a step-by-step trace: the Checkout Session arguments the form would send, the Salesforce field map the webhook would write, and the QuickBooks documents the accounting path would post.\n\n' +
    'Use it to see one gift end to end — where an amount changes units, where donor intent has to be mirrored to survive, where the processor fee first becomes known. Each step is the same computation the corresponding `/api/ops/test/*` endpoint performs, so a discrepancy between the trace and a single-stage call would be a bug.\n\n' +
    'A step that throws is reported as `outcome: "failed"` with its error, and the remaining steps still run.\n\n' +
    '### What a dry run does and does not do\n\n' +
    'A dry run performs no outbound **write**: it creates nothing in Stripe, Salesforce or QuickBooks. This endpoint takes an inline `donation` payload only, so a dry run here makes no outbound call of **any** kind — the response is a pure function of the request body. `outboundReads` on the response says so explicitly, and names the service read when there is one.\n\n' +
    '### What `dryRun=false` touches\n\n' +
    'Nothing — it is refused. This endpoint is dry-run only. Running one payload through all three systems for real means three separate writes whose failure modes interleave; exercise them one at a time with `POST /api/ops/test/stripe`, `/salesforce` and `/quickbooks`, each with `dryRun=false`.\n\n' +
    'The trace still reports the `source_test_tag` marker each stage would stamp, so you can see what `POST /api/ops/test-artifact-cleanup` would later match before committing to a write.',
  tags: ['Ops', 'Stripe', 'Salesforce', 'QBO'],
  operationId: 'opsTestDonation',
  methods: ['POST'],
  ...withFunctionAuth({}),
  route: 'ops/test/donation',
  request: {
    query: TestHarnessQuerySchema,
    body: {
      content: {
        'application/json': {
          schema: TestHarnessRequestSchema,
          example: testHarnessRequestExample,
          examples: testHarnessExamples,
        },
      },
    },
  },
  responses: {
    200: {
      description: 'Step-by-step trace rendered',
      content: {
        'application/json': {
          schema: GenericObjectSchema,
          example: testHarnessDonationResponseExample,
          examples: {
            fullTrace: asNamedExample(
              'Stripe → Salesforce → QuickBooks',
              testHarnessDonationResponseExample,
              'Three steps, in the order the real pipeline runs them.'
            ),
          },
        },
      },
    },
    400: {
      description: 'Invalid payload, or dryRun=false',
      content: {
        'application/json': {
          schema: GenericErrorResponseSchema,
          example: {
            error: 'dry_run_only',
            message: 'The end-to-end trace is a dry run only.',
          },
        },
      },
    },
    500: {
      description: 'Trace failed',
      content: {
        'application/json': {
          schema: GenericErrorResponseSchema,
          example: { error: 'internal_error', message: 'Failed to render the donation trace.' },
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

registerFunction('testArtifactVerify', 'Verify field population for a tagged test run', {
  handler: testArtifactVerify,
  description:
    'Reads back everything `POST /api/transaction` created for a tag — the Stripe customer and Checkout session, and the Salesforce Contact and Transaction__c — and reports, field by field, whether each one was populated and routed to the right place.\n\n' +
    'Run this **after** the transaction and **before** cleanup. Give the search indexes a moment first: Stripe search lags by up to ~60s, so a verification issued immediately after the transaction can report records as missing that do exist.\n\n' +
    'Pass `checkoutSessionId` (the `id` from the transaction response) whenever you have it — it pins verification to exactly the records that request produced, instead of resolving them by tag.\n\n' +
    '### What is checked\n\n' +
    'Cross-system links are derived server-side and always enforced: the Transaction__c must carry the session and customer ids, must point at the Contact that was synced, and the Stripe customer must carry that Contact id back in `metadata.salesforce_id`. Values you supply in `expected` are compared against what actually landed, so a field populated with the wrong value fails rather than passing as "populated".\n\n' +
    'The field list assumes a payload that fills in every input the transaction endpoint accepts. If your payload omits an input — no phone, no organization, no cover fee — list the affected field paths in `optionalFields` so they are reported without failing the run.\n\n' +
    'Fields that depend on org configuration (Transaction__c record type, Contact LeadSource) are warnings by default; set `requireOptional: true` to make them failures. Fields the org does not define at all are reported as `not-applicable`.\n\n' +
    'Returns 200 when every required field checks out and 422 when the records were read but did not match — a 500 means the check itself could not run.',
  tags: ['Ops', 'Stripe', 'Salesforce'],
  operationId: 'testArtifactVerify',
  methods: ['POST'],
  ...withFunctionAuth({}),
  route: 'ops/test-artifact-verify',
  request: {
    body: {
      content: {
        'application/json': {
          schema: TestArtifactVerifyRequestSchema,
          example: verifyExample,
          examples: verifyExamples,
        },
      },
    },
  },
  responses: {
    200: {
      description: 'Every required field was populated as expected',
      content: {
        'application/json': {
          schema: GenericObjectSchema,
          example: verifyResponseExample,
        },
      },
    },
    400: {
      description: 'Invalid verification request',
      content: {
        'application/json': {
          schema: GenericErrorResponseSchema,
          example: { error: 'bad_request', message: 'A verification tag is required.' },
        },
      },
    },
    422: {
      description: 'Records were read but one or more required fields did not match',
      content: {
        'application/json': {
          schema: GenericObjectSchema,
          example: verifyFailureResponseExample,
        },
      },
    },
    500: {
      description: 'Verification could not be executed',
      content: {
        'application/json': {
          schema: GenericErrorResponseSchema,
          example: { error: 'verification_failed', message: 'Missing Stripe test secret key.' },
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
    'unsynced receipts as Salesforce Transaction__c records. Supports dry-run mode and explicit qboIds ' +
    'for targeted resyncs of one or more SalesReceipt records. Set resyncFromSalesforce=true with qboIds ' +
    'to patch existing QBO SalesReceipts from matching Salesforce Transaction__c records (QBO_Doc_Id__c).',
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
      'Set deleteDuplicates=true with dryRun=false to permanently remove extras (oldest record is kept). ' +
      'Use onlyPayouts=true to scope checks to payout IDs and use dryRun=true to review plannedActions before delete mode.',
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
              onlyPayouts: true,
              dateRange: { startDate: null, endDate: null },
              qbo: {
                checked: 42,
                duplicateGroups: [],
                deleted: 0,
                errors: [],
                plannedActions: { qbo: [] },
              },
              salesforce: {
                checked: 38,
                duplicateGroups: [],
                deleted: 0,
                errors: [],
                plannedActions: { salesforce: [] },
              },
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

// ---------------------------------------------------------------------------
// Daily Reconciliation — query schema and all Swagger examples
// ---------------------------------------------------------------------------

const DailyReconciliationQuerySchema = z
  .object({
    date: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional(),
    startDate: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional(),
    endDate: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional(),
    dryRun: BoolLikeQuerySchema.optional().openapi({
      example: 'true',
      description:
        'Leave true. This handler issues live DML against Salesforce and the QuickBooks general ledger, has no idempotency guard, and silently truncates at LIMIT 2000. Treat any write-mode run as a supervised operation.',
    }),
    mode: ModeQuerySchema.optional().openapi({ example: 'test' }),
    systems: z.string().optional().openapi({ example: 'stripe,salesforce,qbo' }),
    limit: PositiveIntLikeSchema.optional().openapi({ example: '25' }),
    syncIds: z.string().optional().openapi({
      description: 'Comma-separated Salesforce Ids to target instead of a whole day.',
    }),
  })
  .passthrough();

// --- reusable response building blocks ---

const reconBaseCounts = {
  stripe: { charges: 8, refunds: 1, payouts: 1 },
  salesforce: { transactions: 10 },
  qbo: { salesReceipts: 8, journalEntries: 2, deposits: 1 },
};

const reconEmptyDiscrepancies = {
  stripeMissingSalesforce: [],
  stripeMissingQbo: [],
  salesforceMissingQbo: [],
  salesforceMissingStripe: [],
  qboMissingSalesforce: [],
  duplicatesInSalesforce: [],
  duplicatesInQbo: [],
};

// 1. Clean run — everything in sync
const reconCleanResponse = {
  success: true,
  dryRun: true,
  liveMode: false,
  range: { startDate: '2026-05-28', endDate: '2026-05-28' },
  systemsChecked: ['stripe', 'salesforce', 'qbo'],
  counts: reconBaseCounts,
  discrepancies: reconEmptyDiscrepancies,
  summary: { totalDiscrepancies: 0, categories: {} },
  syncSelection: { requestedIds: [], matchedIds: [], unmatchedIds: [] },
  errors: [],
  triggeredAt: '2026-05-29T09:00:00.000Z',
  triggeredBy: 'http',
};

// 2. Stripe charge landed in Stripe but never synced to Salesforce
const reconStripeMissingSfResponse = {
  ...reconCleanResponse,
  counts: {
    ...reconBaseCounts,
    stripe: { charges: 9, refunds: 1, payouts: 1 },
    salesforce: { transactions: 8 },
  },
  discrepancies: {
    ...reconEmptyDiscrepancies,
    stripeMissingSalesforce: [
      {
        system: 'stripe',
        type: 'stripe_only_charge',
        id: 'ch_3PfABC',
        description: 'charge exists in Stripe but has no matching Salesforce Transaction__c',
        stripeId: 'ch_3PfABC',
        amount: 250.0,
        date: '2026-05-28',
        relatedIds: ['ch_3PfABC', 'pi_3PfPI', 'bt_3PfBT'],
        details: {
          sourceSystem: 'stripe',
          missingIn: 'salesforce',
          recordType: 'charge',
          paymentIntentId: 'pi_3PfPI',
          balanceTransactionId: 'bt_3PfBT',
          currency: 'usd',
          status: 'succeeded',
          livemode: false,
        },
      },
    ],
  },
  summary: { totalDiscrepancies: 1, categories: { stripeMissingSalesforce: 1 } },
};

// 3. Salesforce row exists but was never posted to QBO
const reconSfMissingQboResponse = {
  ...reconCleanResponse,
  counts: {
    ...reconBaseCounts,
    qbo: { salesReceipts: 7, journalEntries: 2, deposits: 1 },
  },
  discrepancies: {
    ...reconEmptyDiscrepancies,
    salesforceMissingQbo: [
      {
        system: 'salesforce',
        type: 'sf_missing_qbo',
        id: 'a1aUQ00000AAAAAYAA',
        description: 'Salesforce Transaction__c has no QuickBooks document link',
        stripeId: 'ch_3PfXXX',
        amount: 150.0,
        date: '2026-05-28',
      },
    ],
  },
  summary: { totalDiscrepancies: 1, categories: { salesforceMissingQbo: 1 } },
};

// 4. QBO receipt contains a Stripe ID not found anywhere in Salesforce
const reconQboOrphanResponse = {
  ...reconCleanResponse,
  discrepancies: {
    ...reconEmptyDiscrepancies,
    qboMissingSalesforce: [
      {
        system: 'qbo',
        type: 'qbo_only',
        id: '10455',
        description: 'QBO SalesReceipt references Stripe ID ch_3PfORPH not found in Salesforce',
        stripeId: 'ch_3PfORPH',
        amount: 75.0,
        date: '2026-05-28',
      },
    ],
  },
  summary: { totalDiscrepancies: 1, categories: { qboMissingSalesforce: 1 } },
};

// 5. Two Salesforce rows share the same Stripe charge ID (webhook fired twice)
const reconSfDuplicatesResponse = {
  ...reconCleanResponse,
  discrepancies: {
    ...reconEmptyDiscrepancies,
    duplicatesInSalesforce: [
      {
        system: 'salesforce',
        type: 'duplicate_sf',
        id: 'a1aUQ00000BBBBBYA, a1aUQ00000CCCCCY',
        description: '2 Salesforce Transaction__c rows share Stripe ID ch_3PfDUP',
        stripeId: 'ch_3PfDUP',
      },
    ],
  },
  summary: { totalDiscrepancies: 1, categories: { duplicatesInSalesforce: 1 } },
};

// 6. Multiple discrepancy types at once (realistic noisy day)
const reconMultiDiscrepancyResponse = {
  ...reconCleanResponse,
  counts: {
    stripe: { charges: 10, refunds: 1, payouts: 1 },
    salesforce: { transactions: 9 },
    qbo: { salesReceipts: 8, journalEntries: 2, deposits: 1 },
  },
  discrepancies: {
    stripeMissingSalesforce: [
      {
        system: 'stripe',
        type: 'stripe_only_charge',
        id: 'ch_3PfNEW',
        description: 'charge exists in Stripe but has no matching Salesforce Transaction__c',
        stripeId: 'ch_3PfNEW',
        amount: 500.0,
        date: '2026-05-28',
      },
    ],
    stripeMissingQbo: [],
    salesforceMissingQbo: [
      {
        system: 'salesforce',
        type: 'sf_missing_qbo',
        id: 'a1aUQ00000DDDDDYAA',
        description: 'Salesforce Transaction__c has no QuickBooks document link',
        stripeId: 'ch_3PfOLD',
        amount: 100.0,
        date: '2026-05-27',
      },
    ],
    salesforceMissingStripe: [],
    qboMissingSalesforce: [],
    duplicatesInSalesforce: [],
    duplicatesInQbo: [],
  },
  summary: {
    totalDiscrepancies: 2,
    categories: { stripeMissingSalesforce: 1, salesforceMissingQbo: 1 },
  },
};

// 11. Dry-run scoped to provided syncIds only
const reconTargetedDryRunResponse = {
  ...reconCleanResponse,
  discrepancies: {
    ...reconEmptyDiscrepancies,
    salesforceMissingQbo: [
      {
        system: 'salesforce',
        type: 'sf_missing_qbo',
        id: 'a1aUQ00000DDDDDYAA',
        description: 'Salesforce Transaction__c has no QuickBooks document link',
        stripeId: 'ch_3PfOLD',
        amount: 100.0,
        date: '2026-05-27',
      },
    ],
  },
  summary: {
    totalDiscrepancies: 1,
    categories: { salesforceMissingQbo: 1 },
  },
  syncSelection: {
    requestedIds: ['a1aUQ00000DDDDDYAA', 'ch_not_found'],
    matchedIds: ['a1aUQ00000DDDDDYAA'],
    unmatchedIds: ['ch_not_found'],
  },
};

// 7. One system failed to respond (partial error, returns HTTP 207)
const reconPartialErrorResponse = {
  ...reconCleanResponse,
  counts: {
    stripe: { charges: 0, refunds: 0, payouts: 0 },
    salesforce: { transactions: 0 },
    qbo: { salesReceipts: 0, journalEntries: 0, deposits: 0 },
  },
  discrepancies: reconEmptyDiscrepancies,
  summary: { totalDiscrepancies: 0, categories: {} },
  errors: ['Salesforce query failed: QUERY_TIMEOUT — exceeded max time limit for processing'],
};

// 8. Stripe-only check (fastest — skips QBO entirely)
const reconStripeVsSfResponse = {
  ...reconCleanResponse,
  systemsChecked: ['stripe', 'salesforce'],
  counts: {
    stripe: { charges: 8, refunds: 1, payouts: 1 },
    salesforce: { transactions: 10 },
    qbo: { salesReceipts: 0, journalEntries: 0, deposits: 0 },
  },
  discrepancies: reconEmptyDiscrepancies,
  summary: { totalDiscrepancies: 0, categories: {} },
};

// 9. Salesforce-vs-QBO only (no Stripe API calls)
const reconSfVsQboResponse = {
  ...reconCleanResponse,
  systemsChecked: ['salesforce', 'qbo'],
  counts: {
    stripe: { charges: 0, refunds: 0, payouts: 0 },
    salesforce: { transactions: 10 },
    qbo: { salesReceipts: 8, journalEntries: 2, deposits: 1 },
  },
  discrepancies: reconEmptyDiscrepancies,
  summary: { totalDiscrepancies: 0, categories: {} },
};

// 10. Multi-day range check
const reconDateRangeResponse = {
  ...reconCleanResponse,
  range: { startDate: '2026-05-01', endDate: '2026-05-07' },
  counts: {
    stripe: { charges: 47, refunds: 3, payouts: 5 },
    salesforce: { transactions: 55 },
    qbo: { salesReceipts: 44, journalEntries: 8, deposits: 5 },
  },
  discrepancies: reconEmptyDiscrepancies,
  summary: { totalDiscrepancies: 0, categories: {} },
};

registerFunction('dailyReconciliation', 'Cross-system daily reconciliation check', {
  handler: dailyReconciliation,
  description:
    '**Reconciliation walkthrough**\n\n' +
    'Compares Stripe, Salesforce, and QuickBooks for a given date range and returns a structured ' +
    'discrepancy report. Always read-only in dry-run mode (the default). Nothing is written, ' +
    'deleted, or modified.\n\n' +
    '**How to use it**\n\n' +
    '1. **Quick probe** — hit `Try it out` with no parameters. Defaults to `dryRun=true`, ' +
    "`mode=test`, yesterday's date, and all three systems. The `counts` block confirms each " +
    'API was reached; `summary.totalDiscrepancies: 0` means everything is clean.\n\n' +
    '2. **Specific date** — add `date=YYYY-MM-DD` to reconcile a single past day.\n\n' +
    '3. **Date range** — use `startDate` + `endDate` for multi-day sweeps (e.g. after a ' +
    'deployment or data migration).\n\n' +
    '4. **Scope to two systems** — set `systems=stripe,salesforce` to skip QBO API calls, or ' +
    '`systems=salesforce,qbo` to skip Stripe. Useful when one system is slow or rate-limited.\n\n' +
    '5. **Limit record volume** — add `limit=50` to cap records per entity. Good for fast ' +
    'spot-checks during high-traffic days.\n\n' +
    '6. **Targeted sync preview** — add `syncIds=id1,id2,...` with `dryRun=true` to return only sync-targeted ' +
    'discrepancies for the specified IDs, so you can verify the exact update list before writing changes. ' +
    'Then run the same request with `dryRun=false` to apply only that targeted set. IDs can be Salesforce IDs, ' +
    'Stripe IDs (`ch_`, `pi_`, `re_`, `po_`, `bt_`), or QBO doc IDs. The response includes ' +
    '`syncSelection.matchedIds` and `syncSelection.unmatchedIds`.\n\n' +
    '**What the discrepancy categories mean**\n\n' +
    '- `stripeMissingSalesforce` — Stripe charges/refunds/payouts with no `Transaction__c` row. ' +
    'Fix with `/api/stripe/true-up`.\n' +
    '- `stripeMissingQbo` — Stripe charges with no QBO SalesReceipt. Fix with `/api/stripe/true-up` ' +
    '(`bypassQbo=false`).\n' +
    '- `salesforceMissingQbo` — `Transaction__c` rows where `Posted_to_QBO__c` is false or ' +
    '`QBO_Doc_Id__c` is blank. Fix with `/api/qbo/salesforce-record-sync`.\n' +
    '- `salesforceMissingStripe` — `Transaction__c` rows with no Stripe ID at all (QBO-origin ' +
    'imports/manual entries are excluded; only Stripe-origin types are checked).\n' +
    '- `qboMissingSalesforce` — QBO documents whose DocNumber or PrivateNote Stripe ID is not in ' +
    'Salesforce. Fix with `/api/qbo/receipts-salesforce-sync`.\n' +
    '- `duplicatesInSalesforce` — multiple `Transaction__c` rows sharing one Stripe ID. Fix with ' +
    '`/api/ops/stripe-duplicate-check?deleteDuplicates=true`.\n' +
    '- `duplicatesInQbo` — multiple QBO documents sharing one Stripe ID. Same fix endpoint.\n\n' +
    'The timer trigger runs at **02:00 UTC daily** when `ENABLE_DAILY_RECONCILIATION_TIMER=true`.',
  tags: ['Ops'],
  operationId: 'dailyReconciliation',
  methods: ['GET', 'POST'],
  ...withFunctionAuth({}),
  route: 'ops/daily-reconciliation',
  request: {
    query: DailyReconciliationQuerySchema,
  },
  responses: {
    200: {
      description: 'Reconciliation complete — no errors',
      content: {
        'application/json': {
          schema: GenericSuccessResponseSchema,
          example: reconCleanResponse,
          examples: {
            // ── Starting points ──────────────────────────────────────────
            quickProbe: asNamedExample(
              '1. Quick probe (start here)',
              {
                request: { mode: 'test', dryRun: 'true', limit: '25' },
                response: reconCleanResponse,
              },
              'Fastest way to validate all three systems are reachable and returning data. ' +
                'Omit the date to default to yesterday. The counts block confirms each API was reached. ' +
                'totalDiscrepancies: 0 means everything is in sync.'
            ),
            singleDate: asNamedExample(
              '2. Single date dry-run',
              {
                request: { date: '2026-05-28', mode: 'test', dryRun: 'true' },
                response: reconCleanResponse,
              },
              'Reconcile a specific past date. Useful after a webhook outage or deployment to ' +
                'confirm the affected day is fully synced.'
            ),
            dateRange: asNamedExample(
              '3. Multi-day date range',
              {
                request: {
                  startDate: '2026-05-01',
                  endDate: '2026-05-07',
                  mode: 'test',
                  dryRun: 'true',
                },
                response: reconDateRangeResponse,
              },
              'Sweep a full week. counts reflects the full volume across all three systems for ' +
                'the range. Useful after a data migration or when catching up after an outage.'
            ),
            stripeVsSalesforceOnly: asNamedExample(
              '4. Stripe vs Salesforce only (skip QBO)',
              {
                request: {
                  date: '2026-05-28',
                  systems: 'stripe,salesforce',
                  mode: 'test',
                  dryRun: 'true',
                },
                response: reconStripeVsSfResponse,
              },
              'Skips all QBO API calls — runs faster and avoids QBO rate limits. ' +
                'Good for a quick Stripe→Salesforce spot-check.'
            ),
            salesforceVsQboOnly: asNamedExample(
              '5. Salesforce vs QBO only (skip Stripe)',
              {
                request: { date: '2026-05-28', systems: 'salesforce,qbo', dryRun: 'true' },
                response: reconSfVsQboResponse,
              },
              'Skips Stripe API calls entirely. Useful when you want to verify QBO posting ' +
                'status without consuming Stripe API quota.'
            ),
            // ── Discrepancy scenarios ─────────────────────────────────────
            foundStripeMissingSalesforce: asNamedExample(
              '6. Finding: charge in Stripe, not in Salesforce',
              {
                request: { date: '2026-05-28', mode: 'test', dryRun: 'true' },
                response: reconStripeMissingSfResponse,
              },
              'stripeMissingSalesforce contains one entry: ch_3PfABC exists in Stripe but has no ' +
                'matching Transaction__c row. Fix: run /api/stripe/true-up?from=2026-05-28&type=payments&mode=test.'
            ),
            foundSalesforceMissingQbo: asNamedExample(
              '7. Finding: Salesforce row not posted to QBO',
              {
                request: { date: '2026-05-28', dryRun: 'true' },
                response: reconSfMissingQboResponse,
              },
              'salesforceMissingQbo contains one entry: Transaction__c a1aUQ00000AAAAAYAA has ' +
                'Posted_to_QBO__c = false. Fix: run /api/qbo/salesforce-record-sync?salesforceId=a1aUQ00000AAAAAYAA.'
            ),
            targetedDryRunBySyncIds: asNamedExample(
              '8. Dry-run targeted by syncIds',
              {
                request: {
                  date: '2026-05-28',
                  dryRun: 'true',
                  syncIds: 'a1aUQ00000DDDDDYAA,ch_not_found',
                },
                response: reconTargetedDryRunResponse,
              },
              'When syncIds are provided in dry-run mode, the response discrepancy list is scoped to ' +
                'sync-targeted categories for matching IDs only. Use syncSelection.matchedIds and ' +
                'syncSelection.unmatchedIds to confirm the exact repair set before rerunning with dryRun=false.'
            ),
            foundQboOrphan: asNamedExample(
              '9. Finding: QBO receipt has no Salesforce match',
              {
                request: { date: '2026-05-28', dryRun: 'true' },
                response: reconQboOrphanResponse,
              },
              'qboMissingSalesforce contains one entry: QBO SalesReceipt 10455 embeds Stripe ID ' +
                'ch_3PfORPH in its DocNumber, but no Salesforce row references that charge. ' +
                'Fix: run /api/qbo/receipts-salesforce-sync?start_date=2026-05-28&end_date=2026-05-28.'
            ),
            foundSalesforceDuplicates: asNamedExample(
              '10. Finding: duplicate Transaction__c rows for same charge',
              {
                request: { date: '2026-05-28', dryRun: 'true' },
                response: reconSfDuplicatesResponse,
              },
              'duplicatesInSalesforce contains one entry: two Transaction__c records share ' +
                'Stripe_Charge_Id__c = ch_3PfDUP. The id field lists both SF record IDs. ' +
                'Fix: run /api/ops/stripe-duplicate-check?startDate=2026-05-28&deleteDuplicates=true&dryRun=false.'
            ),
            foundMultipleDiscrepancies: asNamedExample(
              '11. Finding: multiple discrepancy types at once',
              {
                request: { date: '2026-05-28', mode: 'test', dryRun: 'true' },
                response: reconMultiDiscrepancyResponse,
              },
              'A realistic noisy day: one Stripe charge never landed in Salesforce, and one ' +
                'older Salesforce row was never posted to QBO. summary.categories shows both ' +
                'affected keys and their counts.'
            ),
          },
        },
      },
    },
    207: {
      description:
        'Reconciliation completed with partial errors — one or more systems failed to respond',
      content: {
        'application/json': {
          schema: GenericSuccessResponseSchema,
          example: reconPartialErrorResponse,
          examples: {
            salesforceTimeout: asNamedExample(
              'Salesforce query timed out',
              {
                request: { date: '2026-05-28', dryRun: 'true' },
                response: reconPartialErrorResponse,
              },
              'The handler still returns a result when one system fails. counts for the failed ' +
                'system will be all zeros. The errors array explains what failed. Other systems ' +
                'that did respond are still cross-referenced against each other.'
            ),
          },
        },
      },
    },
    400: {
      description: 'Invalid parameters',
      content: {
        'application/json': {
          schema: GenericErrorResponseSchema,
          examples: {
            badDate: asNamedExample(
              'Invalid date format',
              {
                error: 'bad_request',
                message: 'Invalid date format: "2026-13-01". Use YYYY-MM-DD.',
              },
              'Returned when date, startDate, or endDate does not match YYYY-MM-DD or is not a valid calendar date.'
            ),
            reversedRange: asNamedExample(
              'Date range reversed',
              {
                error: 'bad_request',
                message: 'startDate (2026-05-07) must not be after endDate (2026-05-01).',
              },
              'Returned when startDate is later than endDate.'
            ),
          },
        },
      },
    },
    500: {
      description: 'Reconciliation failed entirely',
      content: {
        'application/json': {
          schema: GenericErrorResponseSchema,
          example: {
            error: 'internal_error',
            message: 'Daily reconciliation failed unexpectedly.',
          },
        },
      },
    },
  },
});

// Register the daily reconciliation timer trigger (runs at 02:00 UTC every day)
// Enable via environment variable: ENABLE_DAILY_RECONCILIATION_TIMER=true
app.timer('dailyReconciliationTimer', {
  schedule: '0 0 2 * * *', // 02:00 UTC daily
  handler: dailyReconciliationTimer,
  runOnStartup: false,
});

// Export for testing
export {
  healthCheck,
  processTransaction,
  stripeWebhook,
  payoutSyncTrigger,
  stripeTrueUp,
  manualQboSync,
  testArtifactCleanup,
  testArtifactVerify,
  salesforcePaymentsSync,
  qboCustomersSync,
  salesforceRecordQboSync,
  stripeDuplicateCheck,
  dailyReconciliation,
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
