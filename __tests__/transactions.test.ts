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

  it('derives subscription identifier from the payment intent when provided', () => {
    const paymentIntent = {
      ...buildPaymentIntent(),
      subscription: 'sub_456',
    };

    const dto = mapStripeToTransaction({
      paymentIntent: paymentIntent as any,
      charge: buildCharge() as any,
      balanceTransaction: buildBalanceTransaction() as any,
    });

    expect(dto.stripe_subscription_id__c).toBe('sub_456');
  });
});
