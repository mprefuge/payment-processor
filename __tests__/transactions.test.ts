import { describe, expect, it } from 'vitest';

import { mapStripeToTransaction } from '../src/domain/transactions';

describe('mapStripeToTransaction', () => {
  const buildPaymentIntent = (metadata: Record<string, unknown> = {}) => ({
    id: 'pi_123',
    status: 'succeeded',
    currency: 'usd',
    metadata,
    charges: {
      data: [
        {
          id: 'ch_123',
        },
      ],
    },
    payment_method_types: ['card'],
  });

  const buildCharge = (metadata: Record<string, unknown> = {}) => ({
    id: 'ch_123',
    amount: 1000,
    currency: 'usd',
    balance_transaction: 'bt_123',
    metadata,
    payment_method_details: {
      type: 'card',
      card: {
        brand: 'visa',
        last4: '4242',
      },
    },
  });

  const buildBalanceTransaction = () => ({
    id: 'bt_123',
    amount: 1000,
    currency: 'usd',
    net: 900,
    fee: 100,
    type: 'charge',
  });

  it('omits metadata lookup fields when no identifiers are provided', () => {
    const dto = mapStripeToTransaction({
      paymentIntent: buildPaymentIntent() as any,
      charge: buildCharge() as any,
      balanceTransaction: buildBalanceTransaction() as any,
    });

    expect(Object.prototype.hasOwnProperty.call(dto, 'contact__c')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(dto, 'account__c')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(dto, 'campaign__c')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(dto, 'fund__c')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(dto, 'designation__c')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(dto, 'restriction__c')).toBe(false);
  });

  it('includes metadata lookup fields when identifiers are provided', () => {
    const metadata = {
      contact__c: '003xx000000000AAA',
      account__c: '001xx000000000AAA',
      campaign__c: '701xx000000000AAA',
      fund__c: 'a0Rxx000000000AAA',
      designation__c: 'a15xx000000000AAA',
      restriction__c: 'a0Oxx000000000AAA',
    };

    const dto = mapStripeToTransaction({
      paymentIntent: buildPaymentIntent(metadata) as any,
      charge: buildCharge() as any,
      balanceTransaction: buildBalanceTransaction() as any,
    });

    expect(dto.contact__c).toBe('003xx000000000AAA');
    expect(dto.account__c).toBe('001xx000000000AAA');
    expect(dto.campaign__c).toBe('701xx000000000AAA');
    expect(dto.fund__c).toBe('a0Rxx000000000AAA');
    expect(dto.designation__c).toBe('a15xx000000000AAA');
    expect(dto.restriction__c).toBe('a0Oxx000000000AAA');
  });

  it('honors salesforce_id metadata as the contact reference', () => {
    const metadata = { salesforce_id: '003FAKEID' };

    const dto = mapStripeToTransaction({
      paymentIntent: buildPaymentIntent(metadata) as any,
      charge: buildCharge() as any,
      balanceTransaction: buildBalanceTransaction() as any,
    });

    expect(dto.contact__c).toBe('003FAKEID');
  });

  it('falls back to salesforce_id found on the Stripe customer when intent/charge metadata is empty', () => {
    const customer = { id: 'cus_test', metadata: { salesforce_id: '003CUST' } };

    const dto = mapStripeToTransaction({
      paymentIntent: buildPaymentIntent({}) as any,
      charge: buildCharge({}) as any,
      balanceTransaction: buildBalanceTransaction() as any,
      stripeCustomer: customer as any,
    });

    expect(dto.contact__c).toBe('003CUST');
  });

  it('maps support-facing Stripe fields from the charge and balance transaction', () => {
    const dto = mapStripeToTransaction({
      paymentIntent: {
        ...buildPaymentIntent(),
        livemode: false,
      } as any,
      charge: {
        ...buildCharge(),
        livemode: false,
        created: 1_700_000_000,
        receipt_url: 'https://pay.stripe.test/receipts/ch_123',
        billing_details: {
          name: 'Donor Example',
          email: 'donor@example.com',
          phone: '+15555550123',
        },
        statement_descriptor: null,
        calculated_statement_descriptor: 'REFUGE INTL',
      } as any,
      balanceTransaction: {
        ...buildBalanceTransaction(),
        amount: 1500,
        fee: 75,
        net: 1425,
      } as any,
    });

    expect(dto).toMatchObject({
      stripe_livemode__c: false,
      stripe_receipt_url__c: 'https://pay.stripe.test/receipts/ch_123',
      amount_gross__c: 15,
      amount_fee__c: 0.75,
      amount_net__c: 14.25,
      currency_iso_code__c: 'USD',
      payment_method__c: 'card',
      payment_brand__c: 'visa',
      payment_last4__c: '4242',
      billing_name__c: 'Donor Example',
      billing_email__c: 'donor@example.com',
      billing_phone__c: '+15555550123',
      statement_descriptor__c: 'REFUGE INTL',
      received_at__c: new Date(1_700_000_000_000).toISOString(),
    });
  });

  it('maps memo metadata into the Salesforce transaction DTO', () => {
    const dto = mapStripeToTransaction({
      paymentIntent: buildPaymentIntent({
        memo__c: 'Smoke test | [source_test_tag:run-42]',
      }) as any,
      charge: buildCharge() as any,
      balanceTransaction: buildBalanceTransaction() as any,
    });

    expect(dto.memo__c).toBe('Smoke test | [source_test_tag:run-42]');
  });
});
