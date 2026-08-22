import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `cover_fees_amount` travels through Stripe metadata in CENTS — `processTransaction`
 * stringifies the cents value returned by `calculateCoverFees` straight into the
 * Checkout Session metadata. Every reader has to agree on that, and on the unit of
 * the Salesforce field it lands in.
 */

const ENV = {
  QBO_REALM_ID: '1234567890',
  QBO_ENVIRONMENT: 'sandbox',
  QBO_CLIENT_ID: 'test-client',
  QBO_CLIENT_SECRET: 'test-secret',
  QBO_REFRESH_TOKEN: 'test-refresh',
  QBO_ACCOUNT_STRIPE_CLEARING: 'Stripe Clearing|101',
  QBO_ACCOUNT_OPERATING_BANK: 'Operating Bank|102',
  QBO_ACCOUNT_REVENUE: 'Contributions|400',
  QBO_ACCOUNT_FEES: 'Merchant Fees|600',
  QBO_DEFAULT_SALES_ITEM: 'Donation',
  STRIPE_SECRET: 'sk_test_x',
  STRIPE_TEST_SECRET_KEY: 'sk_test_x',
  STRIPE_WEBHOOK_SECRET: 'whsec_x',
};

const session = (coverFeesAmount: string | number) => ({
  checkoutSession: {
    metadata: { cover_fees: 'true', cover_fees_amount: coverFeesAmount },
  },
});

describe('getCoverFeesInfo unit handling', () => {
  beforeEach(() => {
    for (const [key, value] of Object.entries(ENV)) {
      vi.stubEnv(key, value);
    }
  });

  const load = async () => await import('../src/services/qboSvc');

  it.each([
    ['30', 30],
    ['50', 50],
    ['88', 88],
    ['99', 99],
    ['100', 100],
    ['150', 150],
    ['1480', 1480],
  ])('reads integer metadata "%s" as cents', async (raw, expected) => {
    const { getCoverFeesInfo } = await load();
    expect(getCoverFeesInfo(session(raw) as never)).toEqual({
      enabled: true,
      amountCents: expected,
    });
  });

  it('scales a fractional value, which can only be dollars', async () => {
    const { getCoverFeesInfo } = await load();
    expect(getCoverFeesInfo(session('0.88') as never).amountCents).toBe(88);
    expect(getCoverFeesInfo(session('145.30') as never).amountCents).toBe(14530);
  });

  it('keeps a sub-dollar fee out of the gift line on the sales receipt', async () => {
    const { getCoverFeesInfo, buildSalesReceipt } = await load();

    // $500.00 gift with a $0.50 cover fee, charged as $500.50.
    const info = getCoverFeesInfo(session('50') as never);
    const receipt = buildSalesReceipt({
      docNumber: 'CHG-COVER',
      amountCents: 50_050,
      date: '2026-08-17',
      revenueItemName: JSON.stringify({ value: '77', name: 'Donation' }),
      coverFeesAmountCents: info.amountCents,
      stripeFeeAmountCents: 0,
    });

    const gift = receipt.Line[0];
    const coverage = receipt.Line.find((line) => line.Description === 'Processing Fee Coverage');

    expect(gift.Amount).toBe(500);
    expect(coverage?.Amount).toBe(0.5);
    expect(receipt.Line.reduce((sum, line) => sum + line.Amount, 0)).toBeCloseTo(500.5, 2);
  });
});

describe('Cover_Fees_Amount__c unit on the webhook path', () => {
  it('stores dollars, matching the checkout path and Amount_Gross__c', async () => {
    const { mapStripeToTransaction } = await import('../src/domain/transactions');

    const transaction = mapStripeToTransaction({
      charge: {
        id: 'ch_cover',
        amount: 50_050,
        currency: 'usd',
        status: 'succeeded',
        metadata: { cover_fees: 'true', cover_fees_amount: '50' },
      } as never,
    });

    expect(transaction.amount_gross__c).toBe(500.5);
    // crmTransactionWorkflow writes centsToMajorUnits(50) = 0.5 for the same gift.
    expect(transaction.cover_fees_amount__c).toBe(0.5);
  });

  it('leaves a fractional metadata value alone — it is already dollars', async () => {
    const { mapStripeToTransaction } = await import('../src/domain/transactions');

    const transaction = mapStripeToTransaction({
      charge: {
        id: 'ch_cover2',
        amount: 50_050,
        currency: 'usd',
        status: 'succeeded',
        metadata: { cover_fees_amount: '0.5' },
      } as never,
    });

    expect(transaction.cover_fees_amount__c).toBe(0.5);
  });

  it('returns null when no cover fee metadata is present', async () => {
    const { mapStripeToTransaction } = await import('../src/domain/transactions');

    const transaction = mapStripeToTransaction({
      charge: { id: 'ch_none', amount: 1_000, currency: 'usd', status: 'succeeded' } as never,
    });

    expect(transaction.cover_fees_amount__c).toBeNull();
  });
});
