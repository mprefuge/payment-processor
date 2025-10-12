import Stripe from 'stripe';
import jsforce from 'jsforce';

import env from '../config/env';
import {
  AzureIdempotencyStore,
  type IdempotencyStore,
} from '../services/idempotencyStore';
import { createSalesforceSvc, type SalesforceSvc } from '../services/salesforceSvc';
import type { UpsertResult } from 'jsforce/lib/types';
import {
  postChargeToQbo,
  postRefundToQbo,
  postDisputeToQbo,
  postPayoutToQbo,
} from '../services/qboSvc';
import type { TransactionUpsertDTO } from '../domain/transactions';
import {
  type DependencyOverrides,
  type HttpContext,
  type StripeWebhookDependencies,
  type StripeWebhookRequest,
  type RefundReceiptAccountingAdapter,
  type PayoutAccountingAdapter,
} from '../stripe/types';
import {
  handlePaymentIntentActionRequired,
  handlePaymentIntentCanceled,
  handlePaymentIntentFailed,
  handlePaymentIntentSucceeded,
} from '../stripe/handlers/paymentIntents';
import {
  handleInvoicePaid,
  handleInvoicePaymentActionRequired,
  handleInvoicePaymentFailed,
} from '../stripe/handlers/invoicePaid';
import { handleChargeRefunded, handleRefundEvent } from '../stripe/handlers/refunds';
import { handlePayoutEvent } from '../stripe/handlers/payouts';
import { handleDisputeClosed } from '../stripe/handlers/disputes';
import { handleCreditNoteEvent } from '../stripe/handlers/creditNotes';
import {
  centsToMajorUnits,
  normalizeStripeId,
  timestampToDate,
  timestampToIsoString,
} from '../stripe/utils';

const STRIPE_API_VERSION: Stripe.LatestApiVersion = '2023-10-16';

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

const createStripeServices = (): StripeWebhookDependencies['stripe'] => {
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

const createDisabledSalesforceSvc = (): SalesforceSvc => {
  const disabledUpsertResult = { success: true, id: '', errors: [] } as unknown as UpsertResult;

  return {
    async upsertTransactionByExternalId(): Promise<UpsertResult> {
      return disabledUpsertResult;
    },
    async linkPayoutOnTransactions(): Promise<UpsertResult[]> {
      return [];
    },
    async markPostedToQbo(): Promise<void> {
      return;
    },
    async findTransactionIdByExternalId(): Promise<string | null> {
      return null;
    },
  };
};

const resolveSalesforceUsername = (): string | undefined =>
  env.salesforce.username ||
  process.env.SALESFORCE_USERNAME ||
  process.env.SF_USERNAME ||
  undefined;

const resolveSalesforcePassword = (): string | undefined =>
  process.env.SALESFORCE_PASSWORD || process.env.SF_PASSWORD || undefined;

const resolveSalesforceSecurityToken = (): string =>
  process.env.SALESFORCE_SECURITY_TOKEN || process.env.SF_SECURITY_TOKEN || '';

const resolveSalesforceLoginUrl = (): string =>
  env.salesforce.loginUrl ||
  process.env.SALESFORCE_LOGIN_URL ||
  process.env.SF_LOGIN_URL ||
  'https://login.salesforce.com';

const createSalesforceGetter = (): (() => Promise<SalesforceSvc>) => {
  const disabledSvc = createDisabledSalesforceSvc();

  if (env.salesforce.authMode === 'disabled') {
    return async () => disabledSvc;
  }

  if (env.salesforce.authMode !== 'username-password') {
    throw new Error(`Unsupported Salesforce auth mode: ${env.salesforce.authMode}`);
  }

  return async (): Promise<SalesforceSvc> => {
    if (!defaultSalesforceSvcPromise) {
      defaultSalesforceSvcPromise = (async () => {
        try {
          const username = resolveSalesforceUsername();
          const password = resolveSalesforcePassword();
          const securityToken = resolveSalesforceSecurityToken();
          const loginUrl = resolveSalesforceLoginUrl();

          if (!username || !password) {
            throw new Error('Salesforce credentials are not configured.');
          }

          const connection = new jsforce.Connection({ loginUrl });
          await connection.login(username, `${password}${securityToken}`);
          return createSalesforceSvc({ connection });
        } catch (error) {
          defaultSalesforceSvcPromise = null;

          const message =
            error instanceof Error ? error.message : 'Unknown Salesforce initialization error';
          console.warn('[StripeWebhook] Falling back to disabled Salesforce service', {
            error: message,
          });

          return disabledSvc;
        }
      })();
    }

    return defaultSalesforceSvcPromise;
  };
};

const sumRefundLineAmounts = (lines: { amountCents: number }[]): number =>
  lines.reduce((total, line) => total + Math.max(0, Math.trunc(line.amountCents || 0)), 0);

const createRefundReceiptAdapter = (): RefundReceiptAccountingAdapter => ({
  async upsertRefundReceipt(input) {
    const totalCents = sumRefundLineAmounts(input.lines ?? []);
    if (totalCents <= 0) {
      return null;
    }

    const result = await postRefundToQbo({
      amount: totalCents,
      memo: input.memo,
      date: input.txnDate,
    });

    return { id: result.qboId, type: result.type };
  },
});

const createPayoutAdapter = (): PayoutAccountingAdapter => ({
  async upsertDeposit(input) {
    const amountCents = Math.abs(Math.trunc(input.totalAmountCents ?? 0));
    if (amountCents <= 0) {
      return null;
    }

    const result = await postPayoutToQbo({
      amount: amountCents,
      memo: input.memo,
      date: input.txnDate,
    });

    return { id: result.qboId, type: result.type };
  },
  async markDepositForReview() {
    return;
  },
});

const createDefaultDependencies = (): StripeWebhookDependencies => ({
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
    refundReceipts: createRefundReceiptAdapter(),
    payouts: createPayoutAdapter(),
  },
});

let dependencies: StripeWebhookDependencies = createDefaultDependencies();

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

const getStripeSignature = (req: StripeWebhookRequest): string | undefined => {
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

const getRawBody = (req: StripeWebhookRequest): string => {
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

const handleCheckoutSessionCompleted = async (
  context: HttpContext,
  event: Stripe.Event,
  deps: StripeWebhookDependencies,
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

const processEvent = async (
  context: HttpContext,
  event: Stripe.Event,
  deps: StripeWebhookDependencies,
): Promise<void> => {
  const eventType = event.type as string;

  switch (eventType) {
    case 'checkout.session.completed':
      await handleCheckoutSessionCompleted(context, event, deps);
      return;
    case 'payment_intent.succeeded':
      await handlePaymentIntentSucceeded(context, event, deps);
      return;
    case 'payment_intent.payment_failed':
      await handlePaymentIntentFailed(context, event, deps);
      return;
    case 'payment_intent.canceled':
      await handlePaymentIntentCanceled(context, event, deps);
      return;
    case 'charge.refunded':
      await handleChargeRefunded(context, event, deps);
      return;
    case 'refund.created':
    case 'refund.updated':
    case 'refund.failed':
      await handleRefundEvent(context, event, deps);
      return;
    case 'charge.dispute.closed':
      await handleDisputeClosed(context, event, deps);
      return;
    case 'invoice.paid':
    case 'invoice.payment_succeeded':
      await handleInvoicePaid(context, event, deps);
      return;
    case 'invoice.payment_failed':
      await handleInvoicePaymentFailed(context, event, deps);
      return;
    case 'invoice.payment_action_required':
      await handleInvoicePaymentActionRequired(context, event, deps);
      return;
    case 'payout.paid':
    case 'payout.failed':
    case 'payout.canceled':
    case 'payout.reconciliation_completed':
      await handlePayoutEvent(context, event, deps);
      return;
    case 'credit_note.created':
    case 'credit_note.updated':
    case 'credit_note.voided':
      await handleCreditNoteEvent(context, event, deps);
      return;
    default:
      context.log('[StripeWebhook] Ignoring unsupported event type', {
        eventType,
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
  req: StripeWebhookRequest,
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
