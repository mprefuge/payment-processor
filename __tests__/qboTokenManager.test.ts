import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import tokenManager from '../src/services/qbo/qboTokenManager';
import env from '../src/config/env';

describe('QBO Token Manager - invalid refresh handling', () => {
  beforeEach(async () => {
    // Ensure initialization and replace store with a mock
    await tokenManager.initialize();
    (tokenManager as any).store = {
      set: vi.fn().mockResolvedValue(undefined),
      get: vi.fn().mockResolvedValue({ refreshToken: 'old' }),
    };
    // Ensure env quickBooks client credentials are present
    env.quickBooks.clientId = 'test-client-id';
    env.quickBooks.clientSecret = 'test-client-secret';
    process.env.QBO_REFRESH_TOKEN = 'bad-refresh-token';
  });

  afterEach(() => {
    vi.resetAllMocks();
    vi.useRealTimers();
    delete process.env.QBO_REFRESH_TOKEN;
    delete process.env.QBO_ACCESS_TOKEN;
  });

  it('clears stored tokens and throws when introspection returns invalid_grant', async () => {
    const fetcher = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      text: async () =>
        '{"error":"invalid_grant","error_description":"Incorrect or invalid refresh token"}',
      json: async () => ({
        error: 'invalid_grant',
        error_description: 'Incorrect or invalid refresh token',
      }),
      statusText: 'Bad Request',
    } as any);

    const clearSpy = vi.spyOn(tokenManager, 'clearTokens');

    await expect(tokenManager.refreshTokens(fetcher as any)).rejects.toThrow(
      /refresh token is invalid|manual re-authentication required/i
    );

    expect(clearSpy).toHaveBeenCalled();
  });

  it('setTokens updates env var and schedules proactive refresh', async () => {
    await tokenManager.initialize();
    const scheduleSpy = vi.spyOn(tokenManager as any, 'scheduleProactiveRefresh');
    // call setTokens and ensure env var updated
    await tokenManager.setTokens('new-access', 'new-refresh');
    expect(process.env.QBO_ACCESS_TOKEN).toBe('new-access');
    expect(process.env.QBO_REFRESH_TOKEN).toBe('new-refresh');
    expect(scheduleSpy).toHaveBeenCalled();
  });

  it('startAutoRefresh sets interval', async () => {
    (tokenManager as any).store = {
      set: vi.fn().mockResolvedValue(undefined),
      get: vi.fn().mockResolvedValue({
        refreshToken: 'rt',
        accessTokenExpiresAt: Date.now() + 3600 * 1000 + 500,
      }),
    };
    await tokenManager.startAutoRefresh(1000);
    expect((tokenManager as any).autoRefreshInterval).not.toBeNull();
    tokenManager.stopAutoRefresh();
    expect((tokenManager as any).autoRefreshInterval).toBeNull();
  });

  it('clearTokens stops auto refresh', async () => {
    // Simulate an existing auto-refresh interval and ensure clearTokens cancels it
    (tokenManager as any).autoRefreshInterval = setInterval(() => {}, 1000) as any;
    await tokenManager.clearTokens();
    expect((tokenManager as any).autoRefreshInterval).toBeNull();
  });

  it('setTokens schedules refresh shortly before access-token expiry', async () => {
    vi.useFakeTimers();

    const refreshSpy = vi.spyOn(tokenManager, 'refreshTokens').mockResolvedValue({
      accessToken: 'refreshed-access',
      refreshToken: 'refreshed-refresh',
    } as any);

    await tokenManager.setTokens('new-access', 'new-refresh');

    expect(refreshSpy).not.toHaveBeenCalled();
    expect((tokenManager as any).refreshTimer).not.toBeNull();

    await vi.advanceTimersByTimeAsync(55 * 60 * 1000);

    expect(refreshSpy).toHaveBeenCalledTimes(1);
  });
});

describe('QBO Token Manager - distributed lock and invalid_grant recovery', () => {
  beforeEach(async () => {
    await tokenManager.initialize();
    env.quickBooks.clientId = 'test-client-id';
    env.quickBooks.clientSecret = 'test-client-secret';
    process.env.QBO_REFRESH_TOKEN = 'test-refresh-token';
    // Reset in-process coalescing state
    (tokenManager as any).refreshPromise = null;
  });

  afterEach(() => {
    vi.resetAllMocks();
    vi.useRealTimers();
    delete process.env.QBO_REFRESH_TOKEN;
    delete process.env.QBO_ACCESS_TOKEN;
    (tokenManager as any).refreshPromise = null;
  });

  it('waits for peer refresh and returns fresh tokens without making an HTTP call', async () => {
    vi.useFakeTimers();

    const freshTokens = {
      accessToken: 'peer-access-token',
      refreshToken: 'peer-refresh-token',
      accessTokenExpiresAt: Date.now() + 3600 * 1000,
    };

    (tokenManager as any).store = {
      get: vi.fn().mockResolvedValue(freshTokens),
      set: vi.fn().mockResolvedValue(undefined),
      acquireRefreshLock: vi.fn().mockResolvedValue({ acquired: false }),
      releaseRefreshLock: vi.fn().mockResolvedValue(undefined),
      isRefreshLockHeld: vi.fn().mockResolvedValue(true),
    };

    const fetcher = vi.fn();

    const promise = tokenManager.refreshTokens(fetcher as any);
    await vi.advanceTimersByTimeAsync(2001);
    const result = await promise;

    expect(fetcher).not.toHaveBeenCalled();
    expect(result.accessToken).toBe('peer-access-token');
    expect(result.refreshToken).toBe('peer-refresh-token');
  });

  it('recovers from invalid_grant when peer instance has fresh tokens in store', async () => {
    const freshTokens = {
      accessToken: 'peer-fresh-access',
      refreshToken: 'peer-fresh-refresh',
      accessTokenExpiresAt: Date.now() + 3600 * 1000,
    };

    (tokenManager as any).store = {
      get: vi.fn().mockResolvedValue(freshTokens),
      set: vi.fn().mockResolvedValue(undefined),
      // no acquireRefreshLock — distributed lock skipped, tests recovery path only
    };

    const fetcher = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      text: async () => '{"error":"invalid_grant","error_description":"token expired"}',
      json: async () => ({ error: 'invalid_grant' }),
      statusText: 'Bad Request',
    } as any);

    const clearSpy = vi.spyOn(tokenManager, 'clearTokens');

    const result = await tokenManager.refreshTokens(fetcher as any);

    expect(clearSpy).not.toHaveBeenCalled();
    expect(result.accessToken).toBe('peer-fresh-access');
    expect(result.refreshToken).toBe('peer-fresh-refresh');
  });

  it('clears tokens and throws on invalid_grant when store has only expired tokens', async () => {
    const expiredTokens = {
      accessToken: 'old-access',
      refreshToken: 'old-refresh',
      accessTokenExpiresAt: Date.now() - 1000, // already expired
    };

    (tokenManager as any).store = {
      get: vi.fn().mockResolvedValue(expiredTokens),
      set: vi.fn().mockResolvedValue(undefined),
    };

    const fetcher = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      text: async () => '{"error":"invalid_grant"}',
      json: async () => ({ error: 'invalid_grant' }),
      statusText: 'Bad Request',
    } as any);

    const clearSpy = vi.spyOn(tokenManager, 'clearTokens');

    await expect(tokenManager.refreshTokens(fetcher as any)).rejects.toThrow(
      /refresh token is invalid|manual re-authentication required/i
    );
    expect(clearSpy).toHaveBeenCalled();
  });

  it('releases distributed lock in finally block even when HTTP refresh call throws', async () => {
    const mockReleaseRefreshLock = vi.fn().mockResolvedValue(undefined);

    (tokenManager as any).store = {
      get: vi.fn().mockResolvedValue(null),
      set: vi.fn().mockResolvedValue(undefined),
      acquireRefreshLock: vi.fn().mockResolvedValue({ acquired: true, etag: 'test-etag-123' }),
      releaseRefreshLock: mockReleaseRefreshLock,
      isRefreshLockHeld: vi.fn().mockResolvedValue(false),
    };

    const fetcher = vi.fn().mockRejectedValue(new Error('Network failure'));

    await expect(tokenManager.refreshTokens(fetcher as any)).rejects.toThrow('Network failure');

    expect(mockReleaseRefreshLock).toHaveBeenCalledWith('test-etag-123');
  });

  it('in-process coalescing prevents duplicate HTTP calls within same instance', async () => {
    let resolveHttp!: (value: unknown) => void;
    const httpGate = new Promise((resolve) => {
      resolveHttp = resolve;
    });

    const fetcher = vi.fn().mockReturnValue(
      httpGate.then(() => ({
        ok: true,
        status: 200,
        json: async () => ({
          access_token: 'coalesced-access',
          refresh_token: 'coalesced-refresh',
        }),
        text: async () => '{}',
      }))
    );

    (tokenManager as any).store = {
      get: vi.fn().mockResolvedValue(null),
      set: vi.fn().mockResolvedValue(undefined),
    };

    const p1 = tokenManager.refreshTokens(fetcher as any);
    const p2 = tokenManager.refreshTokens(fetcher as any);

    resolveHttp(undefined);

    const [r1, r2] = await Promise.all([p1, p2]);

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(r1.accessToken).toBe('coalesced-access');
    expect(r2.accessToken).toBe('coalesced-access');
  });
});
