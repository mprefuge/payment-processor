import Stripe from 'stripe';

export type TaggedStripeCustomer = Pick<Stripe.Customer, 'id' | 'email'>;

export const escapeStripeSearchValue = (value: string): string =>
  value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");

// Stripe's search API is eventually consistent and may lag by up to ~60s after
// a customer is created or updated. Retry with backoff so callers find the
// customer that was just created by the smoke transaction.
export const DEFAULT_STRIPE_SEARCH_RETRY_DELAYS_MS = [5000, 10000, 20000, 30000];

/**
 * Finds every Stripe customer carrying `metadata['source_test_tag'] = tag`.
 *
 * Retries on an empty result set to ride out search-index lag; callers that do
 * their own outer retry loop should pass a shorter `retryDelaysMs`.
 */
export const listStripeCustomersByTag = async (
  stripe: Stripe,
  tag: string,
  limit: number,
  retryDelaysMs: number[] = DEFAULT_STRIPE_SEARCH_RETRY_DELAYS_MS
): Promise<TaggedStripeCustomer[]> => {
  const searchPage = async (): Promise<TaggedStripeCustomer[]> => {
    const customers: Stripe.Customer[] = [];
    let page: string | undefined;

    while (customers.length < limit) {
      const response = await stripe.customers.search({
        query: `metadata['source_test_tag']:'${escapeStripeSearchValue(tag)}'`,
        limit: Math.min(100, limit - customers.length),
        ...(page ? { page } : {}),
      });

      customers.push(
        ...response.data.filter((customer): customer is Stripe.Customer => !('deleted' in customer))
      );

      if (!response.has_more || !response.next_page) {
        break;
      }

      page = response.next_page;
    }

    return customers.map((customer) => ({ id: customer.id, email: customer.email }));
  };

  let results = await searchPage();

  for (const delayMs of retryDelaysMs) {
    if (results.length > 0) {
      break;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
    results = await searchPage();
  }

  return results;
};
