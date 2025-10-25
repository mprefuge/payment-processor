import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRequire } from 'module';
import type Stripe from 'stripe';

import { handleCreditNoteEvent } from '../src/stripe/handlers/creditNotes';
import type { StripeWebhookDependencies } from '../src/stripe/types';

const require = createRequire(import.meta.url);
const { createContext } = require('./testUtils');

const createCreditNote = (overrides: Partial<Stripe.CreditNote> = {}): Stripe.CreditNote =>
  ({
    id: 'cn_123',
    number: 'CN-1001',
    amount: 1000,
    currency: 'usd',
    status: 'issued',
    invoice: 'in_123',
    created: 1_700_000_000,
    lines: {
      data: [
        {
          id: 'cnli_1',
          amount: 600,
          description: 'Tuition refund',
          object: 'credit_note_line_item',
        },
        {
          id: 'cnli_2',
          amount: 400,
          description: 'Materials refund',
          object: 'credit_note_line_item',
        },
      ],
      has_more: false,
      object: 'list',
      total_count: 2,
      url: '/v1/credit_notes/cn_123/lines',
    },
    memo: null,
    reason: null,
    livemode: false,
    object: 'credit_note',
    customer: 'cus_123',
    ...overrides,
  }) as Stripe.CreditNote;

const createInvoice = (overrides: Partial<Stripe.Invoice> = {}): Stripe.Invoice =>
  ({
    id: 'in_123',
    number: 'INV-1001',
    payment_intent: 'pi_123',
    customer: 'cus_123',
    subscription: 'sub_123',
    currency: 'usd',
    charge: 'ch_123',
    object: 'invoice',
    status: 'paid',
    ...overrides,
  }) as Stripe.Invoice;

const createPaymentIntent = (overrides: Partial<Stripe.PaymentIntent> = {}): Stripe.PaymentIntent =>
  ({
    id: 'pi_123',
    amount: 1000,
    currency: 'usd',
    customer: 'cus_123',
    metadata: {},
    object: 'payment_intent',
    created: 1_700_000_000,
    status: 'succeeded',
    ...overrides,
  }) as Stripe.PaymentIntent;

const createCharge = (overrides: Partial<Stripe.Charge> = {}): Stripe.Charge =>
  ({
    id: 'ch_123',
    amount: 1000,
    currency: 'usd',
    customer: 'cus_123',
    payment_intent: 'pi_123',
    metadata: {},
    balance_transaction: 'bt_123',
    status: 'succeeded',
    created: 1_700_000_000,
    object: 'charge',
    refunds: {
      object: 'list',
      data: [],
      has_more: false,
      total_count: 0,
      url: '/v1/charges/ch_123/refunds',
    },
    ...overrides,
  }) as Stripe.Charge;

interface SetupOptions {
  creditNote?: Stripe.CreditNote;
  invoice?: Stripe.Invoice | null;
  paymentIntent?: Stripe.PaymentIntent | null;
  charge?: Stripe.Charge | null;
}

const setup = ({
  creditNote = createCreditNote(),
  invoice = createInvoice(),
  paymentIntent = createPaymentIntent(),
  charge = createCharge(),
}: SetupOptions = {}) => {
  const stripeClient = {
    invoices: {
      retrieve: vi.fn().mockResolvedValue(invoice),
    },
    paymentIntents: {
      retrieve: vi.fn().mockResolvedValue(paymentIntent),
    },
    charges: {
      retrieve: vi.fn().mockResolvedValue(charge),
    },
  } as unknown as Stripe;

  const salesforce = {
    upsertTransactionByExternalId: vi.fn().mockResolvedValue({ id: 'sf_cn_1' }),
    linkPayoutOnTransactions: vi.fn(),
    markPostedToQbo: vi.fn().mockResolvedValue(undefined),
    findTransactionIdByExternalId: vi.fn().mockResolvedValue('sf_invoice_1'),
  };

  const refundAdapter = {
    upsertRefundReceipt: vi.fn().mockResolvedValue({ qboId: 'RR-1', type: 'RefundReceipt' }),
    markRefundVoided: vi.fn().mockResolvedValue(undefined),
  };

  const deps: StripeWebhookDependencies = {
    stripe: {
      verifyEvent: vi.fn(),
      getClient: vi.fn().mockReturnValue(stripeClient),
    },
    idempotencyStore: {
      isProcessed: vi.fn(),
      markProcessed: vi.fn(),
      withLock: vi.fn().mockImplementation(async (_: string, fn: () => Promise<unknown>) => fn()),
      flush: vi.fn(),
    },
    getSalesforceSvc: vi.fn().mockResolvedValue(salesforce),
    accounting: {
      postChargeToQbo: vi.fn(),
      postRefundToQbo: vi.fn(),
      postDisputeToQbo: vi.fn(),
      refundReceipts: refundAdapter,
    },
  };

  const context = createContext();

  const event: Stripe.Event = {
    id: 'evt_test',
    type: 'credit_note.created',
    data: { object: creditNote } as Stripe.Event.Data,
    livemode: false,
    object: 'event',
    created: creditNote.created ?? 1_700_000_000,
    pending_webhooks: 1,
    request: { id: 'req_1', idempotency_key: null },
    api_version: '2023-10-16',
  };

  return {
    context,
    event,
    deps,
    creditNote,
    invoice,
    paymentIntent,
    charge,
    salesforce,
    refundAdapter,
    stripeClient,
  };
};

describe('handleCreditNoteEvent', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2024-01-01T00:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('upserts Salesforce and posts refund receipt for created credit note', async () => {
    const { context, event, deps, refundAdapter, salesforce, creditNote } = setup();

    await handleCreditNoteEvent(context, event, deps);

    expect(salesforce.upsertTransactionByExternalId).toHaveBeenCalledTimes(1);
    const payload = salesforce.upsertTransactionByExternalId.mock.calls[0][0];
    expect(payload.stripe_credit_note_id__c).toBe(creditNote.id);
    expect(payload.stripe_invoice_id__c).toBe('in_123');
    expect(payload.parent_transaction__c).toBe('sf_invoice_1');

    expect(deps.idempotencyStore.withLock).toHaveBeenCalledWith(
      `stripe_evt_${event.id}`,
      expect.any(Function)
    );

    expect(refundAdapter.upsertRefundReceipt).toHaveBeenCalledTimes(1);
    const refundInput = refundAdapter.upsertRefundReceipt.mock.calls[0][0];
    expect(refundInput.stripeRefundId).toBe(creditNote.id);
    expect(refundInput.lines).toHaveLength(2);
    const total = refundInput.lines.reduce(
      (sum: number, line: { amountCents: number }) => sum + line.amountCents,
      0
    );
    expect(total).toBe(creditNote.amount);

    expect(salesforce.markPostedToQbo).toHaveBeenCalledWith('sf_cn_1', {
      id: 'RR-1',
      type: 'RefundReceipt',
    });
  });

  it('updates refund receipt lines on amount change', async () => {
    const creditNote = createCreditNote({
      amount: 500,
      lines: {
        data: [
          {
            id: 'cnli_partial',
            amount: 500,
            description: 'Adjustment',
            object: 'credit_note_line_item',
          },
        ],
        has_more: false,
        object: 'list',
        total_count: 1,
        url: '/v1/credit_notes/cn_123/lines',
      },
    });
    const { context, deps, event, refundAdapter } = setup({
      creditNote,
    });
    event.type = 'credit_note.updated';

    await handleCreditNoteEvent(context, event, deps);

    expect(refundAdapter.upsertRefundReceipt).toHaveBeenCalledTimes(1);
    const refundInput = refundAdapter.upsertRefundReceipt.mock.calls[0][0];
    expect(refundInput.lines).toHaveLength(1);
    expect(refundInput.lines[0].amountCents).toBe(500);
  });

  it('marks refund receipt voided without reposting on void event', async () => {
    const creditNote = createCreditNote({ status: 'void' });
    const { context, deps, event, refundAdapter, salesforce } = setup({
      creditNote,
    });
    event.type = 'credit_note.voided';

    await handleCreditNoteEvent(context, event, deps);

    expect(refundAdapter.upsertRefundReceipt).not.toHaveBeenCalled();
    expect(refundAdapter.markRefundVoided).toHaveBeenCalledTimes(1);
    const voidPayload = refundAdapter.markRefundVoided.mock.calls[0][0];
    expect(voidPayload).toMatchObject({
      stripeRefundId: creditNote.id,
      stripeEventId: event.id,
      reason: 'credit_note_voided',
    });
    expect(salesforce.markPostedToQbo).not.toHaveBeenCalled();
  });
});
