import {
  buildCheckoutSessionParams,
  calculateCoverFees,
} from '../../handlers/processTransaction/checkoutSessionParams';
import { buildTestArtifactMarker } from '../../lib/testArtifactTagging';
import type { ResolvedDonation } from './syntheticDonation';

/**
 * The placeholder that stands in for `customer:` while nothing is being sent.
 *
 * A dry run renders the create arguments without contacting Stripe, so there is no customer
 * to name yet. It is deliberately not a plausible id: Stripe would reject it outright, which
 * is what makes it safe to show and fatal to send. `opsTestStripe` must resolve a real one
 * through `resolveStripeCustomerId` before it writes.
 */
export const UNRESOLVED_CUSTOMER_PLACEHOLDER =
  '<resolved at request time — searchStripeCustomer finds or creates the customer>';

/**
 * The customer payload the harness resolves against Stripe before a non-dry-run write.
 *
 * `source_test_tag` is the key `listStripeCustomersByTag` searches on, so a customer this
 * harness creates is one POST /api/ops/test-artifact-cleanup can find and delete.
 */
export const buildHarnessCustomerDetails = (
  donation: ResolvedDonation,
  cleanupTag: string
): Record<string, unknown> => ({
  email: donation.donor.email,
  firstname: donation.donor.organization ?? donation.donor.firstName ?? undefined,
  lastname: donation.donor.organization ? undefined : (donation.donor.lastName ?? undefined),
  phone: donation.donor.phone ?? undefined,
  metadata: { source_test_tag: cleanupTag },
});

/**
 * Renders the `stripe.checkout.sessions.create` arguments the donation form would send.
 *
 * The construction is not reimplemented here: `buildCheckoutSessionParams` is the exact
 * function `POST /api/transaction` calls, split out of `createCheckoutSession` so it can be
 * run without a Stripe client. Anything that changes about line items, metadata mirroring
 * or `payment_method_types` shows up here for free.
 *
 * `buildCheckoutSessionParams` lives in its own module precisely so it can be imported
 * without dragging in the Salesforce CRM factory, the idempotency store, or a Stripe client.
 */

export interface StripePreviewResult extends Record<string, unknown> {
  writesNothing: string;
  mode: 'payment' | 'subscription';
  checkoutSessionCreateArgs: Record<string, unknown>;
  metadata: Record<string, unknown>;
  warnings: string[];
}

export const buildStripePreview = (input: {
  donation: ResolvedDonation;
  cleanupTag: string;
  baseWarnings?: string[];
  /**
   * The customer id to render into `customer:`. Supplied only when the caller is about to
   * SEND these arguments, in which case it must be an id resolved through
   * `resolveStripeCustomerId`. Omitted for a preview, which shows the placeholder.
   */
  customerId?: string;
}): StripePreviewResult => {
  const { donation, cleanupTag } = input;
  const warnings = [...(input.baseWarnings ?? [])];

  // buildCheckoutSessionParams takes the BASE gift and adds the covered fee on top, which is
  // the inverse of how this harness states amounts (grossCents already includes the covered
  // fee, because that is what the donor is charged and what the balance transaction reports).
  const baseAmountCents = donation.grossCents - donation.coveredFeeCents;
  if (baseAmountCents <= 0) {
    warnings.push(
      `coveredFeeCents (${donation.coveredFeeCents}) consumes the whole gross ` +
        `(${donation.grossCents}), leaving no base gift. Stripe would reject the line item.`
    );
  }

  const metadataExtras: Record<string, string> = { source_test_tag: cleanupTag };
  if (donation.designation) {
    metadataExtras.designation__c = donation.designation;
  }
  if (donation.campaign) {
    metadataExtras.campaign__c = donation.campaign;
  }
  if (donation.attribution) {
    metadataExtras.attribution__c = donation.attribution;
  }
  if (donation.memo) {
    metadataExtras.memo__c = donation.memo;
  }

  const transactionData: Record<string, unknown> = {
    amount: baseAmountCents,
    frequency: donation.frequency,
    paymentMethod: donation.paymentMethod,
    coverFee: donation.coveredFeeCents > 0,
    feeAmount: donation.coveredFeeCents,
    category: donation.category,
    transactionType: donation.transactionType,
    attribution: donation.attribution ?? undefined,
    metadata: metadataExtras,
    customer: {
      email: donation.donor.email,
      firstname: donation.donor.firstName ?? undefined,
      lastname: donation.donor.lastName ?? undefined,
    },
  };

  if (donation.donor.organization) {
    transactionData.donationType = 'organization';
    transactionData.organization = donation.donor.organization;
  }

  const args = buildCheckoutSessionParams(
    input.customerId ?? UNRESOLVED_CUSTOMER_PLACEHOLDER,
    transactionData
  );

  const mode = (args.mode as 'payment' | 'subscription') ?? 'payment';
  const sessionMetadata = (args.metadata ?? {}) as Record<string, unknown>;
  const paymentIntentData = args.payment_intent_data as
    | { metadata?: Record<string, unknown> }
    | undefined;
  const subscriptionData = args.subscription_data as
    | { metadata?: Record<string, unknown> }
    | undefined;

  const quotedFee = calculateCoverFees(baseAmountCents, donation.paymentMethod);
  if (donation.coveredFeeCents > 0 && quotedFee !== donation.coveredFeeCents) {
    warnings.push(
      `coveredFeeCents is ${donation.coveredFeeCents}, but calculateCoverFees would quote ` +
        `${quotedFee} for a ${baseAmountCents}-cent ${donation.paymentMethod} gift under the ` +
        'rates configured on this deployment (STRIPE_NONPROFIT_RATES). The supplied value ' +
        'wins, because the form sends feeAmount explicitly.'
    );
  }

  if (mode === 'subscription') {
    warnings.push(
      'Recurring gift: donor intent is mirrored onto subscription_data.metadata, not ' +
        'payment_intent_data. Instalments 2..N have no Checkout Session at all, so the ' +
        'Subscription is the only object that carries the metadata forward.'
    );
  }

  return {
    writesNothing: input.customerId
      ? 'Rendering these arguments created nothing. Anything reported under `created` was ' +
        'created by the handler afterwards, from exactly these arguments.'
      : 'Nothing was created. No Stripe client was constructed and no Stripe API call was made.',
    customerResolution: input.customerId
      ? `customer: ${input.customerId} — found or created by resolveStripeCustomerId, the ` +
        'same find-or-create POST /api/transaction uses.'
      : 'customer: is a PLACEHOLDER, not an id. Stripe rejects a customer it never issued, ' +
        'so these arguments are not sendable as rendered; resolveStripeCustomerId supplies ' +
        'the real id at write time.',
    mode,
    modeSource:
      "frequency === 'onetime' selects mode 'payment'; anything else selects 'subscription'.",
    checkoutSessionCreateArgs: args,
    metadata: {
      session: sessionMetadata,
      payment_intent_data: paymentIntentData?.metadata ?? null,
      subscription_data: subscriptionData?.metadata ?? null,
      note:
        'Stripe does NOT copy Checkout Session metadata onto the PaymentIntent or the ' +
        'Subscription it creates. The mirror below the session is what the ' +
        'payment_intent.succeeded webhook actually reads, so a key missing from it is a key ' +
        'Salesforce will never see.',
    },
    amounts: {
      baseGiftCents: baseAmountCents,
      coveredFeeCents: donation.coveredFeeCents,
      chargedTotalCents: donation.grossCents,
      quotedCoverFeeCents: quotedFee,
      quotedBy: 'calculateCoverFees (src/handlers/processTransaction.js)',
    },
    cleanupMarker: buildTestArtifactMarker(cleanupTag),
    cleanupNote:
      `Stripe metadata carries source_test_tag=${cleanupTag} on the session and on the ` +
      'mirrored payment_intent_data / subscription_data, which is the key ' +
      'POST /api/ops/test-artifact-cleanup searches on.',
    warnings,
  };
};
