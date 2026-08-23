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
  ignoredDryRunWarning,
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
 * An endpoint that cannot honour an explicit `dryRun: false` says so instead of quietly
 * behaving as though the flag had been left alone: the `chargeId` path here warns and echoes
 * `dryRun: true`, and `POST /api/ops/test/donation` refuses the call outright with a 400.
 * Silently downgrading a requested write to a preview is the failure this harness exists to
 * catch, so no endpoint is allowed to commit it. A caller who simply omits `dryRun` is
 * getting the documented default and is not warned.
 *
 * The same rule covers mutually exclusive inputs. `chargeId` and a `donation` payload
 * describe two different charges and only the chargeId would ever be used, so supplying both
 * is refused with a 400 rather than silently resolved — see `parseHarnessRequest`. The other
 * three endpoints take no chargeId at all and already refuse it outright.
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

const CHARGE_ID_NEVER_POSTS =
  'A chargeId request previews an existing Stripe charge and stops there — the accounting ' +
  'path owns the decision to post a real charge, and POST /api/qbo/manual-sync already ' +
  'exposes it, so this endpoint never posts one on a dry run or otherwise.';

const CHARGE_ID_WRITE_INSTEAD =
  'To make this endpoint actually write, drop the chargeId and send an inline `donation` ' +
  'payload (including processorFeeCents) with dryRun=false: that path calls postChargeToQbo ' +
  'and creates tagged documents you can remove with POST /api/ops/test-artifact-cleanup.';

export const opsTestQuickbooks = async (
  request: HttpRequest,
  context: InvocationContext
): Promise<HttpResponseInit> => {
  const parsed = await parseHarnessRequest(request, { allowChargeId: true });
  if (!parsed.ok) {
    return parsed.response;
  }

  const { dryRun, dryRunExplicit, tag, chargeId, donation, donationWarnings } = parsed.value;
  const deps = resolveDependencies();

  try {
    if (chargeId) {
      // Reads Stripe on a dry run too. Previewing what a real charge would produce in
      // QuickBooks is the main thing this endpoint is for, and it is a read: refusing it
      // until dryRun=false would make a caller enable writing merely to look.
      const stripe = deps.getStripeClient(parsed.value.liveMode);
      const preview = await buildQboPreviewForCharge(chargeId, { stripe }, tag);

      // The caller asked for a write this path will not perform. Left unsaid, the response
      // was `success: true`, `dryRun: false`, `warnings: []` and a `posted.attempted: false`
      // buried further down — which reads as a completed write to anyone who requested one.
      const ignoredDryRun = dryRunExplicit && !dryRun;
      const warnings = [
        ...(ignoredDryRun
          ? [ignoredDryRunWarning(CHARGE_ID_NEVER_POSTS, CHARGE_ID_WRITE_INSTEAD)]
          : []),
        ...preview.warnings,
      ];

      return respond(200, {
        success: true,
        // Always true, whatever was asked for: this path only ever reads Stripe. Echoing
        // back the `false` the caller sent would report a write that did not happen.
        dryRun: true,
        dryRunRequested: dryRun,
        tag,
        source: 'stripe-charge',
        outboundReads: stripeChargeReads(chargeId),
        ...preview,
        // After the spread: the preview carries its own `warnings`, and this list is that
        // list with the ignored-parameter notice on the front.
        warnings,
        posted: {
          attempted: false,
          requestedButNotPerformed: ignoredDryRun,
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

  // The same rule the QuickBooks chargeId path applies, in its louder form: an explicit
  // `dryRun: false` this endpoint cannot honour is refused outright rather than quietly
  // served as a preview. `dryRun` defaults to true, so reaching here means the caller
  // asked for this in so many words.
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
