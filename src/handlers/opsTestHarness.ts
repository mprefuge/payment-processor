import type { HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions';
import type Stripe from 'stripe';

import { buildTestArtifactMarker } from '../lib/testArtifactTagging';
import { postChargeToQbo, type Fetcher } from '../services/qboSvc';
import { buildSalesforceConfig, SalesforceService } from '../services/salesforceService';
import { createSalesforceSvc, type SalesforceSvc } from '../services/salesforceSvc';
import { stripeClientFactory } from '../services/stripeClientFactory';
import {
  buildQboPreviewForCharge,
  buildQuickBooksPreviewFromContext,
} from '../services/testHarness/quickbooksPreview';
import {
  NO_OUTBOUND_READS,
  parseHarnessRequest,
  rejectLiveMode,
  respond,
  stripeChargeReads,
} from '../services/testHarness/request';
import { buildSalesforcePreview } from '../services/testHarness/salesforcePreview';
import {
  buildHarnessCustomerDetails,
  buildStripePreview,
} from '../services/testHarness/stripePreview';
import {
  buildSyntheticStripeContext,
  type ResolvedDonation,
  type SyntheticStripeContext,
} from '../services/testHarness/syntheticDonation';
import type { StripeCustomerContext } from '../services/qboSvc';

/**
 * `POST /api/ops/test/{quickbooks,salesforce,stripe,donation}`
 *
 * One stage of the donation pipeline per endpoint, exercisable on its own from Swagger,
 * with `dryRun` defaulting to TRUE everywhere. A dry run performs no outbound WRITE: it
 * creates nothing in Stripe, QuickBooks or Salesforce. That is the invariant the unit tests
 * assert by handing every dependency in as a spy and checking no write path was invoked.
 *
 * A dry run may still READ, and does so only where the caller asked about something only the
 * remote system can describe — a `chargeId` on the QuickBooks endpoint, which is read out of
 * Stripe with retrieves alone. The inline-synthetic-donation path makes no outbound call of
 * any kind. Every response says which it was under `outboundReads`.
 *
 * When `dryRun=false`, every record created carries the cleanup marker
 * `[source_test_tag:<tag>]` (QuickBooks PrivateNote and Salesforce Memo__c) or
 * `source_test_tag=<tag>` (Stripe metadata), so
 * `POST /api/ops/test-artifact-cleanup?tag=<tag>` can find and remove it afterwards.
 *
 * Salesforce needs a second copy of the tag to be cleanable at all: `Memo__c` is a Long Text
 * Area and SOQL cannot filter on it. Both the `Contact` and the `Transaction__c` therefore
 * carry the tag inside `Stripe_Customer_Id__c`, which is filterable on both objects, so
 * cleanup can reach rows keyed on a customer Stripe has never issued.
 */

export interface HarnessDependencies {
  getStripeClient: (livemode: boolean) => Stripe;
  postChargeToQbo: typeof postChargeToQbo;
  getSalesforceSvc: () => Promise<SalesforceSvc>;
  /**
   * Find-or-create the Stripe customer a real Checkout Session is opened against. The same
   * function `POST /api/transaction` uses, so `customer:` is an id Stripe actually knows.
   */
  resolveStripeCustomerId: (
    stripe: Stripe,
    customerDetails: Record<string, unknown>
  ) => Promise<string>;
  /** Handed to the QBO posting path so a test can assert it is never called on a dry run. */
  qboFetcher?: Fetcher;
}

/**
 * `stripeCustomerWorkflow` is CommonJS and pulls in the donation form's own dependency
 * graph, so it is required at call time rather than imported at module load — the same
 * shape `src/services/container.ts` and `src/handlers/stripeWebhook.ts` use. Every caller
 * that writes injects this dependency, so the require only runs in the function app.
 */
const loadStripeCustomerResolver = (): HarnessDependencies['resolveStripeCustomerId'] => {
  const { resolveStripeCustomerId } = require('./processTransaction/stripeCustomerWorkflow');
  return resolveStripeCustomerId;
};

const createDefaultDependencies = (): HarnessDependencies => ({
  getStripeClient: (livemode: boolean) => stripeClientFactory.getClient(livemode),
  postChargeToQbo,
  resolveStripeCustomerId: (stripe, customerDetails) =>
    loadStripeCustomerResolver()(stripe, customerDetails),
  getSalesforceSvc: async () => {
    const service = new SalesforceService(buildSalesforceConfig());
    const connection = await service.authenticate();
    return createSalesforceSvc({ connection });
  },
});

let dependencyOverrides: Partial<HarnessDependencies> | null = null;

/** Test seam. Never called by the running function app. */
export const __setTestDependencies = (deps: Partial<HarnessDependencies> | null): void => {
  dependencyOverrides = deps;
};

const resolveDependencies = (): HarnessDependencies => ({
  ...createDefaultDependencies(),
  ...(dependencyOverrides ?? {}),
});

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const toStripeContext = (stripe: SyntheticStripeContext): StripeCustomerContext => ({
  charge: stripe.charge,
  paymentIntent: stripe.paymentIntent,
  customer: stripe.customer,
  checkoutSession: stripe.checkoutSession,
});

const synthesisNote = (donation: ResolvedDonation, stripe: SyntheticStripeContext) => ({
  note:
    'These Stripe objects were constructed locally from the donation payload; none of them ' +
    'exists in Stripe. Ids are derived from a hash of the payload so repeated calls render ' +
    'identical DocNumbers.',
  chargeId: stripe.ids.chargeId,
  paymentIntentId: stripe.ids.paymentIntentId,
  balanceTransactionId: stripe.ids.balanceTransactionId,
  checkoutSessionId: stripe.ids.checkoutSessionId,
  customerId: stripe.ids.customerId,
  balanceTransactionAvailable: donation.processorFeeCents !== null,
});

// ---------------------------------------------------------------------------
// QuickBooks
// ---------------------------------------------------------------------------

export const opsTestQuickbooks = async (
  request: HttpRequest,
  context: InvocationContext
): Promise<HttpResponseInit> => {
  const parsed = await parseHarnessRequest(request, { allowChargeId: true });
  if (!parsed.ok) {
    return parsed.response;
  }

  const { dryRun, tag, chargeId, donation, donationWarnings } = parsed.value;
  const deps = resolveDependencies();

  try {
    if (chargeId) {
      // Reads Stripe on a dry run too. Previewing what a real charge would produce in
      // QuickBooks is the main thing this endpoint is for, and it is a read: refusing it
      // until dryRun=false would make a caller enable writing merely to look.
      const stripe = deps.getStripeClient(parsed.value.liveMode);
      const preview = await buildQboPreviewForCharge(chargeId, { stripe }, tag);
      return respond(200, {
        success: true,
        dryRun,
        tag,
        source: 'stripe-charge',
        outboundReads: stripeChargeReads(chargeId),
        ...preview,
        posted: {
          attempted: false,
          note:
            'Posting a charge previewed from Stripe is not offered here, on a dry run or ' +
            'otherwise: the accounting path owns that decision and POST /api/qbo/manual-sync ' +
            'already exposes it. Use an inline donation payload with dryRun=false to ' +
            'exercise a tagged write.',
        },
      });
    }

    const stripeContext = buildSyntheticStripeContext(donation);
    const preview = buildQuickBooksPreviewFromContext({
      stripeContext: toStripeContext(stripeContext),
      grossCents: donation.grossCents,
      feeCents: donation.processorFeeCents,
      currency: donation.currency,
      date: donation.date,
      chargeId: stripeContext.ids.chargeId,
      cleanupTag: tag,
      baseWarnings: donationWarnings,
    });

    if (dryRun) {
      return respond(200, {
        success: true,
        dryRun: true,
        tag,
        source: 'synthetic',
        outboundReads: NO_OUTBOUND_READS,
        wouldTouchOnDryRunFalse:
          'QuickBooks only. It would create the documents rendered under the ACTIVE strategy ' +
          `below, each carrying "${buildTestArtifactMarker(tag)}" in its PrivateNote.`,
        synthetic: synthesisNote(donation, stripeContext),
        ...preview,
      });
    }

    if (donation.processorFeeCents === null) {
      return respond(400, {
        error: 'fee_unknown',
        message:
          'Refusing to post to QuickBooks with an unknown processor fee. Supply ' +
          'processorFeeCents, or leave dryRun at its default of true.',
      });
    }

    const result = await deps.postChargeToQbo({
      gross: donation.grossCents,
      fee: donation.processorFeeCents,
      memo: `Stripe charge ${stripeContext.ids.chargeId}`,
      date: donation.date,
      stripe: toStripeContext(stripeContext),
      cleanupTag: tag,
      options: deps.qboFetcher ? { fetcher: deps.qboFetcher } : undefined,
    });

    return respond(200, {
      success: true,
      dryRun: false,
      tag,
      source: 'synthetic',
      touched: 'QuickBooks',
      outboundReads: {
        performed: true,
        services: ['quickbooks'],
        detail:
          'QuickBooks was contacted to resolve the refs the posting path needs and to create ' +
          'the documents below. This was not a dry run.',
      },
      synthetic: synthesisNote(donation, stripeContext),
      posted: { attempted: true, ...result, cleanupMarker: buildTestArtifactMarker(tag) },
      ...preview,
    });
  } catch (error) {
    const message = errorMessage(error);
    if ((error as { code?: string } | null)?.code === 'resource_missing') {
      return respond(404, {
        error: 'charge_not_found',
        message: `Stripe has no charge ${chargeId} in the requested mode.`,
      });
    }

    context.error('[OpsTestHarness] QuickBooks preview failed', message);
    return respond(500, { error: 'internal_error', message });
  }
};

// ---------------------------------------------------------------------------
// Salesforce
// ---------------------------------------------------------------------------

export const opsTestSalesforce = async (
  request: HttpRequest,
  context: InvocationContext
): Promise<HttpResponseInit> => {
  const parsed = await parseHarnessRequest(request);
  if (!parsed.ok) {
    return parsed.response;
  }

  const { dryRun, tag, donation, donationWarnings } = parsed.value;
  const deps = resolveDependencies();

  try {
    const stripeContext = buildSyntheticStripeContext(donation);
    const preview = buildSalesforcePreview({
      donation,
      stripe: stripeContext,
      cleanupTag: tag,
      baseWarnings: donationWarnings,
    });

    if (dryRun) {
      return respond(200, {
        success: true,
        dryRun: true,
        tag,
        outboundReads: NO_OUTBOUND_READS,
        wouldTouchOnDryRunFalse:
          'Salesforce only. It would find-or-create the Contact below and upsert the ' +
          'Transaction__c by Stripe_Payment_Intent_Id__c, with the cleanup marker in Memo__c ' +
          'for a human and the cleanup tag inside Stripe_Customer_Id__c on BOTH records, ' +
          'which is what POST /api/ops/test-artifact-cleanup can actually query on.',
        synthetic: synthesisNote(donation, stripeContext),
        ...preview,
      });
    }

    const salesforce = await deps.getSalesforceSvc();
    const contactResult = await salesforce.upsertCustomerByStripeId({
      stripe_customer_id__c: stripeContext.ids.customerId,
      Name: donation.donor.fullName,
      Email: donation.donor.email,
      FirstName: donation.donor.firstName,
      LastName: donation.donor.lastName,
    });

    const transactionResult = await salesforce.upsertTransactionByExternalId(
      preview.transactionDto,
      'stripe_payment_intent_id__c'
    );

    return respond(200, {
      success: true,
      dryRun: false,
      tag,
      touched: 'Salesforce',
      outboundReads: {
        performed: true,
        services: ['salesforce'],
        detail:
          'Salesforce was contacted to find-or-create the Contact and upsert the ' +
          'Transaction__c below. This was not a dry run.',
      },
      synthetic: synthesisNote(donation, stripeContext),
      written: {
        contactId: contactResult.id ?? null,
        transactionId: transactionResult.id ?? null,
        cleanupMarker: buildTestArtifactMarker(tag),
        cleanupHandle: preview.cleanupHandle,
        fieldsSent: Object.keys(preview.transaction.fields as Record<string, unknown>).length,
      },
      ...preview,
    });
  } catch (error) {
    const message = errorMessage(error);
    context.error('[OpsTestHarness] Salesforce preview failed', message);
    return respond(500, { error: 'internal_error', message });
  }
};

// ---------------------------------------------------------------------------
// Stripe
// ---------------------------------------------------------------------------

export const opsTestStripe = async (
  request: HttpRequest,
  context: InvocationContext
): Promise<HttpResponseInit> => {
  const parsed = await parseHarnessRequest(request);
  if (!parsed.ok) {
    return parsed.response;
  }

  const liveModeRejection = rejectLiveMode(parsed.value);
  if (liveModeRejection) {
    return liveModeRejection;
  }

  const { dryRun, tag, donation, donationWarnings } = parsed.value;
  const deps = resolveDependencies();

  try {
    if (dryRun) {
      // No customer is resolved on a dry run, because resolving one can CREATE a Stripe
      // customer. `customer:` therefore renders as a placeholder Stripe would reject.
      const preview = buildStripePreview({
        donation,
        cleanupTag: tag,
        baseWarnings: donationWarnings,
      });

      return respond(200, {
        success: true,
        dryRun: true,
        tag,
        outboundReads: NO_OUTBOUND_READS,
        wouldTouchOnDryRunFalse:
          'Stripe only, and only in TEST mode. It would resolve (find or create) the customer ' +
          'for this donor and then create the Checkout Session rendered below, carrying ' +
          `source_test_tag=${tag} in its metadata and in the mirrored payment_intent_data / ` +
          'subscription_data metadata.',
        ...preview,
      });
    }

    // rejectLiveMode has already refused a live-mode request, so this is always the test key.
    const stripe = deps.getStripeClient(false);

    // Stripe rejects a `customer:` it has never issued, so the placeholder the preview shows
    // can never be sent. Resolve the customer through the same find-or-create the donation
    // form uses, then rebuild the arguments around the id that came back.
    const customerId = await deps.resolveStripeCustomerId(
      stripe,
      buildHarnessCustomerDetails(donation, tag)
    );

    const preview = buildStripePreview({
      donation,
      cleanupTag: tag,
      baseWarnings: donationWarnings,
      customerId,
    });

    const session = await stripe.checkout.sessions.create(
      preview.checkoutSessionCreateArgs as unknown as Stripe.Checkout.SessionCreateParams
    );

    return respond(200, {
      success: true,
      dryRun: false,
      tag,
      touched: 'Stripe (test mode)',
      outboundReads: {
        performed: true,
        services: ['stripe'],
        detail:
          'Stripe test mode was contacted to find-or-create the customer and then create the ' +
          'Checkout Session below. This was not a dry run.',
      },
      created: {
        checkoutSessionId: session.id,
        url: session.url ?? null,
        livemode: session.livemode,
        customerId,
        cleanupKey: `source_test_tag=${tag}`,
      },
      ...preview,
    });
  } catch (error) {
    const message = errorMessage(error);
    context.error('[OpsTestHarness] Stripe preview failed', message);
    return respond(500, { error: 'internal_error', message });
  }
};

// ---------------------------------------------------------------------------
// Whole donation
// ---------------------------------------------------------------------------

interface TraceStep {
  step: number;
  stage: 'stripe' | 'salesforce' | 'quickbooks';
  title: string;
  describes: string;
  outcome: 'rendered' | 'failed';
  detail: unknown;
  error?: string;
}

export const opsTestDonation = async (
  request: HttpRequest,
  context: InvocationContext
): Promise<HttpResponseInit> => {
  const parsed = await parseHarnessRequest(request);
  if (!parsed.ok) {
    return parsed.response;
  }

  const liveModeRejection = rejectLiveMode(parsed.value);
  if (liveModeRejection) {
    return liveModeRejection;
  }

  const { dryRun, tag, donation, donationWarnings } = parsed.value;

  if (!dryRun) {
    return respond(400, {
      error: 'dry_run_only',
      message:
        'The end-to-end trace is a dry run only. Running one payload through all three ' +
        'systems for real means three separate writes whose failure modes interleave; ' +
        'exercise them one at a time with POST /api/ops/test/stripe, /salesforce and ' +
        '/quickbooks, each with dryRun=false.',
    });
  }

  const stripeContext = buildSyntheticStripeContext(donation);
  const steps: TraceStep[] = [];

  const record = (
    stage: TraceStep['stage'],
    title: string,
    describes: string,
    build: () => unknown
  ): void => {
    try {
      steps.push({
        step: steps.length + 1,
        stage,
        title,
        describes,
        outcome: 'rendered',
        detail: build(),
      });
    } catch (error) {
      const message = errorMessage(error);
      context.error(`[OpsTestHarness] Trace step ${stage} failed`, message);
      steps.push({
        step: steps.length + 1,
        stage,
        title,
        describes,
        outcome: 'failed',
        detail: null,
        error: message,
      });
    }
  };

  record(
    'stripe',
    'Donation form creates a Checkout Session',
    'What POST /api/transaction sends to stripe.checkout.sessions.create.',
    () => buildStripePreview({ donation, cleanupTag: tag, baseWarnings: donationWarnings })
  );

  record(
    'salesforce',
    'payment_intent.succeeded upserts Contact and Transaction__c',
    'The field map the Stripe webhook writes once the donor completes checkout.',
    () => buildSalesforcePreview({ donation, stripe: stripeContext, cleanupTag: tag })
  );

  record(
    'quickbooks',
    'The accounting path posts the charge',
    'The documents QuickBooks would receive, under each posting strategy.',
    () =>
      buildQuickBooksPreviewFromContext({
        stripeContext: toStripeContext(stripeContext),
        grossCents: donation.grossCents,
        feeCents: donation.processorFeeCents,
        currency: donation.currency,
        date: donation.date,
        chargeId: stripeContext.ids.chargeId,
        cleanupTag: tag,
      })
  );

  return respond(200, {
    success: true,
    dryRun: true,
    tag,
    outboundReads: NO_OUTBOUND_READS,
    writesNothing:
      'Nothing was created anywhere. No Stripe, Salesforce or QuickBooks call was made.',
    cleanupMarker: buildTestArtifactMarker(tag),
    synthetic: synthesisNote(donation, stripeContext),
    donation,
    warnings: donationWarnings,
    trace: steps,
  });
};

export default opsTestDonation;
