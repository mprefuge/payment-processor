import { describe, it, expect, vi } from 'vitest';
import type Stripe from 'stripe';

import { handleInvoicePaidNoPI } from '../src/stripe/handlers/invoicePaid';
import type { StripeWebhookDependencies } from '../src/stripe/types';

/**
 * The out-of-band invoice path (an invoice marked paid with no payment intent — a check
 * or wire recorded against a subscription) is the one place a recurring gift reaches
 * Salesforce without a charge to identify it.
 */
const createDeps = () => {
  const salesforce = {
    upsertTransactionByExternalId: vi.fn().mockResolvedValue({ id: 'sf_1', success: true }),
    linkPayoutOnTransactions: vi.fn(),
    markPostedToQbo: vi.fn(),
    findTransactionIdByExternalId: vi.fn().mockResolvedValue(null),
  };

  const deps = {
    getSalesforceSvc: async () => salesforce,
  } as unknown as StripeWebhookDependencies;

  return { deps, salesforce };
};

const createContext = () => {
  const logs: unknown[][] = [];
  const log = (...args: unknown[]) => {
    logs.push(args);
  };
  (log as any).info = log;
  (log as any).warn = log;
  (log as any).error = log;
  return { context: { log } as any, logs };
};

const buildInvoice = (overrides: Partial<Stripe.Invoice> = {}): Stripe.Invoice =>
  ({
    id: 'in_month_2',
    subscription: 'sub_shared',
    customer: 'cus_1',
    currency: 'usd',
    amount_paid: 50_000,
    total: 50_000,
    created: 1_700_000_000,
    collection_method: 'send_invoice',
    paid_out_of_band: true,
    status_transitions: { paid_at: 1_700_000_500 },
    ...overrides,
  }) as unknown as Stripe.Invoice;

const buildEvent = (): Stripe.Event =>
  ({ id: 'evt_1', livemode: false }) as unknown as Stripe.Event;

describe('handleInvoicePaidNoPI', () => {
  it('keys the upsert on the invoice id, not the shared subscription id', async () => {
    // Regression: keying on stripe_subscription_id__c made month 2 of a recurring gift
    // overwrite month 1's Transaction__c, collapsing the donor's giving history.
    const { deps, salesforce } = createDeps();
    const { context } = createContext();

    await handleInvoicePaidNoPI(context, buildInvoice(), buildEvent(), deps);

    expect(salesforce.upsertTransactionByExternalId).toHaveBeenCalledTimes(1);
    const [, key] = salesforce.upsertTransactionByExternalId.mock.calls[0];
    expect(key).toBe('stripe_invoice_id__c');
    expect(key).not.toBe('stripe_subscription_id__c');
  });

  it('still records the subscription id on the transaction', async () => {
    // The linkage field is wanted for reporting; it just must not be the identity key.
    const { deps, salesforce } = createDeps();
    const { context } = createContext();

    await handleInvoicePaidNoPI(context, buildInvoice(), buildEvent(), deps);

    const [dto] = salesforce.upsertTransactionByExternalId.mock.calls[0];
    expect(dto.stripe_subscription_id__c).toBe('sub_shared');
    expect(dto.stripe_invoice_id__c).toBe('in_month_2');
  });

  it('gives two invoices in the same series distinct upsert keys', async () => {
    const { deps, salesforce } = createDeps();
    const { context } = createContext();

    await handleInvoicePaidNoPI(context, buildInvoice({ id: 'in_month_1' }), buildEvent(), deps);
    await handleInvoicePaidNoPI(context, buildInvoice({ id: 'in_month_2' }), buildEvent(), deps);

    const keyValues = salesforce.upsertTransactionByExternalId.mock.calls.map(
      ([dto, key]: [Record<string, unknown>, string]) => dto[key]
    );
    expect(keyValues).toEqual(['in_month_1', 'in_month_2']);
    expect(new Set(keyValues).size).toBe(2);
  });

  it('never reports net greater than gross on a discounted invoice', async () => {
    // Regression: amount_gross__c came from amount_paid while amount_net__c came from
    // invoice.total. `total` is the invoice's face value before payment, not a
    // net-of-fees figure, so a discounted or partially paid invoice produced net > gross.
    const { deps, salesforce } = createDeps();
    const { context } = createContext();

    await handleInvoicePaidNoPI(
      context,
      buildInvoice({ amount_paid: 40_000, total: 50_000 } as Partial<Stripe.Invoice>),
      buildEvent(),
      deps
    );

    const [dto] = salesforce.upsertTransactionByExternalId.mock.calls[0];
    expect(dto.amount_gross__c).toBe(400);
    expect(dto.amount_net__c).toBeLessThanOrEqual(dto.amount_gross__c);
    expect(dto.amount_net__c).toBe(400);
  });

  it('skips entirely when the invoice has no subscription', async () => {
    const { deps, salesforce } = createDeps();
    const { context } = createContext();

    await handleInvoicePaidNoPI(
      context,
      buildInvoice({ subscription: null } as Partial<Stripe.Invoice>),
      buildEvent(),
      deps
    );

    expect(salesforce.upsertTransactionByExternalId).not.toHaveBeenCalled();
  });
});
