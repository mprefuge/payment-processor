import type Stripe from 'stripe';

import env from '../../config/env';
import { logger } from '../../lib/logger';
import { formatDateInTimeZone } from '../../lib/qboDates';
import {
  appendTestArtifactMarker,
  buildTestArtifactMarker,
  extractTestArtifactTagFromStripeContext,
} from '../../lib/testArtifactTagging';
import {
  buildDocNumber,
  buildFeesJE,
  buildSalesReceipt,
  buildSingleJE,
  createClassRef,
  deriveSalesReceiptCustomer,
  getCheckoutCategory,
  getCheckoutTransactionType,
  getCoverFeesInfo,
  getSalesReceiptLineOverrides,
  getStripeLineDescription,
  type StripeCustomerContext,
} from '../qboSvc';
import {
  findCheckoutSessionForPaymentIntent,
  normalizeStripeId,
  resolveBalanceTransaction,
  resolveCharge,
  resolveStripeCustomer,
  timestampToDate,
  timestampToIsoString,
} from '../../stripe/utils';

/**
 * Renders the exact QuickBooks documents a charge WOULD produce, and posts none of them.
 *
 * It exists because there is no other way to see that JSON before it lands in the books:
 * `POST /api/qbo/manual-sync` has no dry-run mode and QuickBooks has a single,
 * un-branched credential set, so exercising the accounting path against production writes
 * a real document into the real company file.
 *
 * QuickBooks is never called from here — not to resolve an account, not to look up an
 * item, not to find-or-create the donor. See `caveats` in the response for what that means
 * for the rendered references.
 *
 * The documents come from the same pure builders the posting path uses
 * (`buildSalesReceipt` / `buildFeesJE` / `buildSingleJE`) and the same `buildDocNumber`,
 * so a DocNumber collision is visible here before it is a duplicate in QuickBooks.
 */

export const CHARGE_ID_PATTERN = /^(ch|py)_[A-Za-z0-9]+$/;

export type PostingStrategy = 'sales-receipt' | 'je-transfer';

export const POSTING_STRATEGIES: readonly PostingStrategy[] = ['sales-receipt', 'je-transfer'];

export interface PreviewDocument {
  order: number;
  entity: 'SalesReceipt' | 'JournalEntry';
  role: string;
  docNumber: string;
  /** The exact JSON body that would be POSTed to QuickBooks for this document. */
  payload: unknown;
}

export interface PreviewStrategy {
  strategy: PostingStrategy;
  active: boolean;
  description: string;
  documents: PreviewDocument[];
  /** Set when the builder rejected the inputs; the real posting path would fail the same way. */
  error: string | null;
}

const STRATEGY_DESCRIPTIONS: Record<PostingStrategy, string> = {
  'sales-receipt':
    'SalesReceipt at gross into Stripe Clearing, plus a paired FEE- journal entry ' +
    '(Dr Fees / Cr Stripe Clearing). Revenue is booked gross and the processor fee lands ' +
    'in the P&L as its own expense.',
  'je-transfer':
    'One journal entry: Dr Stripe Clearing gross / Cr Revenue gross, plus Dr Fees / ' +
    'Cr Stripe Clearing for the processor fee when there is one.',
};

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * Amounts, with provenance, and an explicit `feeAvailable` flag.
 *
 * `feeCents` is `null` — never 0 — when there is no balance transaction. A zero there
 * would read as "Stripe charged nothing", which is a different and much more comforting
 * claim than "nobody knows yet".
 */
export interface PreviewAmounts {
  grossCents: number;
  grossSource: string;
  feeAvailable: boolean;
  feeCents: number | null;
  feeSource: string;
  netCents: number | null;
  netSource: string;
  currency: string;
  txnDate: string;
  txnDateSource: string;
}

const buildSalesReceiptDocuments = (input: {
  grossCents: number;
  feeCents: number | null;
  memo: string;
  date: Date;
  chargeId: string | null;
  stripeContext: StripeCustomerContext;
}): PreviewDocument[] => {
  const { grossCents, feeCents, memo, date, chargeId, stripeContext } = input;

  const lineOverrides = getSalesReceiptLineOverrides(stripeContext);

  // Mirrors postChargeAsSalesReceipt: the item is the explicit metadata override or the
  // configured default, never the Checkout Session's `metadata.transactionType` (a
  // donation-form concept that is not a QuickBooks item name). transactionType still shapes
  // the description below.
  const revenueItemName =
    lineOverrides.productService ?? env.accounting.defaultSalesItem?.trim() ?? '';
  if (!revenueItemName) {
    throw new Error(
      'No QuickBooks item could be determined: neither qbo_product_service metadata ' +
        'nor QBO_DEFAULT_SALES_ITEM is set.'
    );
  }

  const transactionTypeName =
    lineOverrides.productService ??
    getCheckoutTransactionType(stripeContext.checkoutSession) ??
    revenueItemName;
  const category = getCheckoutCategory(stripeContext.checkoutSession);
  const description =
    lineOverrides.description ??
    getStripeLineDescription(stripeContext) ??
    (category ? `${category} - ${transactionTypeName}` : transactionTypeName);

  const coverFeesInfo = getCoverFeesInfo(stripeContext);
  let coverFeesAmountCents = coverFeesInfo.enabled ? coverFeesInfo.amountCents : 0;
  if (coverFeesAmountCents >= grossCents) {
    coverFeesAmountCents = 0;
  }

  const salesReceiptDocNumber = buildDocNumber('CHG', date, grossCents, chargeId);
  const salesReceipt = buildSalesReceipt({
    docNumber: salesReceiptDocNumber,
    amountCents: grossCents,
    memo,
    date,
    revenueItemName,
    // 0 only affects the human-readable CustomerMemo, which states so explicitly when the
    // fee is unknown; the machine-readable `amounts.feeCents` stays null.
    stripeFeeAmountCents: feeCents ?? 0,
    stripeChargeId: chargeId,
    stripeInvoiceId:
      typeof stripeContext.charge?.invoice === 'string' ? stripeContext.charge.invoice : null,
    stripeInvoiceNumber:
      (stripeContext.checkoutSession as unknown as { invoice?: { number?: string } } | null)
        ?.invoice?.number ?? null,
    stripeSubscriptionId:
      normalizeStripeId(
        (stripeContext.checkoutSession as unknown as { subscription?: unknown } | null)
          ?.subscription
      ) ??
      normalizeStripeId(
        (stripeContext.paymentIntent as unknown as { subscription?: unknown } | null)?.subscription
      ) ??
      null,
    // Deliberately null: ensuring the QuickBooks customer is a write. See `customer` in
    // the response for the donor record the posting path would find-or-create.
    customer: null,
    description,
    coverFeesAmountCents,
    lineQuantity: lineOverrides.quantity,
    lineRate: lineOverrides.rate,
    lineAmountCents: lineOverrides.amountCents,
    // Dry run: mirrors the posting path's timezone-aware ServiceDate, but cannot resolve a
    // Class or the fee-coverage item without querying QuickBooks, so both stay as supplied.
    lineServiceDate:
      lineOverrides.serviceDate ??
      formatDateInTimeZone(
        stripeContext.charge?.created ?? stripeContext.paymentIntent?.created ?? date,
        env.accounting.companyTimeZone
      ) ??
      undefined,
    lineClassRef: lineOverrides.classRef,
  });

  const documents: PreviewDocument[] = [
    {
      order: 1,
      entity: 'SalesReceipt',
      role: 'Donor-facing receipt at gross, deposited to Stripe Clearing',
      docNumber: salesReceiptDocNumber,
      payload: salesReceipt,
    },
  ];

  // Mirrors postChargeAsSalesReceipt: the fee entry only exists when there is a fee, so a
  // charge with no resolvable fee produces a single document, not a pair.
  if (feeCents !== null && feeCents > 0) {
    const feeDocNumber = buildDocNumber('FEE', date, feeCents, chargeId);
    documents.push({
      order: 2,
      entity: 'JournalEntry',
      role: 'Paired processor fee — Dr Fees / Cr Stripe Clearing',
      docNumber: feeDocNumber,
      payload: buildFeesJE({
        docNumber: feeDocNumber,
        feeAmountCents: feeCents,
        memo,
        date,
        classRef: lineOverrides.classRef ? createClassRef(lineOverrides.classRef) : null,
      }),
    });
  }

  return documents;
};

const buildJournalEntryDocuments = (input: {
  grossCents: number;
  feeCents: number | null;
  memo: string;
  date: Date;
  chargeId: string | null;
}): PreviewDocument[] => {
  const { grossCents, feeCents, memo, date, chargeId } = input;
  const feeAmountCents = feeCents ?? 0;
  const docNumber = buildDocNumber('CHGJE', date, grossCents + feeAmountCents, chargeId);

  return [
    {
      order: 1,
      entity: 'JournalEntry',
      role: 'Single combined entry — gross revenue and processor fee',
      docNumber,
      payload: buildSingleJE({
        docNumber,
        grossAmountCents: grossCents,
        feeAmountCents,
        memo,
        date,
      }),
    },
  ];
};

export const renderStrategies = (input: {
  grossCents: number;
  feeCents: number | null;
  memo: string;
  date: Date;
  chargeId: string | null;
  stripeContext: StripeCustomerContext;
}): PreviewStrategy[] => {
  const strategies: PreviewStrategy[] = [];

  for (const strategy of POSTING_STRATEGIES) {
    try {
      const documents =
        strategy === 'sales-receipt'
          ? buildSalesReceiptDocuments(input)
          : buildJournalEntryDocuments(input);

      strategies.push({
        strategy,
        active: env.accounting.postingStrategy === strategy,
        description: STRATEGY_DESCRIPTIONS[strategy],
        documents,
        error: null,
      });
    } catch (error) {
      strategies.push({
        strategy,
        active: env.accounting.postingStrategy === strategy,
        description: STRATEGY_DESCRIPTIONS[strategy],
        documents: [],
        error: errorMessage(error),
      });
    }
  }

  return strategies;
};

const CAVEATS = [
  'QuickBooks was never called, so no reference is resolved: every AccountRef and ItemRef ' +
    'below carries the configured name in BOTH `name` and `value`. At post time each is ' +
    'looked up (and created when missing) against the connected company file and `value` ' +
    'becomes a real QuickBooks id.',
  'DocNumbers come from the same buildDocNumber the posting path uses, so they ARE exact — ' +
    'if one already exists in QuickBooks, posting will match the existing document instead ' +
    'of creating a new one.',
  'Both strategies are rendered so the difference is visible, but only the one marked ' +
    '"active": true reflects ACCOUNTING_POSTING_STRATEGY on this deployment.',
];

const accountingSummary = () => ({
  configuredStrategy: env.accounting.postingStrategy,
  configuredValue: env.accounting.postingStrategyConfigured ?? env.accounting.postingStrategy,
  syncEnabled: env.accounting.syncEnabled,
});

const UNKNOWN_FEE_SOURCE =
  'UNKNOWN — no balance transaction. This is not a fee of 0; nobody knows the fee yet.';

const UNKNOWN_NET_SOURCE = 'UNKNOWN — net cannot be computed while the processor fee is unknown.';

export interface QuickBooksPreviewResult extends Record<string, unknown> {
  writesNothing: string;
  accounting: ReturnType<typeof accountingSummary>;
  amounts: PreviewAmounts;
  memo: string;
  strategies: PreviewStrategy[];
  warnings: string[];
  caveats: string[];
}

// ---------------------------------------------------------------------------
// Synthetic path — no network at all.
// ---------------------------------------------------------------------------

export const buildQuickBooksPreviewFromContext = (input: {
  stripeContext: StripeCustomerContext;
  grossCents: number;
  feeCents: number | null;
  currency: string;
  date: string;
  chargeId: string | null;
  cleanupTag: string;
  baseWarnings?: string[];
  amountSources?: Partial<
    Pick<PreviewAmounts, 'grossSource' | 'feeSource' | 'netSource' | 'txnDateSource'>
  >;
}): QuickBooksPreviewResult => {
  const { stripeContext, grossCents, feeCents, currency, date, chargeId, cleanupTag } = input;
  const warnings = [...(input.baseWarnings ?? [])];

  const feeAvailable = feeCents !== null;
  if (!feeAvailable) {
    warnings.push(
      'The processor fee is unknown, so the sales-receipt strategy renders WITHOUT the ' +
        'paired FEE- journal entry and the je-transfer strategy renders without its two fee ' +
        'lines. A settled charge would produce them.'
    );
  }

  if (!env.accounting.syncEnabled) {
    warnings.push(
      'ACCOUNTING_SYNC_ENABLED is false on this deployment, so the live webhook path would ' +
        'not post these documents at all right now.'
    );
  }

  const memo =
    appendTestArtifactMarker(`Stripe charge ${chargeId ?? 'synthetic'}`, cleanupTag) ??
    `Stripe charge ${chargeId ?? 'synthetic'}`;

  const dateObject = new Date(`${date}T12:00:00Z`);

  let wouldEnsureCustomer: unknown = null;
  try {
    wouldEnsureCustomer = deriveSalesReceiptCustomer(stripeContext);
  } catch (error) {
    logger.debug('[testHarness] Could not derive the sales receipt customer', {
      error: errorMessage(error),
    });
  }

  return {
    writesNothing:
      'Nothing was posted. QuickBooks was not contacted, and no QuickBooks reference was resolved.',
    accounting: accountingSummary(),
    amounts: {
      grossCents,
      grossSource: input.amountSources?.grossSource ?? 'synthetic payload grossCents',
      feeAvailable,
      feeCents,
      feeSource: feeAvailable
        ? (input.amountSources?.feeSource ?? 'synthetic payload processorFeeCents')
        : UNKNOWN_FEE_SOURCE,
      netCents: feeAvailable ? grossCents - (feeCents as number) : null,
      netSource: feeAvailable
        ? (input.amountSources?.netSource ?? 'grossCents minus processorFeeCents')
        : UNKNOWN_NET_SOURCE,
      currency,
      txnDate: date,
      txnDateSource: input.amountSources?.txnDateSource ?? 'synthetic payload date',
    },
    memo,
    cleanupMarker: buildTestArtifactMarker(cleanupTag),
    customer: {
      ensured: false,
      note:
        'Finding-or-creating the QuickBooks customer is a write, so it is skipped. The ' +
        'previewed SalesReceipt therefore carries no CustomerRef; the posted one would.',
      wouldEnsure: wouldEnsureCustomer,
    },
    strategies: renderStrategies({
      grossCents,
      feeCents,
      memo,
      date: dateObject,
      chargeId,
      stripeContext,
    }),
    warnings,
    caveats: CAVEATS,
  };
};

// ---------------------------------------------------------------------------
// Charge-id path — reads Stripe (and only Stripe).
// ---------------------------------------------------------------------------

export interface QboPreviewDependencies {
  stripe: Stripe;
}

/**
 * Resolves the charge the accounting path would actually act on.
 *
 * The webhook never starts from a charge id — it starts from a PaymentIntent and calls
 * `resolveCharge`, which prefers the successful charge on the intent. Re-running that here
 * means the preview reflects the charge that would really be posted, and makes the
 * disagreement visible when the requested charge is not the one the intent prefers (a
 * retried payment leaves more than one charge on the intent).
 */
const resolvePreviewCharge = async (
  stripe: Stripe,
  chargeId: string
): Promise<{
  charge: Stripe.Charge;
  paymentIntent: Stripe.PaymentIntent | null;
  resolvedViaPaymentIntent: boolean;
}> => {
  const requested = (await stripe.charges.retrieve(chargeId)) as Stripe.Charge;

  const paymentIntentId = normalizeStripeId(requested.payment_intent);
  if (!paymentIntentId) {
    return { charge: requested, paymentIntent: null, resolvedViaPaymentIntent: false };
  }

  let paymentIntent: Stripe.PaymentIntent | null = null;
  try {
    paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId);
  } catch (error) {
    logger.debug('[testHarness] Payment intent retrieval failed; previewing the charge alone', {
      chargeId,
      paymentIntentId,
      error: errorMessage(error),
    });
    return { charge: requested, paymentIntent: null, resolvedViaPaymentIntent: false };
  }

  const preferred = await resolveCharge(stripe, paymentIntent);
  if (!preferred) {
    return { charge: requested, paymentIntent, resolvedViaPaymentIntent: false };
  }

  return { charge: preferred, paymentIntent, resolvedViaPaymentIntent: true };
};

export const buildQboPreviewForCharge = async (
  chargeId: string,
  deps: QboPreviewDependencies,
  cleanupTag: string
): Promise<QuickBooksPreviewResult> => {
  const { stripe } = deps;

  const { charge, paymentIntent, resolvedViaPaymentIntent } = await resolvePreviewCharge(
    stripe,
    chargeId
  );

  const balanceTransaction = await resolveBalanceTransaction(stripe, charge, paymentIntent);
  const paymentIntentId = normalizeStripeId(charge.payment_intent) ?? paymentIntent?.id ?? null;

  let checkoutSession: Stripe.Checkout.Session | null = null;
  try {
    checkoutSession = await findCheckoutSessionForPaymentIntent(stripe, paymentIntentId);
  } catch (error) {
    logger.debug('[testHarness] Checkout session lookup failed; previewing without it', {
      chargeId,
      error: errorMessage(error),
    });
  }

  const stripeCustomer = await resolveStripeCustomer(
    stripe,
    charge,
    paymentIntent,
    (...args: unknown[]) => logger.debug(...(args as [string, ...unknown[]]))
  );

  const stripeContext: StripeCustomerContext = {
    charge,
    paymentIntent,
    customer: stripeCustomer,
    checkoutSession,
  };

  const warnings: string[] = [];

  // -------------------------------------------------------------------------
  // Amounts. The posting path reads gross AND fee off one balance transaction —
  // never off the charge — so the preview reports the same provenance per field.
  // -------------------------------------------------------------------------
  const balanceTransactionAvailable = Boolean(balanceTransaction?.id);

  const grossCents = balanceTransactionAvailable
    ? Math.abs(balanceTransaction!.amount)
    : Math.abs(charge.amount);
  const feeCents = balanceTransactionAvailable ? Math.abs(balanceTransaction!.fee) : null;

  const date = balanceTransactionAvailable
    ? timestampToDate(balanceTransaction!.created ?? balanceTransaction!.available_on ?? null)
    : timestampToDate(charge.created);

  if (!balanceTransactionAvailable) {
    warnings.push(
      'NO BALANCE TRANSACTION. Stripe has not settled this charge yet — the usual cause is ' +
        'an ACH debit previewed before settlement. Two consequences, both real: (1) the live ' +
        'webhook path posts nothing for this charge YET — it records a deferral in ' +
        'posting_error__c on the Salesforce record and posts on settlement, provided ' +
        'charge.succeeded and charge.updated are enabled on the Stripe webhook endpoint; ' +
        '(2) the fee below is UNKNOWN, not zero — and under the sales-receipt strategy that ' +
        'absence also suppresses the paired FEE- journal entry a settled charge would ' +
        'produce. Do not read these amounts as final.'
    );
  }

  if (charge.id !== chargeId) {
    warnings.push(
      `The requested charge ${chargeId} is not the charge the accounting path would post: ` +
        `resolveCharge prefers ${charge.id} on payment intent ${paymentIntentId ?? 'unknown'}. ` +
        'Everything below describes the preferred charge.'
    );
  }

  if (charge.status !== 'succeeded') {
    warnings.push(
      `Charge status is "${charge.status}", not "succeeded". The accounting path only posts ` +
        'succeeded charges.'
    );
  }

  if (charge.refunded || (charge.amount_refunded ?? 0) > 0) {
    warnings.push(
      `Charge carries ${charge.amount_refunded} refunded cents. Refunds post as their own ` +
        'documents and are not reflected in the amounts below.'
    );
  }

  const tag = extractTestArtifactTagFromStripeContext(stripeContext) ?? cleanupTag;

  const preview = buildQuickBooksPreviewFromContext({
    stripeContext,
    grossCents,
    feeCents,
    currency: charge.currency,
    date: date.toISOString().slice(0, 10),
    chargeId: charge.id,
    cleanupTag: tag,
    baseWarnings: warnings,
    amountSources: {
      grossSource: balanceTransactionAvailable
        ? `stripe.balance_transaction(${balanceTransaction!.id}).amount`
        : `stripe.charge(${charge.id}).amount — FALLBACK, no balance transaction`,
      feeSource: balanceTransactionAvailable
        ? `stripe.balance_transaction(${balanceTransaction!.id}).fee`
        : UNKNOWN_FEE_SOURCE,
      netSource: balanceTransactionAvailable
        ? `stripe.balance_transaction(${balanceTransaction!.id}).net`
        : UNKNOWN_NET_SOURCE,
      txnDateSource: balanceTransactionAvailable
        ? `stripe.balance_transaction(${balanceTransaction!.id}).created`
        : `stripe.charge(${charge.id}).created — FALLBACK, no balance transaction`,
    },
  });

  return {
    ...preview,
    requestedChargeId: chargeId,
    charge: {
      id: charge.id,
      matchesRequested: charge.id === chargeId,
      resolvedViaPaymentIntent,
      paymentIntentId,
      checkoutSessionId: checkoutSession?.id ?? null,
      stripeCustomerId: normalizeStripeId(charge.customer),
      status: charge.status,
      livemode: charge.livemode,
      currency: charge.currency,
      amountCents: charge.amount,
      created: timestampToIsoString(charge.created),
      description: charge.description ?? null,
    },
    balanceTransaction: {
      available: balanceTransactionAvailable,
      id: balanceTransaction?.id ?? null,
      status: balanceTransaction?.status ?? null,
      availableOn: timestampToIsoString(balanceTransaction?.available_on ?? null),
    },
  };
};
