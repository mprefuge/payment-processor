import { createHash } from 'crypto';

import { extendZodWithOpenApi } from 'azure-functions-openapi';
import type Stripe from 'stripe';
import { z } from 'zod';

import { buildSyntheticCustomerId } from '../../lib/testArtifactTagging';

// These schemas carry `.openapi({ example })` annotations so Swagger UI prefills "Try it
// out". The extension is idempotent, and doing it here means the module is safe to import
// from a test or another handler without going through src/index.ts first.
extendZodWithOpenApi(z);

/**
 * The synthetic donation the `/api/ops/test/*` endpoints accept in place of a real
 * Stripe charge.
 *
 * Everything downstream of Checkout — the QuickBooks documents, the Salesforce field
 * map — is derived from Stripe objects, not from the donation form's own request body.
 * So rather than teach each preview a second input shape, one synthetic payload is
 * expanded here into the Stripe objects the real pipeline would eventually see, and the
 * previews then run the *production* readers over them. Fidelity comes from reuse: a
 * change to `mapStripeToTransaction` or `buildSalesReceipt` shows up in these endpoints
 * without anyone remembering to mirror it.
 */

export const DEFAULT_TEST_ARTIFACT_TAG = 'swagger-test-harness';

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export const DonorSchema = z
  .object({
    email: z.string().email().openapi({ example: 'swagger.harness@example.invalid' }),
    firstName: z.string().optional().openapi({ example: 'Harness' }),
    lastName: z.string().optional().openapi({ example: 'Testcase' }),
    phone: z.string().optional(),
    organization: z.string().optional(),
  })
  .openapi({ description: 'The donor as the donation form would have captured them.' });

export const SyntheticDonationSchema = z
  .object({
    grossCents: z
      .number()
      .int()
      .positive()
      .openapi({
        example: 10300,
        description:
          'Total the donor is charged, in cents, INCLUDING any fee they chose to cover. ' +
          'A $100.00 gift with a $3.00 covered fee is 10300, not 10000.',
      }),
    coveredFeeCents: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .openapi({
        example: 300,
        description:
          'Portion of grossCents the donor volunteered to cover. Donor intent, not a ' +
          'Stripe number — it becomes Cover_Fees_Amount__c.',
      }),
    processorFeeCents: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .openapi({
        example: 329,
        description:
          "Stripe's own fee, from the balance transaction. OMIT IT to model a charge Stripe " +
          'has not settled yet (an ACH debit, typically): the previews then report the fee as ' +
          'unknown rather than inventing a zero.',
      }),
    donor: DonorSchema,
    date: z.string().regex(DATE_PATTERN, 'date must be YYYY-MM-DD').optional().openapi({
      example: '2026-08-20',
      description: 'Transaction date (UTC). Defaults to today.',
    }),
    designation: z.string().optional().openapi({
      example: 'General Fund',
      description: 'Rides in Stripe metadata and lands on Transaction__c.Designation__c.',
    }),
    frequency: z
      .enum(['onetime', 'week', 'biweek', 'month', 'year'])
      .optional()
      .openapi({ example: 'onetime' }),
    paymentMethod: z
      .enum(['card', 'card_present', 'us_bank_account', 'amex', 'wallet'])
      .optional()
      .openapi({ example: 'card' }),
    currency: z.string().length(3).optional().openapi({ example: 'usd' }),
    category: z.string().optional().openapi({ example: 'Donation' }),
    transactionType: z.string().optional().openapi({
      example: 'Donation',
      description: 'Becomes the QuickBooks product/service (ItemRef) on a SalesReceipt.',
    }),
    campaign: z.string().optional(),
    attribution: z.string().optional(),
    memo: z.string().optional(),
    livemode: z.boolean().optional().openapi({
      example: false,
      description: 'Which Stripe mode this donation pretends to belong to. Defaults to false.',
    }),
  })
  .openapi({ description: 'A synthetic donation, in the shape the donation form posts.' });

export type SyntheticDonationInput = z.infer<typeof SyntheticDonationSchema>;

export interface ResolvedDonation {
  grossCents: number;
  coveredFeeCents: number;
  /** null when the caller omitted processorFeeCents — i.e. no balance transaction. */
  processorFeeCents: number | null;
  /** null whenever the processor fee is unknown; never silently gross-minus-zero. */
  netCents: number | null;
  currency: string;
  date: string;
  frequency: string;
  paymentMethod: string;
  donor: {
    email: string;
    firstName: string | null;
    lastName: string | null;
    fullName: string;
    phone: string | null;
    organization: string | null;
  };
  designation: string | null;
  category: string;
  transactionType: string;
  campaign: string | null;
  attribution: string | null;
  memo: string | null;
  livemode: boolean;
  tag: string;
}

const todayUtc = (): string => new Date().toISOString().slice(0, 10);

const trimOrNull = (value: string | null | undefined): string | null => {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  return trimmed.length > 0 ? trimmed : null;
};

/**
 * Ids derived from the payload, not from a random seed.
 *
 * DocNumber is a function of the charge id, so a randomised id would make two previews of
 * the same donation disagree about the document QuickBooks would receive — which is the
 * one thing this endpoint exists to show.
 */
const syntheticSuffix = (donation: ResolvedDonation): string =>
  createHash('sha256')
    .update(
      [
        donation.donor.email,
        donation.grossCents,
        donation.coveredFeeCents,
        donation.processorFeeCents ?? 'unknown',
        donation.date,
        donation.frequency,
        donation.designation ?? '',
        donation.tag,
      ].join('|')
    )
    .digest('hex')
    .slice(0, 16);

export const resolveDonation = (
  input: SyntheticDonationInput,
  tag: string
): { donation: ResolvedDonation; warnings: string[] } => {
  const warnings: string[] = [];

  const grossCents = input.grossCents;
  let coveredFeeCents = input.coveredFeeCents ?? 0;
  if (coveredFeeCents >= grossCents) {
    warnings.push(
      `coveredFeeCents (${coveredFeeCents}) is not less than grossCents (${grossCents}). ` +
        'buildSalesReceipt drops cover fees in that situation rather than emitting a ' +
        'non-positive base line, so this preview drops them too.'
    );
    coveredFeeCents = 0;
  }

  const processorFeeCents = input.processorFeeCents ?? null;
  if (processorFeeCents === null) {
    warnings.push(
      'processorFeeCents was omitted, which models a charge with NO balance transaction — ' +
        'Stripe has not settled it. The fee is reported as unknown throughout; it is not 0. ' +
        'The live webhook path posts nothing for such a charge, so treat every fee-derived ' +
        'number below as absent rather than zero.'
    );
  }

  const firstName = trimOrNull(input.donor.firstName);
  const lastName = trimOrNull(input.donor.lastName);
  const fullName = [firstName, lastName].filter(Boolean).join(' ') || input.donor.email;

  const donation: ResolvedDonation = {
    grossCents,
    coveredFeeCents,
    processorFeeCents,
    netCents: processorFeeCents === null ? null : grossCents - processorFeeCents,
    currency: (input.currency ?? 'usd').toLowerCase(),
    date: input.date ?? todayUtc(),
    frequency: input.frequency ?? 'onetime',
    paymentMethod: input.paymentMethod ?? 'card',
    donor: {
      email: input.donor.email.trim(),
      firstName,
      lastName,
      fullName,
      phone: trimOrNull(input.donor.phone),
      organization: trimOrNull(input.donor.organization),
    },
    designation: trimOrNull(input.designation),
    category: trimOrNull(input.category) ?? 'Donation',
    transactionType: trimOrNull(input.transactionType) ?? 'Donation',
    campaign: trimOrNull(input.campaign),
    attribution: trimOrNull(input.attribution),
    memo: trimOrNull(input.memo),
    livemode: input.livemode ?? false,
    tag,
  };

  return { donation, warnings };
};

/**
 * Metadata exactly as `formatStripeMetadata` in processTransaction writes it, plus the
 * cleanup tag and the lookup keys `mapStripeToTransaction` reads.
 */
export const buildSyntheticMetadata = (donation: ResolvedDonation): Record<string, string> => {
  const metadata: Record<string, string> = {
    category: donation.category,
    frequency: donation.frequency,
    transactionType: donation.transactionType,
    source_test_tag: donation.tag,
  };

  if (donation.coveredFeeCents > 0) {
    metadata.cover_fees = 'true';
    metadata.cover_fees_amount = String(donation.coveredFeeCents);
  }

  if (donation.designation) {
    metadata.designation__c = donation.designation;
  }
  if (donation.campaign) {
    metadata.campaign__c = donation.campaign;
  }
  if (donation.attribution) {
    metadata.attribution__c = donation.attribution;
  }
  if (donation.memo) {
    metadata.memo__c = donation.memo;
  }
  if (donation.donor.organization) {
    metadata.donationType = 'organization';
    metadata.organization = donation.donor.organization;
  }

  return metadata;
};

export interface SyntheticStripeContext {
  charge: Stripe.Charge;
  paymentIntent: Stripe.PaymentIntent;
  /** null when processorFeeCents was omitted: the charge has not settled. */
  balanceTransaction: Stripe.BalanceTransaction | null;
  checkoutSession: Stripe.Checkout.Session;
  customer: Stripe.Customer;
  metadata: Record<string, string>;
  ids: {
    chargeId: string;
    paymentIntentId: string;
    balanceTransactionId: string | null;
    checkoutSessionId: string;
    customerId: string;
  };
}

const cardMethods = new Set(['card', 'amex', 'wallet', 'card_present']);

/**
 * Expands the resolved donation into the Stripe objects `payment_intent.succeeded` would
 * carry. Nothing here talks to Stripe — every object is constructed locally.
 */
export const buildSyntheticStripeContext = (donation: ResolvedDonation): SyntheticStripeContext => {
  const suffix = syntheticSuffix(donation);
  const chargeId = `ch_test${suffix}`;
  const paymentIntentId = `pi_test${suffix}`;
  const checkoutSessionId = `cs_test_${suffix}`;
  // The cleanup tag is baked INTO the customer id, not merely into Memo__c. Both the
  // Contact and the Transaction__c carry this string in Stripe_Customer_Id__c, which is
  // the only field on both objects that SOQL can filter, so
  // POST /api/ops/test-artifact-cleanup can find and delete records for a synthetic
  // customer that exists nowhere in Stripe.
  const customerId = buildSyntheticCustomerId(donation.tag, suffix);
  const balanceTransactionId = donation.processorFeeCents === null ? null : `txn_test${suffix}`;

  const metadata = buildSyntheticMetadata(donation);
  const createdSeconds = Math.floor(Date.parse(`${donation.date}T12:00:00Z`) / 1000);
  const isCard = cardMethods.has(donation.paymentMethod);

  const customer = {
    id: customerId,
    object: 'customer',
    email: donation.donor.email,
    name: donation.donor.fullName,
    phone: donation.donor.phone,
    livemode: donation.livemode,
    created: createdSeconds,
    metadata: { ...metadata },
  } as unknown as Stripe.Customer;

  const balanceTransaction =
    donation.processorFeeCents === null
      ? null
      : ({
          id: balanceTransactionId as string,
          object: 'balance_transaction',
          amount: donation.grossCents,
          fee: donation.processorFeeCents,
          net: donation.grossCents - donation.processorFeeCents,
          currency: donation.currency,
          created: createdSeconds,
          available_on: createdSeconds,
          status: 'available',
          type: 'charge',
          reporting_category: 'charge',
          source: chargeId,
        } as unknown as Stripe.BalanceTransaction);

  const charge = {
    id: chargeId,
    object: 'charge',
    amount: donation.grossCents,
    amount_refunded: 0,
    refunded: false,
    disputed: false,
    currency: donation.currency,
    created: createdSeconds,
    status: 'succeeded',
    livemode: donation.livemode,
    customer: customerId,
    payment_intent: paymentIntentId,
    balance_transaction: balanceTransactionId,
    description: `${donation.category} - ${donation.transactionType}`,
    receipt_url: null,
    metadata: { ...metadata },
    billing_details: {
      email: donation.donor.email,
      name: donation.donor.fullName,
      phone: donation.donor.phone,
      address: null,
    },
    payment_method_details: isCard
      ? {
          type: 'card',
          card: { brand: donation.paymentMethod === 'amex' ? 'amex' : 'visa', last4: '4242' },
        }
      : { type: 'us_bank_account', us_bank_account: { last4: '6789' } },
  } as unknown as Stripe.Charge;

  const paymentIntent = {
    id: paymentIntentId,
    object: 'payment_intent',
    amount: donation.grossCents,
    currency: donation.currency,
    created: createdSeconds,
    status: 'succeeded',
    livemode: donation.livemode,
    customer: customerId,
    latest_charge: chargeId,
    description: `${donation.category} - ${donation.transactionType}`,
    payment_method_types: isCard ? ['card'] : ['us_bank_account'],
    metadata: { ...metadata },
  } as unknown as Stripe.PaymentIntent;

  const checkoutSession = {
    id: checkoutSessionId,
    object: 'checkout.session',
    amount_total: donation.grossCents,
    currency: donation.currency,
    created: createdSeconds,
    livemode: donation.livemode,
    mode: donation.frequency === 'onetime' ? 'payment' : 'subscription',
    customer: customerId,
    payment_intent: paymentIntentId,
    payment_status: 'paid',
    status: 'complete',
    metadata: { ...metadata },
    customer_details: {
      email: donation.donor.email,
      name: donation.donor.fullName,
      phone: donation.donor.phone,
    },
  } as unknown as Stripe.Checkout.Session;

  return {
    charge,
    paymentIntent,
    balanceTransaction,
    checkoutSession,
    customer,
    metadata,
    ids: {
      chargeId,
      paymentIntentId,
      balanceTransactionId,
      checkoutSessionId,
      customerId,
    },
  };
};
