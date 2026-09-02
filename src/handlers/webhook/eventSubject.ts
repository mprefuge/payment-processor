import type Stripe from 'stripe';

import { normalizeStripeId } from '../../stripe/utils';

/**
 * The Stripe object an event is *about*, as a lock key.
 *
 * The webhook's only lock is keyed on the EVENT id, which serialises redeliveries of one
 * event and nothing else. But several different events each write the same
 * Transaction__c: `payment_intent.succeeded`, `charge.succeeded`, `charge.updated` and
 * `checkout.session.completed` all resolve-then-write the row for one gift. Different
 * event ids mean different locks, so when Stripe delivers two of them together both read
 * "no existing row" and both insert.
 *
 * That is not theoretical: it produced three of the duplicate pairs found in this org --
 * $102.57, $26.12 and $25.85 -- each two rows for one charge, created in the same second
 * or one apart, each with exactly one copy posted to QuickBooks.
 *
 * Keying on the PAYMENT INTENT in preference to the charge is what makes the guard work:
 * `payment_intent.succeeded` carries a PaymentIntent while `charge.succeeded` carries a
 * Charge, and only the payment intent id is common to both. Falling back through charge,
 * session and object id keeps every other event type serialised on something stable.
 */
export const resolveEventSubjectKey = (event: Stripe.Event): string | null => {
  const object = event?.data?.object as Record<string, unknown> | undefined;
  if (!object || typeof object !== 'object') {
    return null;
  }

  const objectType = typeof object.object === 'string' ? object.object : null;

  // A PaymentIntent event: the intent itself is the subject.
  if (objectType === 'payment_intent' && typeof object.id === 'string') {
    return `stripe_subject_${object.id}`;
  }

  // Charge, checkout session and invoice events all name their payment intent, which is
  // the id a PaymentIntent event would use. Preferring it collapses them onto one lock.
  const paymentIntentId = normalizeStripeId(
    (object.payment_intent ?? null) as Parameters<typeof normalizeStripeId>[0]
  );
  if (paymentIntentId) {
    return `stripe_subject_${paymentIntentId}`;
  }

  // No payment intent (a subscription-mode checkout session, a payout, a refund without
  // one): fall back to the object's own id, which still serialises redelivery races
  // between events about that same object.
  if (typeof object.id === 'string' && object.id.trim().length > 0) {
    return `stripe_subject_${object.id.trim()}`;
  }

  return null;
};
