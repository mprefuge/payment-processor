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
  private readonly clientCache = new Map<string, Stripe>();

  private resolveClientConfig(options?: StripeClientOptions): Stripe.StripeConfig {
    return {
      apiVersion: options?.apiVersion || STRIPE_API_VERSION,
      timeout: options?.timeout ?? DEFAULT_STRIPE_TIMEOUT_MS,
      maxNetworkRetries: options?.maxNetworkRetries ?? DEFAULT_STRIPE_MAX_NETWORK_RETRIES,
    };
  }

  private buildCacheKey(clientScope: string, options?: StripeClientOptions): string {
    const config = this.resolveClientConfig(options);
    return `${clientScope}:api=${config.apiVersion}:timeout=${config.timeout}:retries=${config.maxNetworkRetries}`;
  }

  private getOrCreateCachedClient(cacheKey: string, createClient: () => Stripe): Stripe {
    const cachedClient = this.clientCache.get(cacheKey);
    if (cachedClient) {
      return cachedClient;
    }

    const client = createClient();
    this.clientCache.set(cacheKey, client);
    return client;
  }

  getClient(livemode: boolean, options?: StripeClientOptions): Stripe {
    const cacheKey = this.buildCacheKey(`mode=${livemode}`, options);
    return this.getOrCreateCachedClient(
      cacheKey,
      () => new Stripe(this.resolveSecretKey(livemode), this.resolveClientConfig(options))
    );
  }

  getDefaultClient(options?: StripeClientOptions): Stripe {
    const cacheKey = this.buildCacheKey('default', options);
    return this.getOrCreateCachedClient(
      cacheKey,
      () => new Stripe(env.stripe.secret, this.resolveClientConfig(options))
    );
  }

  createClient(secretKey: string, options?: StripeClientOptions): Stripe {
    return new Stripe(secretKey, this.resolveClientConfig(options));
  }

  clearCache(): void {
    this.clientCache.clear();
  }

  private resolveSecretKey(livemode: boolean): string {
    if (livemode) {
      return process.env.STRIPE_LIVE_SECRET_KEY || env.stripe.secret;
    }

    return process.env.STRIPE_TEST_SECRET_KEY || env.stripe.secret;
  }
}

export const stripeClientFactory = new StripeClientFactory();
export { StripeClientFactory };
