/**
 * Centralized Stripe Client Factory
 * 
 * Single responsibility: Create and manage Stripe client instances
 * Ensures consistent configuration across all handlers
 */

import Stripe from 'stripe';
import env from '../config/env';

const STRIPE_API_VERSION: Stripe.LatestApiVersion = '2023-10-16';

interface StripeClientOptions {
  timeout?: number;
  apiVersion?: Stripe.LatestApiVersion;
}

class StripeClientFactory {
  private clientCache = new Map<string, Stripe>();

  /**
   * Get a Stripe client for a specific mode (live or test)
   * Clients are cached to avoid recreating them
   */
  getClient(livemode: boolean, options?: StripeClientOptions): Stripe {
    const cacheKey = `${livemode}`;
    
    if (this.clientCache.has(cacheKey)) {
      return this.clientCache.get(cacheKey)!;
    }

    const secret = livemode
      ? process.env.STRIPE_LIVE_SECRET_KEY || env.stripe.secret
      : process.env.STRIPE_TEST_SECRET_KEY || env.stripe.secret;

    const client = new Stripe(secret, {
      apiVersion: options?.apiVersion || STRIPE_API_VERSION,
      timeout: options?.timeout,
    });

    this.clientCache.set(cacheKey, client);
    return client;
  }

  /**
   * Get the default Stripe client using env configuration
   */
  getDefaultClient(options?: StripeClientOptions): Stripe {
    const cacheKey = 'default';
    
    if (this.clientCache.has(cacheKey)) {
      return this.clientCache.get(cacheKey)!;
    }

    const client = new Stripe(env.stripe.secret, {
      apiVersion: options?.apiVersion || STRIPE_API_VERSION,
      timeout: options?.timeout,
    });

    this.clientCache.set(cacheKey, client);
    return client;
  }

  /**
   * Create a client with a custom secret key (not cached)
   * Useful for testing or special cases
   */
  createClient(secretKey: string, options?: StripeClientOptions): Stripe {
    return new Stripe(secretKey, {
      apiVersion: options?.apiVersion || STRIPE_API_VERSION,
      timeout: options?.timeout,
    });
  }

  /**
   * Clear the client cache (useful for testing)
   */
  clearCache(): void {
    this.clientCache.clear();
  }
}

// Singleton instance
export const stripeClientFactory = new StripeClientFactory();

// Export for testing
export { StripeClientFactory };
