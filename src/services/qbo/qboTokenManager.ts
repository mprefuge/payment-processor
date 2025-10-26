import { createPersistentStorageClients } from '../idempotency/storage/persistentStoreFactory';
import env from '../../config/env';
import { logger } from '../../lib/logger';

interface TokenData {
  accessToken: string;
  refreshToken: string;
  accessTokenExpiresAt: number; // timestamp in milliseconds
  refreshTokenExpiresAt: number; // timestamp in milliseconds
}

interface RefreshTokenResult {
  accessToken: string;
  refreshToken?: string;
}

const ACCESS_TOKEN_LIFETIME_MS = 60 * 60 * 1000; // 1 hour
const REFRESH_TOKEN_LIFETIME_MS = 100 * 24 * 60 * 60 * 1000; // 100 days

class QBOTokenManager {
  private store: any;
  private initialized = false;

  async initialize(): Promise<void> {
    if (this.initialized) return;

    const clients = createPersistentStorageClients('qbo-tokens');
    this.store = clients.tokenStore;
    this.initialized = true;
  }

  private async ensureInitialized(): Promise<void> {
    await this.initialize();
  }

  async getTokens(): Promise<TokenData | null> {
    // Don't use stored tokens in test environments
    if (process.env.NODE_ENV === 'test') {
      return null;
    }
    await this.ensureInitialized();
    const data = await this.store.get('tokens');
    return data as TokenData | null;
  }

  async setTokens(accessToken: string, refreshToken: string): Promise<void> {
    await this.ensureInitialized();

    const now = Date.now();
    const tokenData: TokenData = {
      accessToken,
      refreshToken,
      accessTokenExpiresAt: now + ACCESS_TOKEN_LIFETIME_MS,
      refreshTokenExpiresAt: now + REFRESH_TOKEN_LIFETIME_MS,
    };

    // Don't persist in test environments to avoid test interference
    if (process.env.NODE_ENV !== 'test') {
      await this.store.set('tokens', tokenData);
    }
    logger.info('QBO tokens updated and persisted');
  }

  async isAccessTokenExpired(): Promise<boolean> {
    const tokens = await this.getTokens();
    if (!tokens) return false; // Assume env var token is valid
    return Date.now() >= tokens.accessTokenExpiresAt;
  }

  async isRefreshTokenExpired(): Promise<boolean> {
    const tokens = await this.getTokens();
    if (!tokens) {
      // If no stored tokens, assume we're using env vars and they're valid
      return false;
    }
    return Date.now() >= tokens.refreshTokenExpiresAt;
  }

  async shouldRefreshProactively(): Promise<boolean> {
    const tokens = await this.getTokens();
    if (!tokens) return false; // Don't refresh if using env vars
    // Refresh if access token expires within next 5 minutes
    const refreshThreshold = 5 * 60 * 1000; // 5 minutes
    return Date.now() + refreshThreshold >= tokens.accessTokenExpiresAt;
  }

  async refreshTokens(fetcher: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>): Promise<RefreshTokenResult> {
    const tokens = await this.getTokens();
    let refreshToken = tokens?.refreshToken;

    // Fallback to environment variable
    if (!refreshToken) {
      refreshToken = process.env.QBO_REFRESH_TOKEN;
    }

    if (!refreshToken) {
      throw new Error('No refresh token available for QBO token refresh');
    }

    if (await this.isRefreshTokenExpired()) {
      throw new Error('QBO refresh token has expired. Manual re-authentication required.');
    }

    const { clientId, clientSecret } = env.quickBooks;
    if (!clientId || !clientSecret) {
      throw new Error('QBO OAuth client ID and client secret must be configured');
    }

    const basicAuth = Buffer.from(`${clientId}:${clientSecret}`, 'utf8').toString('base64');
    const params = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    });

    const response = await fetcher('https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer', {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: `Basic ${basicAuth}`,
      },
      body: params.toString(),
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => undefined);
      throw new Error(
        `Failed to refresh QuickBooks access token (status ${response.status}): ${
          errorText ?? response.statusText
        }`
      );
    }

    const data = await response.json().catch(() => ({}));
    const newAccessToken = data.access_token?.trim();
    const newRefreshToken = data.refresh_token?.trim();

    if (!newAccessToken) {
      throw new Error('QBO token refresh response did not include an access_token');
    }

    // Update stored tokens
    await this.setTokens(newAccessToken, newRefreshToken || refreshToken);

    // Update environment variables for backward compatibility
    process.env.QBO_ACCESS_TOKEN = newAccessToken;
    if (newRefreshToken) {
      process.env.QBO_REFRESH_TOKEN = newRefreshToken;
      env.quickBooks.refreshToken = newRefreshToken;
    }

    logger.info('QBO tokens refreshed successfully');
    return { accessToken: newAccessToken, refreshToken: newRefreshToken };
  }

  async clearTokens(): Promise<void> {
    await this.ensureInitialized();
    await this.store.set('tokens', null);
  }

  async getValidAccessToken(fetcher: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>): Promise<string> {
    // First check if we have a valid access token
    if (!(await this.isAccessTokenExpired())) {
      const tokens = await this.getTokens();
      if (tokens?.accessToken) {
        return tokens.accessToken;
      }
    }

    // If no valid token, try to refresh
    const refreshResult = await this.refreshTokens(fetcher);
    return refreshResult.accessToken;
  }
}

// Singleton instance
const tokenManager = new QBOTokenManager();

export default tokenManager;