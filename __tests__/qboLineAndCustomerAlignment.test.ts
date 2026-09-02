import { describe, it, expect, vi } from 'vitest';
import type Stripe from 'stripe';

const defaultAccounts = {
  stripeClearing: 'Stripe Clearing|QBO_ACCOUNT_STRIPE_CLEARING',
  operatingBank: 'Operating Bank|QBO_ACCOUNT_OPERATING_BANK',
  revenue: 'Revenue|QBO_ACCOUNT_REVENUE',
  fees: 'Stripe Fees|QBO_ACCOUNT_FEES',
  refunds: 'Refunds|QBO_ACCOUNT_REFUNDS',
  disputeLosses: 'Dispute Losses|QBO_ACCOUNT_DISPUTE_LOSSES',
};

const baseEnv = {
  quickBooks: {
    environment: 'sandbox',
    realmId: '12345',
    clientId: 'client',
    clientSecret: 'secret',
    redirectUri: 'http://localhost:3000/oauth/callback',
    refreshToken: 'refresh',
    accounts: { ...defaultAccounts },
  },
  accounting: {
    postingStrategy: 'sales-receipt',
    syncEnabled: true,
    defaultSalesItem: 'Stripe Transaction',
    feeCoverageItem: 'Stripe Fee Coverage',
  },
};

const importQboSvc = async () => {
  vi.resetModules();
  vi.doMock('../src/config/env', () => ({ env: baseEnv, default: baseEnv }));
  return import('../src/services/qboSvc');
};

/**
 * Two ways the receipts this processor writes read differently from the incumbent
 * Stripe sync's, on the same charge:
 *   - a recurring gift's line said "Subscription update" instead of naming the fund
 *   - an anonymous gift created a QuickBooks customer named after a Stripe id
 */
describe('receipt line description', () => {
  it("prefers the resolved product over Stripe's generic subscription description", async () => {
    const { getStripeLineDescription } = await importQboSvc();

    // What a real recurring gift looks like: Stripe stamps "Subscription update" on the
    // charge, and the fund is only knowable from the invoice's product.
    expect(
      getStripeLineDescription({
        charge: { description: 'Subscription update' } as Stripe.Charge,
        productName: 'General Giving',
      })
    ).toBe('General Giving');
  });

  it('returns null on a generic description so the caller can fall back', async () => {
    const { getStripeLineDescription } = await importQboSvc();

    // Without a product name there is nothing better here, but "Subscription update" is
    // worse than the caller's `category - transactionType`, so it must not win.
    expect(
      getStripeLineDescription({
        charge: { description: 'Subscription update' } as Stripe.Charge,
      })
    ).toBeNull();
    expect(
      getStripeLineDescription({
        paymentIntent: { description: 'Subscription creation' } as Stripe.PaymentIntent,
      })
    ).toBeNull();
  });

  it('keeps a real description that a person wrote', async () => {
    const { getStripeLineDescription } = await importQboSvc();

    expect(
      getStripeLineDescription({
        charge: { description: 'TNND Camp Payment' } as Stripe.Charge,
      })
    ).toBe('TNND Camp Payment');
  });

  it('still prefers the payment intent description over the charge description', async () => {
    const { getStripeLineDescription } = await importQboSvc();

    expect(
      getStripeLineDescription({
        paymentIntent: { description: 'Ministry Support Dinner' } as Stripe.PaymentIntent,
        charge: { description: 'Cooking and Culture' } as Stripe.Charge,
      })
    ).toBe('Ministry Support Dinner');
  });

  it('falls through a generic payment intent description to a real charge description', async () => {
    const { getStripeLineDescription } = await importQboSvc();

    expect(
      getStripeLineDescription({
        paymentIntent: { description: 'Subscription update' } as Stripe.PaymentIntent,
        charge: { description: 'General Giving' } as Stripe.Charge,
      })
    ).toBe('General Giving');
  });
});

describe('unattributable donors', () => {
  const context = (over: Record<string, unknown> = {}) =>
    ({
      charge: {
        id: 'ch_anon',
        billing_details: { name: null, email: null, phone: null, address: null },
        ...(over.charge as object),
      },
      paymentIntent: { id: 'pi_anon' },
      customer: { id: 'cus_VBAr3ap3rdtbIn' },
      ...over,
    }) as never;

  it('flags a display name manufactured from a Stripe id', async () => {
    const { deriveSalesReceiptCustomer } = await importQboSvc();

    const derived = deriveSalesReceiptCustomer(context());

    // The name is still produced -- callers that must have one are unaffected -- but it is
    // marked, and that mark is what keeps CustomerRef off the receipt.
    expect(derived.displayName).toBe('Stripe Customer cus_VBAr3ap3rdtbIn');
    expect(derived.syntheticDisplayName).toBe(true);
  });

  it('does not flag a donor who gave a name', async () => {
    const { deriveSalesReceiptCustomer } = await importQboSvc();

    const derived = deriveSalesReceiptCustomer(
      context({ charge: { billing_details: { name: 'Nancy Tadatada' } } })
    );

    expect(derived.displayName).toBe('Nancy Tadatada');
    expect(derived.syntheticDisplayName).toBe(false);
  });

  it('does not flag a donor known only by email', async () => {
    const { deriveSalesReceiptCustomer } = await importQboSvc();

    const derived = deriveSalesReceiptCustomer(
      context({ charge: { billing_details: { email: 'donor@example.com' } } })
    );

    // An email is a real identity a person can act on, so it stays a customer.
    expect(derived.displayName).toBe('donor@example.com');
    expect(derived.syntheticDisplayName).toBe(false);
  });
});
