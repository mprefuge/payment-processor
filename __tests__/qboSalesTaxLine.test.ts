import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Sales tax on a QuickBooks sales receipt.
 *
 * Tax collected is money held in trust for the Commonwealth. It is inside what the buyer
 * paid, so it is inside the receipt total, but it is NOT income - and QuickBooks posts a
 * sales line to the account configured on the ITEM, ignoring any `ItemAccountRef` on the
 * line. So the only way tax reaches a liability account is through an item whose own
 * account IS that liability account, which is exactly the shape the processor-fee line
 * already uses.
 */

const defaultAccounts = {
  stripeClearing: 'Stripe Clearing|101',
  operatingBank: 'Operating Bank|102',
  revenue: 'Contributions|400',
  fees: 'Merchant Fees|600',
  refunds: 'Refunds|700',
  disputeLosses: 'Dispute Losses|800',
  salesTaxLiability: 'Sales Tax Payable|250',
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
    feeItem: 'Stripe Fees',
    salesTaxItem: 'Sales Tax Collected',
  },
};

const importQboSvc = async () => {
  vi.resetModules();
  vi.doMock('../src/config/env', () => ({ env: baseEnv, default: baseEnv }));
  return import('../src/services/qboSvc');
};

const TAX_ITEM = JSON.stringify({ value: '55', name: 'Sales Tax Collected' });

const lineFor = (receipt: any, description: string) =>
  receipt.Line.find((line: any) => line.Description === description);

describe('getSalesTaxAmountCents', () => {
  beforeEach(() => vi.unstubAllEnvs());

  it('reads the integer cents, not the formatted string beside it', async () => {
    const { getSalesTaxAmountCents } = await importQboSvc();
    expect(
      getSalesTaxAmountCents({
        checkoutSession: { metadata: { tax_amount_cents: '2400', tax_amount: '$24.00' } },
      } as any)
    ).toBe(2400);
  });

  it('reads it off the charge as well as the session', async () => {
    const { getSalesTaxAmountCents } = await importQboSvc();
    expect(getSalesTaxAmountCents({ charge: { metadata: { tax_amount_cents: 513 } } } as any)).toBe(
      513
    );
  });

  it('is zero when there is no tax, and for anything unusable', async () => {
    const { getSalesTaxAmountCents } = await importQboSvc();
    expect(getSalesTaxAmountCents(null)).toBe(0);
    expect(getSalesTaxAmountCents({ charge: { metadata: {} } } as any)).toBe(0);
    expect(
      getSalesTaxAmountCents({ charge: { metadata: { tax_amount_cents: '-500' } } } as any)
    ).toBe(0);
    expect(
      getSalesTaxAmountCents({ charge: { metadata: { tax_amount_cents: 'lots' } } } as any)
    ).toBe(0);
  });

  it('never reads the formatted string on its own', async () => {
    // A number that has been through a currency formatter has lost the argument about what
    // unit it is in - that is how Cover_Fees_Amount__c came to be stored 100x overstated.
    const { getSalesTaxAmountCents } = await importQboSvc();
    expect(getSalesTaxAmountCents({ charge: { metadata: { tax_amount: '$24.00' } } } as any)).toBe(
      0
    );
  });
});

describe('buildSalesReceipt sales tax line', () => {
  beforeEach(() => vi.unstubAllEnvs());

  it('carves the tax out of revenue onto its own line', async () => {
    // $424.00 charged: $400.00 of guides and $24.00 of Kentucky sales tax.
    const { buildSalesReceipt } = await importQboSvc();
    const receipt = buildSalesReceipt({
      amountCents: 42_400,
      date: new Date('2026-09-10'),
      revenueItemName: 'rev-item',
      depositAccountName: 'acct-dep',
      salesTaxAmountCents: 2_400,
      salesTaxItemRef: TAX_ITEM,
    });

    expect(receipt.Line.length).toBe(2);
    // The revenue line no longer carries the tax. This is the whole point.
    expect(receipt.Line[0].Amount).toBe(400.0);
    expect(lineFor(receipt, 'Sales Tax Collected').Amount).toBe(24.0);
    // And the receipt still totals to what the buyer was charged.
    const total = receipt.Line.reduce((sum: number, line: any) => sum + line.Amount, 0);
    expect(Number(total.toFixed(2))).toBe(424.0);
  });

  it('posts the tax through the item it was given, with no ItemAccountRef', async () => {
    // QuickBooks ignores ItemAccountRef on a sales line - the account on the ITEM is what
    // decides where it lands, so putting one here would be a comforting no-op.
    const { buildSalesReceipt } = await importQboSvc();
    const receipt = buildSalesReceipt({
      amountCents: 42_400,
      date: new Date('2026-09-10'),
      revenueItemName: 'rev-item',
      depositAccountName: 'acct-dep',
      salesTaxAmountCents: 2_400,
      salesTaxItemRef: TAX_ITEM,
    });

    const taxLine = lineFor(receipt, 'Sales Tax Collected');
    expect(taxLine.SalesItemLineDetail.ItemRef).toMatchObject({
      value: '55',
      name: 'Sales Tax Collected',
    });
    expect(taxLine.SalesItemLineDetail.ItemAccountRef).toBeUndefined();
  });

  it('leaves the tax in revenue when no item could be resolved', async () => {
    // No worse than before any of this existed, and never a failed receipt. A receipt that
    // posts with the tax in revenue is recoverable with a journal entry; a receipt that
    // failed to post is a payment with no book entry at all.
    const { buildSalesReceipt } = await importQboSvc();
    const receipt = buildSalesReceipt({
      amountCents: 42_400,
      date: new Date('2026-09-10'),
      revenueItemName: 'rev-item',
      depositAccountName: 'acct-dep',
      salesTaxAmountCents: 2_400,
      // no salesTaxItemRef
    });

    expect(receipt.Line.length).toBe(1);
    expect(receipt.Line[0].Amount).toBe(424.0);
  });

  it('emits no tax line for an order that carried no tax', async () => {
    const { buildSalesReceipt } = await importQboSvc();
    const receipt = buildSalesReceipt({
      amountCents: 40_000,
      date: new Date('2026-09-10'),
      revenueItemName: 'rev-item',
      depositAccountName: 'acct-dep',
      salesTaxAmountCents: 0,
      salesTaxItemRef: TAX_ITEM,
    });

    expect(receipt.Line.length).toBe(1);
    expect(receipt.Line[0].Amount).toBe(400.0);
  });

  it('sits between the revenue lines and the negative fee line', async () => {
    // The gross revenue line has to stay at index 0 because patchQboSalesReceiptFields
    // patches only the FIRST SalesItemLineDetail, and the fee line has to stay last.
    const { buildSalesReceipt } = await importQboSvc();
    const receipt = buildSalesReceipt({
      docNumber: 'CHG-20260910-abc',
      amountCents: 43_385,
      date: new Date('2026-09-10'),
      revenueItemName: 'rev-item',
      depositAccountName: 'acct-dep',
      coverFeesAmountCents: 985,
      coverFeesItemRef: JSON.stringify({ value: '44', name: 'Stripe Fee Coverage' }),
      salesTaxAmountCents: 2_400,
      salesTaxItemRef: TAX_ITEM,
      stripeFeeAmountCents: 985,
      feeLineItemRef: JSON.stringify({ value: '66', name: 'Stripe Fees' }),
      feeLineAmountCents: 985,
    });

    expect(receipt.Line.map((l: any) => l.Description)).toEqual([
      undefined,
      'Processing Fee Coverage',
      'Sales Tax Collected',
      'Stripe Fee',
    ]);
    expect(receipt.Line[0].Amount).toBe(400.0);
    expect(receipt.Line[3].Amount).toBe(-9.85);
  });

  it('keeps the tax in revenue when an explicit line amount was supplied', async () => {
    // The override says "the revenue line is exactly this". Honouring it AND adding a tax
    // line would make the receipt total more than the buyer was charged.
    const { buildSalesReceipt } = await importQboSvc();
    const receipt = buildSalesReceipt({
      amountCents: 42_400,
      date: new Date('2026-09-10'),
      revenueItemName: 'rev-item',
      depositAccountName: 'acct-dep',
      lineAmountCents: 42_400,
      salesTaxAmountCents: 2_400,
      salesTaxItemRef: TAX_ITEM,
    });

    expect(receipt.Line.length).toBe(1);
    expect(receipt.Line[0].Amount).toBe(424.0);
  });

  it('refuses to let tax swallow the receipt', async () => {
    const { buildSalesReceipt } = await importQboSvc();
    const receipt = buildSalesReceipt({
      amountCents: 2_400,
      date: new Date('2026-09-10'),
      revenueItemName: 'rev-item',
      depositAccountName: 'acct-dep',
      salesTaxAmountCents: 2_400,
      salesTaxItemRef: TAX_ITEM,
    });

    expect(receipt.Line.length).toBe(1);
    expect(receipt.Line[0].Amount).toBe(24.0);
  });
});

describe('remembering a routing miss', () => {
  beforeEach(() => vi.unstubAllEnvs());

  it('remembers a missing item or account', async () => {
    // Both names have defaults now, so a company file that never made the item would
    // otherwise pay for two lookups and a thrown error on every taxed order, forever.
    const { isDurableRoutingMiss } = await importQboSvc();
    expect(
      isDurableRoutingMiss(new Error('QuickBooks account "Sales Tax Payable" could not be found.'))
    ).toBe(true);
  });

  it('does not remember a bad ten seconds', async () => {
    // Caching a timeout would route ten minutes of tax into revenue because one call
    // went wrong, which is a far worse trade than one wasted lookup.
    const { isDurableRoutingMiss } = await importQboSvc();
    expect(isDurableRoutingMiss(new Error('ETIMEDOUT'))).toBe(false);
    expect(isDurableRoutingMiss(new Error('Request failed with status 500'))).toBe(false);
    expect(isDurableRoutingMiss('not even an error')).toBe(false);
    expect(isDurableRoutingMiss(null)).toBe(false);
  });
});
