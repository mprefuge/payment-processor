import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import tokenManager from '../src/services/qbo/qboTokenManager';
import env from '../src/config/env';

describe('QBO Token Manager - invalid refresh handling', () => {
  beforeEach(async () => {
    // Ensure initialization and replace store with a mock
    await tokenManager.initialize();
    (tokenManager as any).store = { set: vi.fn().mockResolvedValue(undefined), get: vi.fn().mockResolvedValue({ refreshToken: 'old' }) };
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
      text: async () => '{"error":"invalid_grant","error_description":"Incorrect or invalid refresh token"}',
      json: async () => ({ error: 'invalid_grant', error_description: 'Incorrect or invalid refresh token' }),
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
    (tokenManager as any).store = { set: vi.fn().mockResolvedValue(undefined), get: vi.fn().mockResolvedValue({ refreshToken: 'rt', accessTokenExpiresAt: Date.now() + 3600 * 1000 + 500 }) };
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

    const refreshSpy = vi
      .spyOn(tokenManager, 'refreshTokens')
      .mockResolvedValue({ accessToken: 'refreshed-access', refreshToken: 'refreshed-refresh' } as any);

    await tokenManager.setTokens('new-access', 'new-refresh');

    expect(refreshSpy).not.toHaveBeenCalled();
    expect((tokenManager as any).refreshTimer).not.toBeNull();

    await vi.advanceTimersByTimeAsync(55 * 60 * 1000);

    expect(refreshSpy).toHaveBeenCalledTimes(1);
  });
});