import type { InvocationContext, HttpRequest } from '@azure/functions';
import Stripe from 'stripe';
import jsforce from 'jsforce';

import env from '../config/env';
import {
  AzureIdempotencyStore,
  type IdempotencyStore,
} from '../services/idempotencyStore';
import {
  createSalesforceSvc,
  type SalesforceSvc,
  type QuickBooksDocumentReference,
} from '../services/salesforceSvc';
import {
  mapStripeToTransaction,
  type TransactionUpsertDTO,
} from '../domain/transactions';
import {
  postChargeToQbo,
  postRefundToQbo,
  postDisputeToQbo,
  type PostChargeToQboResult,
} from '../services/qboSvc';

const STRIPE_API_VERSION: Stripe.LatestApiVersion = '2023-10-16';

interface StripeServices {
  verifyEvent: (payload: Buffer | string, signature: string) => Stripe.Event;
  getClient: (livemode: boolean) => Stripe;
}

interface AccountingServices {
  postChargeToQbo: typeof postChargeToQbo;
  postRefundToQbo: typeof postRefundToQbo;
  postDisputeToQbo: typeof postDisputeToQbo;
}

interface Dependencies {
  stripe: StripeServices;
  idempotencyStore: IdempotencyStore;
  getSalesforceSvc: () => Promise<SalesforceSvc>;
  accounting: AccountingServices;
}

type HttpContext = InvocationContext & {
  res?: {
    status?: number;
    headers?: Record<string, string>;
    body?: unknown;
  };
  log: (...args: unknown[]) => void;
};

type DependencyOverrides = {
  stripe?: Partial<StripeServices>;
  idempotencyStore?: IdempotencyStore;
  getSalesforceSvc?: () => Promise<SalesforceSvc>;
  accounting?: Partial<AccountingServices>;
};

const normalizeStripeId = (value: unknown): string | null => {
  if (!value) {
    return null;
  }

  if (typeof value === 'string') {
    return value;
  }

  if (typeof value === 'object' && value !== null && 'id' in value) {
    const idValue = (value as { id?: unknown }).id;
    return typeof idValue === 'string' ? idValue : null;
  }

  return null;
};

const centsToMajorUnits = (value: number | null | undefined): number | null => {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    return null;
  }

  return value / 100;
};

const centsToPositiveMajorUnits = (value: number | null | undefined): number | null => {
  const converted = centsToMajorUnits(value);
  if (converted === null) {
    return null;
  }

  return Math.abs(converted);
};

const createInMemoryStore = (): IdempotencyStore => {
  const processed = new Set<string>();
  return {
    async isProcessed(key: string): Promise<boolean> {
      return processed.has(key);
    },
    async markProcessed(key: string): Promise<void> {
      processed.add(key);
    },
    async withLock<T>(_: string, fn: () => Promise<T>): Promise<T> {
      return fn();
    },
    async flush(): Promise<void> {
      // no-op
    },
  };
};

const timestampToDate = (timestamp: number | null | undefined): Date => {
  if (typeof timestamp === 'number' && Number.isFinite(timestamp)) {
    return new Date(timestamp * 1000);
  }

  return new Date();
};

const timestampToIsoString = (timestamp: number | null | undefined): string | null => {
  if (typeof timestamp !== 'number' || Number.isNaN(timestamp)) {
    return null;
  }

  return new Date(timestamp * 1000).toISOString();
};

const createStripeServices = (): StripeServices => {
  const defaultClient = new Stripe(env.stripe.secret, {
    apiVersion: STRIPE_API_VERSION,
  });

  const cache = new Map<boolean, Stripe>();

  const getClient = (livemode: boolean): Stripe => {
    if (cache.has(livemode)) {
      return cache.get(livemode)!;
    }

    const secret = livemode
      ? process.env.STRIPE_LIVE_SECRET_KEY || env.stripe.secret
      : process.env.STRIPE_TEST_SECRET_KEY || env.stripe.secret;

    const client = new Stripe(secret, {
      apiVersion: STRIPE_API_VERSION,
    });
    cache.set(livemode, client);
    return client;
  };

  return {
    verifyEvent: (payload, signature) =>
      defaultClient.webhooks.constructEvent(payload, signature, env.stripe.webhookSecret),
    getClient,
  };
};

let defaultSalesforceSvcPromise: Promise<SalesforceSvc> | null = null;

const createSalesforceGetter = (): (() => Promise<SalesforceSvc>) => {
  return async (): Promise<SalesforceSvc> => {
    if (!defaultSalesforceSvcPromise) {
      defaultSalesforceSvcPromise = (async () => {
        const username = process.env.SALESFORCE_USERNAME;
        const password = process.env.SALESFORCE_PASSWORD;
        const securityToken = process.env.SALESFORCE_SECURITY_TOKEN || '';
        const loginUrl =
          process.env.SALESFORCE_LOGIN_URL || 'https://login.salesforce.com';

        if (!username || !password) {
          throw new Error('Salesforce credentials are not configured.');
        }

        const connection = new jsforce.Connection({ loginUrl });
        await connection.login(username, `${password}${securityToken}`);
        return createSalesforceSvc({ connection });
      })();
    }

    return defaultSalesforceSvcPromise;
  };
};

const createDefaultDependencies = (): Dependencies => ({
  stripe: createStripeServices(),
  idempotencyStore:
    process.env.DISABLE_AZURE_TABLES === '1'
      ? createInMemoryStore()
      : new AzureIdempotencyStore(),
  getSalesforceSvc: createSalesforceGetter(),
  accounting: {
    postChargeToQbo,
    postRefundToQbo,
    postDisputeToQbo,
  },
});

let dependencies: Dependencies = createDefaultDependencies();

const setDependencies = (overrides: DependencyOverrides = {}): void => {
  if (overrides.idempotencyStore) {
    dependencies.idempotencyStore = overrides.idempotencyStore;
  }

  if (overrides.getSalesforceSvc) {
    dependencies.getSalesforceSvc = overrides.getSalesforceSvc;
  }

  if (overrides.stripe) {
    dependencies.stripe = {
      ...dependencies.stripe,
      ...overrides.stripe,
    };
  }

  if (overrides.accounting) {
    dependencies.accounting = {
      ...dependencies.accounting,
      ...overrides.accounting,
    };
  }
};

const resetDependencies = (): void => {
  defaultSalesforceSvcPromise = null;
  dependencies = createDefaultDependencies();
};

const getStripeSignature = (req: HttpRequest): string | undefined => {
  const headers = (req as unknown as { headers?: Headers | Record<string, string> }).headers;

  if (!headers) {
    return undefined;
  }

  if (typeof (headers as Headers).get === 'function') {
    const cast = headers as Headers;
    return (
      cast.get('stripe-signature') ||
      cast.get('Stripe-Signature') ||
      cast.get('STRIPE-SIGNATURE') ||
      undefined
    ) ?? undefined;
  }

  const record = headers as Record<string, string | undefined>;
  return (
    record['stripe-signature'] ||
    record['Stripe-Signature'] ||
    record['STRIPE-SIGNATURE']
  );
};

const getRawBody = (req: HttpRequest): string => {
  const raw = (req as unknown as { rawBody?: string | Buffer }).rawBody;

  if (typeof raw === 'string') {
    return raw;
  }

  if (Buffer.isBuffer(raw)) {
    return raw.toString('utf8');
  }

  if (typeof req.body === 'string') {
    return req.body;
  }

  if (req.body && typeof req.body === 'object') {
    try {
      return JSON.stringify(req.body);
    } catch (error) {
      return '';
    }
  }

  return '';
};

const extractBalanceTransactionId = (
  source: unknown,
): string | null => normalizeStripeId(source);

const resolveCharge = async (
  stripe: Stripe,
  paymentIntent: Stripe.PaymentIntent,
): Promise<Stripe.Charge | null> => {
  const piWithCharges = paymentIntent as Stripe.PaymentIntent & {
    charges?: { data?: Stripe.Charge[] };
  };

  const charges = Array.isArray(piWithCharges.charges?.data)
    ? piWithCharges.charges!.data!
    : [];
  if (charges.length > 0) {
    const succeededCharge = charges.find(
      (charge: Stripe.Charge) => charge.status === 'succeeded',
    );
    return succeededCharge || charges[0];
  }

  const latestChargeId = normalizeStripeId(paymentIntent.latest_charge);
  if (latestChargeId) {
    try {
      const response = await stripe.charges.retrieve(latestChargeId);
      return response as Stripe.Charge;
    } catch (error) {
      return null;
    }
  }

  return null;
};

const resolveBalanceTransaction = async (
  stripe: Stripe,
  charge: Stripe.Charge | null,
  fallback: Stripe.PaymentIntent | Stripe.Refund | Stripe.Dispute | null,
): Promise<Stripe.BalanceTransaction | null> => {
  const fallbackId = fallback
    ? extractBalanceTransactionId(
        (fallback as { balance_transaction?: unknown }).balance_transaction,
      )
    : null;

  if (fallbackId) {
    try {
      return await stripe.balanceTransactions.retrieve(fallbackId);
    } catch (error) {
      // ignore and fall through to charge lookup
    }
  }

  const id = extractBalanceTransactionId(charge?.balance_transaction);
  if (id) {
    try {
      return await stripe.balanceTransactions.retrieve(id);
    } catch (error) {
      return null;
    }
  }

  return null;
};

const resolveStripeCustomer = async (
  stripe: Stripe,
  charge: Stripe.Charge | null,
  paymentIntent: Stripe.PaymentIntent | null,
  logger: (...args: unknown[]) => void,
): Promise<(Stripe.Customer | Stripe.DeletedCustomer) | null> => {
  const customerId =
    normalizeStripeId(charge?.customer) ||
    normalizeStripeId(paymentIntent?.customer);

  if (!customerId) {
    return null;
  }

  try {
    const customer = await stripe.customers.retrieve(customerId);
    return customer as Stripe.Customer | Stripe.DeletedCustomer;
  } catch (error) {
    logger('[StripeWebhook] Failed to retrieve Stripe customer', {
      customerId,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
};

const findCheckoutSessionForPaymentIntent = async (
  stripe: Stripe,
  paymentIntentId: string | null | undefined,
): Promise<Stripe.Checkout.Session | null> => {
  if (!paymentIntentId || typeof paymentIntentId !== 'string') {
    return null;
  }

  const trimmed = paymentIntentId.trim();
  if (trimmed.length === 0) {
    return null;
  }

  const sessions = await stripe.checkout.sessions.list({
    payment_intent: trimmed,
    limit: 1,
  });

  if (!sessions || !Array.isArray(sessions.data) || sessions.data.length === 0) {
    return null;
  }

  return sessions.data[0] ?? null;
};

const handleCheckoutSessionCompleted = async (
  context: HttpContext,
  event: Stripe.Event,
  deps: Dependencies,
): Promise<void> => {
  const session = event.data.object as Stripe.Checkout.Session;
  const salesforce = await deps.getSalesforceSvc();

  const transaction: TransactionUpsertDTO = {
    transaction_type__c: 'charge',
    status__c: 'processing',
    stripe_checkout_session_id__c: session.id,
    stripe_payment_intent_id__c: normalizeStripeId(session.payment_intent),
    stripe_customer_id__c: normalizeStripeId(session.customer),
    stripe_subscription_id__c: normalizeStripeId(session.subscription),
    amount_gross__c: centsToMajorUnits(session.amount_total ?? null),
    amount_net__c: centsToMajorUnits(session.amount_subtotal ?? null),
    currency_iso_code__c: session.currency
      ? session.currency.toUpperCase()
      : null,
    received_at__c: timestampToIsoString(session.created ?? null),
  };

  context.log('[StripeWebhook] Upserting pending transaction for checkout session', {
    sessionId: session.id,
  });

  await salesforce.upsertTransactionByExternalId(
    transaction,
    'stripe_checkout_session_id__c',
  );
};

const markPosted = async (
  salesforce: SalesforceSvc,
  upsertResult: unknown,
  doc: PostChargeToQboResult,
): Promise<void> => {
  const id =
    upsertResult &&
    typeof upsertResult === 'object' &&
    'id' in upsertResult
      ? (upsertResult as { id?: string }).id
      : undefined;

  if (typeof id === 'string' && id.trim().length > 0) {
    const reference: QuickBooksDocumentReference = {
      id: doc.qboId,
      type: doc.type,
    };
    await salesforce.markPostedToQbo(id, reference);
  }
};

const handlePaymentIntentSucceeded = async (
  context: HttpContext,
  event: Stripe.Event,
  deps: Dependencies,
): Promise<void> => {
  const paymentIntent = event.data.object as Stripe.PaymentIntent;
  const stripe = deps.stripe.getClient(Boolean(event.livemode));
  const salesforce = await deps.getSalesforceSvc();

  const charge = await resolveCharge(stripe, paymentIntent);
  const balanceTransaction = await resolveBalanceTransaction(
    stripe,
    charge,
    paymentIntent,
  );

  let checkoutSession: Stripe.Checkout.Session | null = null;
  try {
    checkoutSession = await findCheckoutSessionForPaymentIntent(stripe, paymentIntent.id);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Unknown error retrieving checkout session';
    context.log('[StripeWebhook] Failed to load checkout session for payment intent', {
      paymentIntentId: paymentIntent.id,
      error: message,
    });
  }

  const transaction = mapStripeToTransaction({
    paymentIntent,
    charge: charge ?? undefined,
    balanceTransaction: balanceTransaction ?? undefined,
  });

  let overrideId: string | null = null;

  if (checkoutSession) {
    if (!transaction.stripe_checkout_session_id__c) {
      transaction.stripe_checkout_session_id__c = checkoutSession.id;
    }

    try {
      overrideId = await salesforce.findTransactionIdByExternalId(
        'stripe_checkout_session_id__c',
        checkoutSession.id,
      );
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : 'Unknown error locating transaction by checkout session ID';
      context.log('[StripeWebhook] Failed to locate transaction by checkout session ID', {
        sessionId: checkoutSession.id,
        error: message,
      });
    }
  }

  context.log('[StripeWebhook] Upserting transaction for payment intent', {
    paymentIntentId: paymentIntent.id,
  });

  const upsertResult = await salesforce.upsertTransactionByExternalId(
    transaction,
    'stripe_payment_intent_id__c',
    overrideId ? { overrideId } : undefined,
  );

  if (!env.accounting.syncEnabled || !balanceTransaction) {
    return;
  }

  const balanceTransactionId = balanceTransaction.id;
  if (!balanceTransactionId) {
    return;
  }

  await deps.idempotencyStore.withLock(
    `bt_${balanceTransactionId}`,
    async () => {
      const stripeCustomer = await resolveStripeCustomer(
        stripe,
        charge,
        paymentIntent,
        context.log,
      );

      const posting = await deps.accounting.postChargeToQbo({
        gross: Math.abs(balanceTransaction.amount ?? 0),
        fee: Math.abs(balanceTransaction.fee ?? 0),
        memo: `Stripe charge ${charge?.id || paymentIntent.id}`,
        date: timestampToDate(
          balanceTransaction.created ?? balanceTransaction.available_on ?? null,
        ),
        stripe: {
          charge: charge ?? undefined,
          paymentIntent,
          customer: stripeCustomer,
          checkoutSession: checkoutSession ?? undefined,
        },
      });

      await markPosted(salesforce, upsertResult, posting);
    },
  );
};

const getLatestRefund = (charge: Stripe.Charge): Stripe.Refund | null => {
  const refunds = charge.refunds?.data;
  if (!refunds || refunds.length === 0) {
    return null;
  }

  return refunds[refunds.length - 1] ?? null;
};

const handleChargeRefunded = async (
  context: HttpContext,
  event: Stripe.Event,
  deps: Dependencies,
): Promise<void> => {
  const charge = event.data.object as Stripe.Charge;
  const refund = getLatestRefund(charge);

  if (!refund) {
    context.log('[StripeWebhook] charge.refunded received without refund object', {
      chargeId: charge.id,
    });
    return;
  }

  const stripe = deps.stripe.getClient(Boolean(event.livemode));
  const salesforce = await deps.getSalesforceSvc();

  const balanceTransaction = await resolveBalanceTransaction(
    stripe,
    charge,
    refund,
  );

  const parentId = await salesforce.findTransactionIdByExternalId(
    'stripe_charge_id__c',
    charge.id,
  );

  const transaction: TransactionUpsertDTO = {
    transaction_type__c: 'refund',
    status__c: 'refunded',
    stripe_refund_id__c: refund.id,
    stripe_charge_id__c: charge.id,
    stripe_payment_intent_id__c: normalizeStripeId(charge.payment_intent),
    stripe_balance_transaction_id__c: balanceTransaction?.id ?? null,
    stripe_customer_id__c: normalizeStripeId(charge.customer),
    amount_gross__c: centsToPositiveMajorUnits(refund.amount ?? null),
    amount_fee__c: centsToPositiveMajorUnits(balanceTransaction?.fee ?? null),
    amount_net__c: centsToMajorUnits(balanceTransaction?.net ?? null),
    currency_iso_code__c: charge.currency
      ? charge.currency.toUpperCase()
      : null,
    received_at__c: timestampToIsoString(refund.created ?? charge.created ?? null),
    parent_transaction__c: parentId,
    payment_brand__c: charge.payment_method_details?.card?.brand ?? null,
    payment_last4__c: charge.payment_method_details?.card?.last4 ?? null,
  };

  context.log('[StripeWebhook] Upserting refund transaction', {
    refundId: refund.id,
    chargeId: charge.id,
  });

  const upsertResult = await salesforce.upsertTransactionByExternalId(
    transaction,
    'stripe_refund_id__c',
  );

  if (!env.accounting.syncEnabled || !balanceTransaction?.id) {
    return;
  }

  const amount = Math.abs(balanceTransaction.amount ?? 0);
  if (amount === 0) {
    return;
  }

  await deps.idempotencyStore.withLock(
    `bt_${balanceTransaction.id}`,
    async () => {
      const posting = await deps.accounting.postRefundToQbo({
        amount,
        memo: `Stripe refund ${refund.id} (charge ${charge.id})`,
        date: timestampToDate(
          balanceTransaction.created ?? balanceTransaction.available_on ?? null,
        ),
      });

      await markPosted(salesforce, upsertResult, posting);
    },
  );
};

const resolveDisputeBalanceTransactions = async (
  stripe: Stripe,
  dispute: Stripe.Dispute,
): Promise<Stripe.BalanceTransaction[]> => {
  const ids = (dispute.balance_transactions || [])
    .map((entry) => normalizeStripeId(entry))
    .filter((value): value is string => typeof value === 'string');

  const results: Stripe.BalanceTransaction[] = [];

  for (const id of ids) {
    try {
      const balanceTransaction = await stripe.balanceTransactions.retrieve(id);
      results.push(balanceTransaction);
    } catch (error) {
      // Ignore missing balance transactions
    }
  }

  return results;
};

const handleDisputeClosed = async (
  context: HttpContext,
  event: Stripe.Event,
  deps: Dependencies,
): Promise<void> => {
  const dispute = event.data.object as Stripe.Dispute;

  if (dispute.status !== 'lost') {
    context.log('[StripeWebhook] Dispute closed without loss, ignoring', {
      disputeId: dispute.id,
      status: dispute.status,
    });
    return;
  }

  const stripe = deps.stripe.getClient(Boolean(event.livemode));
  const salesforce = await deps.getSalesforceSvc();

  const chargeId = normalizeStripeId(dispute.charge);
  const charge = chargeId ? await stripe.charges.retrieve(chargeId) : null;

  const balanceTransactions = await resolveDisputeBalanceTransactions(
    stripe,
    dispute,
  );

  const lossTransactions = balanceTransactions.filter((bt) => {
    if (bt.reporting_category === 'chargeback') {
      return true;
    }

    if (bt.reporting_category === 'chargeback_fee') {
      return false;
    }

    return bt.type === 'adjustment';
  });
  const feeTransactions = balanceTransactions.filter(
    (bt) => bt.reporting_category === 'chargeback_fee' || bt.type === 'stripe_fee',
  );

  const lossAmountCents = lossTransactions.reduce(
    (sum, bt) => sum + Math.abs(bt.amount ?? 0),
    0,
  );
  const feeAmountCents = feeTransactions.reduce(
    (sum, bt) => sum + Math.abs(bt.amount ?? 0),
    0,
  );

  const primaryBalanceTransaction =
    lossTransactions[0] || balanceTransactions[0] || null;

  const parentId = chargeId
    ? await salesforce.findTransactionIdByExternalId(
        'stripe_charge_id__c',
        chargeId,
      )
    : null;

  const transaction: TransactionUpsertDTO = {
    transaction_type__c: 'dispute',
    status__c: 'disputed',
    stripe_dispute_id__c: dispute.id,
    stripe_charge_id__c: chargeId,
    stripe_payment_intent_id__c: normalizeStripeId(
      charge?.payment_intent ?? dispute.payment_intent,
    ),
    stripe_balance_transaction_id__c: primaryBalanceTransaction?.id ?? null,
    stripe_customer_id__c: normalizeStripeId(charge?.customer),
    amount_gross__c: centsToPositiveMajorUnits(lossAmountCents),
    amount_fee__c: centsToPositiveMajorUnits(feeAmountCents),
    amount_net__c:
      lossAmountCents + feeAmountCents > 0
        ? centsToMajorUnits(-(lossAmountCents + feeAmountCents))
        : null,
    currency_iso_code__c: dispute.currency
      ? dispute.currency.toUpperCase()
      : charge?.currency?.toUpperCase() ?? null,
    received_at__c: timestampToIsoString(dispute.created ?? null),
    parent_transaction__c: parentId,
    payment_brand__c: charge?.payment_method_details?.card?.brand ?? null,
    payment_last4__c: charge?.payment_method_details?.card?.last4 ?? null,
  };

  context.log('[StripeWebhook] Upserting dispute transaction', {
    disputeId: dispute.id,
    chargeId,
  });

  const upsertResult = await salesforce.upsertTransactionByExternalId(
    transaction,
    'stripe_dispute_id__c',
  );

  if (!env.accounting.syncEnabled) {
    return;
  }

  const totalCents = lossAmountCents + feeAmountCents;
  if (totalCents === 0) {
    return;
  }

  const lockId = primaryBalanceTransaction?.id || `dispute_${dispute.id}`;

  await deps.idempotencyStore.withLock(`bt_${lockId}`, async () => {
    const posting = await deps.accounting.postDisputeToQbo({
      lossAmount: lossAmountCents,
      feeAmount: feeAmountCents,
      memo: `Stripe dispute ${dispute.id} (charge ${chargeId || '-'})`,
      date: timestampToDate(
        primaryBalanceTransaction?.created ??
          primaryBalanceTransaction?.available_on ??
          dispute.created ??
          null,
      ),
    });

    await markPosted(salesforce, upsertResult, posting);
  });
};

const processEvent = async (
  context: HttpContext,
  event: Stripe.Event,
  deps: Dependencies,
): Promise<void> => {
  switch (event.type) {
    case 'checkout.session.completed':
      await handleCheckoutSessionCompleted(context, event, deps);
      return;
    case 'payment_intent.succeeded':
      await handlePaymentIntentSucceeded(context, event, deps);
      return;
    case 'charge.refunded':
      await handleChargeRefunded(context, event, deps);
      return;
    case 'charge.dispute.closed':
      await handleDisputeClosed(context, event, deps);
      return;
    default:
      context.log('[StripeWebhook] Ignoring unsupported event type', {
        eventType: event.type,
      });
  }
};

const respond = (
  context: HttpContext,
  status: number,
  body: Record<string, unknown>,
): void => {
  context.res = {
    status,
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  };
};

const stripeWebhook = async (
  context: HttpContext,
  req: HttpRequest,
): Promise<void> => {
  const signature = getStripeSignature(req);

  if (!signature) {
    respond(context, 400, {
      received: false,
      error: 'missing_signature',
    });
    return;
  }

  const payload = getRawBody(req);

  let event: Stripe.Event;
  try {
    event = dependencies.stripe.verifyEvent(payload, signature);
  } catch (error) {
    context.log('[StripeWebhook] Signature verification failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    respond(context, 400, {
      received: false,
      error: 'invalid_signature',
    });
    return;
  }

  const eventKey = `evt_${event.id}`;

  try {
    const alreadyProcessed = await dependencies.idempotencyStore.isProcessed(
      eventKey,
    );
    if (alreadyProcessed) {
      respond(context, 200, {
        received: true,
        eventType: event.type,
        duplicate: true,
      });
      return;
    }

    await processEvent(context, event, dependencies);
    await dependencies.idempotencyStore.markProcessed(eventKey);

    respond(context, 200, {
      received: true,
      eventType: event.type,
    });
  } catch (error) {
    context.log('[StripeWebhook] Failed to process event', {
      eventId: event.id,
      eventType: event.type,
      error: error instanceof Error ? error.message : String(error),
    });
    respond(context, 500, {
      received: false,
      error: 'internal_error',
    });
  }
};

type HandlerWithInternals = typeof stripeWebhook & {
  __internals?: {
    setDependencies: (overrides?: DependencyOverrides) => void;
    resetDependencies: () => void;
  };
};

const handlerWithInternals = stripeWebhook as HandlerWithInternals;
handlerWithInternals.__internals = {
  setDependencies,
  resetDependencies,
};

export = handlerWithInternals;
