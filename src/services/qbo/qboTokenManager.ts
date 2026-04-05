import env from '../../config/env';
import { logger } from '../../lib/logger';
import { createTokenStore, TokenStore, Tokens } from './tokenStore';

interface TokenData {
  accessToken: string;
  refreshToken: string;
  accessTokenExpiresAt: number;
  refreshTokenExpiresAt: number;
}

interface RefreshTokenResult {
  accessToken: string;
  refreshToken?: string;
}

interface OAuthTokensResult {
  accessToken: string;
  refreshToken: string;
}

const ACCESS_TOKEN_LIFETIME_MS = 60 * 60 * 1000;
const REFRESH_TOKEN_LIFETIME_MS = 100 * 24 * 60 * 60 * 1000;
const ACCESS_TOKEN_REFRESH_LEAD_MS = 5 * 60 * 1000;
const MIN_REFRESH_RETRY_INTERVAL_MS = 5 * 60 * 1000;
const DEFAULT_AUTO_REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000;
const MIN_AUTO_REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000;
const MAX_REFRESH_TIMER_DELAY_MS = 7 * 24 * 60 * 60 * 1000;
const QBO_OAUTH_TOKEN_URL = 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer';

type OAuthFetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

class QBOTokenManager {
  private store: TokenStore | null = null;
  private initialized = false;
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;
  private autoRefreshInterval: ReturnType<typeof setInterval> | null = null;
  private lastRefreshAt: number | null = null;

  private updateRuntimeTokens(accessToken: string, refreshToken?: string): void {
    process.env.QBO_ACCESS_TOKEN = accessToken;

    if (refreshToken) {
      process.env.QBO_REFRESH_TOKEN = refreshToken;
      env.quickBooks.refreshToken = refreshToken;
    }
  }

  private resolveFetcher(fetcher?: OAuthFetcher): OAuthFetcher {
    const runtimeFetcher = fetcher ?? (typeof fetch !== 'undefined' ? fetch : undefined);
    if (!runtimeFetcher) {
      throw new Error('Fetch API is not available to perform QBO token refresh');
    }
    return runtimeFetcher;
  }

  private getOAuthClientCredentials(): { clientId: string; clientSecret: string } {
    const { clientId, clientSecret } = env.quickBooks;
    if (!clientId || !clientSecret) {
      throw new Error('QBO OAuth client ID and client secret must be configured');
    }
    return { clientId, clientSecret };
  }

  private buildBasicAuthHeader(): string {
    const { clientId, clientSecret } = this.getOAuthClientCredentials();
    return Buffer.from(`${clientId}:${clientSecret}`, 'utf8').toString('base64');
  }

  private clearRefreshTimer(): void {
    if (!this.refreshTimer) return;
    clearTimeout(this.refreshTimer as any);
    this.refreshTimer = null;
  }

  private clearAutoRefreshInterval(): void {
    if (!this.autoRefreshInterval) return;
    clearInterval(this.autoRefreshInterval as any);
    this.autoRefreshInterval = null;
  }

  private logWarn(message: string, error: unknown): void {
    logger.warn(`${message}: ${error instanceof Error ? error.message : String(error)}`);
  }

  private async readJsonBody(response: Response): Promise<any> {
    return await response.json().catch(() => ({}));
  }

  private async readTextBody(response: Response): Promise<string | undefined> {
    return await response.text().catch(() => undefined);
  }

  private getTrimmedToken(value: unknown): string | undefined {
    return typeof value === 'string' && value.trim() ? value.trim() : undefined;
  }

  private parseTokenPayload(
    data: any,
    options: { requireRefreshToken: boolean; missingMessage: string }
  ): { accessToken: string; refreshToken?: string } {
    const accessToken = this.getTrimmedToken(data?.access_token);
    const refreshToken = this.getTrimmedToken(data?.refresh_token);

    if (!accessToken || (options.requireRefreshToken && !refreshToken)) {
      throw new Error(options.missingMessage);
    }

    return { accessToken, refreshToken };
  }

  private async postTokenRequest(
    fetcher: OAuthFetcher,
    params: URLSearchParams
  ): Promise<Response> {
    return await fetcher(QBO_OAUTH_TOKEN_URL, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: `Basic ${this.buildBasicAuthHeader()}`,
      },
      body: params.toString(),
    });
  }

  private async getRefreshToken(): Promise<string | undefined> {
    const tokens = await this.getTokens();
    return tokens?.refreshToken ?? process.env.QBO_REFRESH_TOKEN;
  }

  private scheduleProactiveRefreshSafely(accessTokenExpiresAt: number): void {
    void this.scheduleProactiveRefresh(accessTokenExpiresAt).catch(() => undefined);
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;

    this.store = createTokenStore();
    this.initialized = true;

    try {
      const tokens = (await this.store.get('tokens')) as Tokens | null;
      if (tokens && typeof tokens.accessTokenExpiresAt === 'string') {
        const expiresAt = Number(tokens.accessTokenExpiresAt);
        this.scheduleProactiveRefreshSafely(expiresAt);
      }
    } catch {
      // ignore initialization read failures
    }
  }

  private async ensureInitialized(): Promise<void> {
    await this.initialize();
  }

  async getTokens(): Promise<TokenData | null> {
    if (process.env.NODE_ENV === 'test') {
      return null;
    }

    await this.ensureInitialized();
    const data = await this.store!.get('tokens');
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

    if (process.env.NODE_ENV !== 'test') {
      await this.store!.set('tokens', tokenData);
    }

    this.updateRuntimeTokens(accessToken, refreshToken);

    this.scheduleProactiveRefreshSafely(tokenData.accessTokenExpiresAt);

    logger.info('QBO tokens updated and persisted');
  }

  private async storeAndActivateTokens(accessToken: string, refreshToken: string): Promise<void> {
    await this.setTokens(accessToken, refreshToken);
    this.updateRuntimeTokens(accessToken, refreshToken);
  }

  private hasMetRefreshInterval(intervalMs: number): boolean {
    return !this.lastRefreshAt || Date.now() - this.lastRefreshAt >= intervalMs;
  }

  private async isTokenExpiredAt(
    expiresAt: keyof Pick<TokenData, 'accessTokenExpiresAt' | 'refreshTokenExpiresAt'>,
    leadMs: number = 0
  ): Promise<boolean> {
    const tokens = await this.getTokens();
    if (!tokens) return false;
    return Date.now() + leadMs >= tokens[expiresAt];
  }

  private async throwRefreshTokenRequestError(response: Response): Promise<never> {
    const rawText = await this.readTextBody(response);
    let parsed: any = undefined;

    try {
      parsed = rawText ? JSON.parse(rawText) : undefined;
    } catch {
      // ignore parse errors
    }

    const isInvalidGrant =
      response.status === 400 &&
      ((parsed && parsed.error === 'invalid_grant') ||
        (typeof rawText === 'string' && /invalid_grant/i.test(rawText)) ||
        (typeof rawText === 'string' && /incorrect or invalid refresh token/i.test(rawText)));

    if (isInvalidGrant) {
      try {
        await this.clearTokens();
        logger.warn('QBO refresh token appears invalid or revoked; cleared stored tokens');
      } catch (error) {
        this.logWarn('Failed to clear stored QBO tokens after invalid refresh token', error);
      }

      throw new Error(
        'QBO refresh token is invalid or revoked. Manual re-authentication is required (run "npm run setup:qbo").'
      );
    }

    throw new Error(
      `Failed to refresh QuickBooks access token (status ${response.status}): ${rawText ?? response.statusText}`
    );
  }

  private async refreshTokensWithLoggedWarning(
    warningMessage: string,
    fetcher?: OAuthFetcher
  ): Promise<RefreshTokenResult | null> {
    try {
      return await this.refreshTokens(fetcher);
    } catch (error) {
      this.logWarn(warningMessage, error);
      return null;
    }
  }

  async isAccessTokenExpired(): Promise<boolean> {
    return await this.isTokenExpiredAt('accessTokenExpiresAt');
  }

  async isRefreshTokenExpired(): Promise<boolean> {
    return await this.isTokenExpiredAt('refreshTokenExpiresAt');
  }

  async shouldRefreshProactively(): Promise<boolean> {
    return await this.isTokenExpiredAt('accessTokenExpiresAt', ACCESS_TOKEN_REFRESH_LEAD_MS);
  }

  async refreshTokens(fetcher?: OAuthFetcher): Promise<RefreshTokenResult> {
    const usedFetcher = this.resolveFetcher(fetcher);

    this.lastRefreshAt = Date.now();
    const refreshToken = await this.getRefreshToken();

    if (!refreshToken) {
      throw new Error(
        'No refresh token available for QBO token refresh. ' +
          'Please run "npm run setup:qbo" to set up QuickBooks Online integration.'
      );
    }

    if (await this.isRefreshTokenExpired()) {
      throw new Error('QBO refresh token has expired. Manual re-authentication required.');
    }

    const response = await this.postTokenRequest(
      usedFetcher,
      new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
      })
    );

    if (!response.ok) {
      await this.throwRefreshTokenRequestError(response);
    }

    const payload = this.parseTokenPayload(await this.readJsonBody(response), {
      requireRefreshToken: false,
      missingMessage: 'QBO token refresh response did not include an access_token',
    });

    await this.storeAndActivateTokens(payload.accessToken, payload.refreshToken || refreshToken);

    logger.info('QBO tokens refreshed successfully');
    return payload;
  }

  async clearTokens(): Promise<void> {
    await this.ensureInitialized();
    await this.store!.set('tokens', null);
    this.clearRefreshTimer();
    this.clearAutoRefreshInterval();
    this.lastRefreshAt = null;
  }

  async scheduleProactiveRefresh(accessTokenExpiresAt: number): Promise<void> {
    this.clearRefreshTimer();

    const refreshAt = accessTokenExpiresAt - ACCESS_TOKEN_REFRESH_LEAD_MS;
    const now = Date.now();

    if (refreshAt <= now) {
      if (this.hasMetRefreshInterval(MIN_REFRESH_RETRY_INTERVAL_MS)) {
        void this.refreshTokensWithLoggedWarning('Proactive immediate token refresh failed');
      }
      return;
    }

    const delay = Math.max(refreshAt - now, 0);
    const safeDelay = Math.min(delay, MAX_REFRESH_TIMER_DELAY_MS);

    this.refreshTimer = setTimeout(() => {
      void this.refreshTokensWithLoggedWarning('Proactive scheduled token refresh failed');
    }, safeDelay);
  }

  private async runAutoRefreshCycle(): Promise<void> {
    if (!(await this.isSetupComplete())) return;

    if (await this.isRefreshTokenExpired()) {
      logger.warn(
        'QBO refresh token expired; clearing stored tokens and requiring manual re-authentication'
      );
      await this.clearTokens();
      return;
    }

    if (!this.hasMetRefreshInterval(MIN_AUTO_REFRESH_INTERVAL_MS)) {
      return;
    }

    await this.refreshTokensWithLoggedWarning('Auto QBO token refresh failed');
  }

  async startAutoRefresh(intervalMs: number = DEFAULT_AUTO_REFRESH_INTERVAL_MS): Promise<void> {
    await this.initialize();
    this.clearAutoRefreshInterval();

    this.autoRefreshInterval = setInterval(async () => {
      try {
        await this.runAutoRefreshCycle();
      } catch (error) {
        this.logWarn('QBO auto-refresh task encountered an error', error);
      }
    }, intervalMs);
  }

  stopAutoRefresh(): void {
    this.clearAutoRefreshInterval();
  }

  private async resolveCurrentAccessToken(fetcher: OAuthFetcher): Promise<string | null> {
    if (await this.isAccessTokenExpired()) {
      return null;
    }

    const tokens = await this.getTokens();
    if (tokens?.accessToken) {
      if (await this.shouldRefreshProactively()) {
        const refreshed = await this.refreshTokensWithLoggedWarning(
          'Proactive QBO token refresh failed',
          fetcher
        );
        if (refreshed) {
          return refreshed.accessToken;
        }

        return tokens.accessToken;
      }

      return tokens.accessToken;
    }

    return process.env.QBO_ACCESS_TOKEN ?? null;
  }

  async getValidAccessToken(fetcher: OAuthFetcher): Promise<string> {
    const currentToken = await this.resolveCurrentAccessToken(fetcher);
    if (currentToken) {
      return currentToken;
    }

    const refreshResult = await this.refreshTokens(fetcher);
    return refreshResult.accessToken;
  }

  async isSetupComplete(): Promise<boolean> {
    const tokens = await this.getTokens();
    const hasStoredTokens = Boolean(tokens?.refreshToken && !(await this.isRefreshTokenExpired()));
    const hasEnvToken = process.env.QBO_REFRESH_TOKEN;
    return Boolean(hasStoredTokens || hasEnvToken);
  }

  generateAuthorizationUrl(redirectUri: string, state?: string): string {
    const { clientId } = env.quickBooks;
    if (!clientId) {
      throw new Error('QBO OAuth client ID must be configured');
    }

    const baseUrl = 'https://appcenter.intuit.com/connect/oauth2';
    const params = new URLSearchParams({
      client_id: clientId,
      response_type: 'code',
      scope: 'com.intuit.quickbooks.accounting',
      redirect_uri: redirectUri,
      state: state || 'qbo_setup',
    });

    return `${baseUrl}?${params.toString()}`;
  }

  async exchangeCodeForTokens(
    code: string,
    redirectUri: string,
    fetcher: OAuthFetcher
  ): Promise<OAuthTokensResult> {
    const response = await this.postTokenRequest(
      fetcher,
      new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri,
      })
    );

    if (!response.ok) {
      const errorText = await this.readTextBody(response);
      throw new Error(
        `Failed to exchange authorization code for tokens (status ${response.status}): ${
          errorText ?? response.statusText
        }`
      );
    }

    const payload = this.parseTokenPayload(await this.readJsonBody(response), {
      requireRefreshToken: true,
      missingMessage: 'QBO token exchange response did not include required tokens',
    }) as OAuthTokensResult;

    await this.storeAndActivateTokens(payload.accessToken, payload.refreshToken);

    logger.info('QBO tokens obtained and stored via OAuth flow');
    return payload;
  }
}

const tokenManager = new QBOTokenManager();

export default tokenManager;
