/**
 * Centralized Stripe Client Factory
 *
 * Single responsibility: Create and manage Stripe client instances
 * Ensures consistent configuration across all handlers
 */

import Stripe from 'stripe';
import env from '../config/env';

const STRIPE_API_VERSION: Stripe.LatestApiVersion = '2023-10-16';
const DEFAULT_STRIPE_TIMEOUT_MS = 80_000;
const DEFAULT_STRIPE_MAX_NETWORK_RETRIES = 2;

interface StripeClientOptions {
  timeout?: number;
  apiVersion?: Stripe.LatestApiVersion;
  maxNetworkRetries?: number;
}

class StripeClientFactory {
  private clientCache = new Map<string, Stripe>();

  private resolveClientConfig(options?: StripeClientOptions): Stripe.StripeConfig {
    return {
      apiVersion: options?.apiVersion || STRIPE_API_VERSION,
      timeout: options?.timeout ?? DEFAULT_STRIPE_TIMEOUT_MS,
      maxNetworkRetries: options?.maxNetworkRetries ?? DEFAULT_STRIPE_MAX_NETWORK_RETRIES,
    };
  }

  private buildCacheKey(prefix: string, options?: StripeClientOptions): string {
    const config = this.resolveClientConfig(options);
    return `${prefix}:api=${config.apiVersion}:timeout=${config.timeout}:retries=${config.maxNetworkRetries}`;
  }

  /**
   * Get a Stripe client for a specific mode (live or test)
   * Clients are cached to avoid recreating them
   */
  getClient(livemode: boolean, options?: StripeClientOptions): Stripe {
    const cacheKey = this.buildCacheKey(`mode=${livemode}`, options);

    if (this.clientCache.has(cacheKey)) {
      return this.clientCache.get(cacheKey)!;
    }

    const secret = livemode
      ? process.env.STRIPE_LIVE_SECRET_KEY || env.stripe.secret
      : process.env.STRIPE_TEST_SECRET_KEY || env.stripe.secret;

    const client = new Stripe(secret, this.resolveClientConfig(options));

    this.clientCache.set(cacheKey, client);
    return client;
  }

  /**
   * Get the default Stripe client using env configuration
   */
  getDefaultClient(options?: StripeClientOptions): Stripe {
    const cacheKey = this.buildCacheKey('default', options);

    if (this.clientCache.has(cacheKey)) {
      return this.clientCache.get(cacheKey)!;
    }

    const client = new Stripe(env.stripe.secret, this.resolveClientConfig(options));

    this.clientCache.set(cacheKey, client);
    return client;
  }

  /**
   * Create a client with a custom secret key (not cached)
   * Useful for testing or special cases
   */
  createClient(secretKey: string, options?: StripeClientOptions): Stripe {
    return new Stripe(secretKey, this.resolveClientConfig(options));
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
