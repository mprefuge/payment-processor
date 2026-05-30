import { describe, it, expect, vi } from 'vitest';
import { StripeWebhookProcessor } from '../src/handlers/webhook/StripeWebhookProcessor';
import type { StripeWebhookDependencies } from '../src/stripe/types';

const makeLimitError = (): Error => {
  const err = new Error('REQUEST_LIMIT_EXCEEDED: exceeded daily API limit');
  (err as any).errorCode = 'REQUEST_LIMIT_EXCEEDED';
  return err;
};

const makeTransientError = (): Error => {
  const err = new Error('Row locking failed: UNABLE_TO_LOCK_ROW');
  (err as any).errorCode = 'UNABLE_TO_LOCK_ROW';
  return err;
};

const makeBaseEvent = (overrides: Record<string, unknown> = {}): any => ({
  id: 'evt_limit_test',
  object: 'event',
  api_version: '2023-10-16',
  created: Math.floor(Date.now() / 1000),
  type: 'payment_intent.succeeded',
  data: { object: { id: 'pi_test' } },
  livemode: false,
  pending_webhooks: 0,
  request: null,
  ...overrides,
});

const makeDeps = (): StripeWebhookDependencies => ({
  stripe: {
    verifyEvent: vi.fn(),
    getClient: vi.fn(),
  },
  idempotencyStore: {
    isProcessed: vi.fn().mockResolvedValue(false),
    markProcessed: vi.fn().mockResolvedValue(undefined),
    withLock: vi.fn().mockImplementation((_key: string, fn: () => Promise<unknown>) => fn()),
    flush: vi.fn().mockResolvedValue(undefined),
  },
  getSalesforceSvc: vi.fn().mockResolvedValue({}),
  getCrmSvc: vi.fn().mockResolvedValue({}),
  accounting: {
    postChargeToQbo: vi.fn(),
    postRefundToQbo: vi.fn(),
    postDisputeToQbo: vi.fn(),
    postDisputeReversalToQbo: vi.fn(),
    refundReceipts: { upsertRefundReceipt: vi.fn() },
    payouts: { upsertDeposit: vi.fn(), markDepositForReview: vi.fn() },
  },
});

const baseRequest = () => ({
  headers: { 'stripe-signature': 'sig_test' },
  rawBody: '{}',
  body: {},
});

const makeContext = (): any => ({
  bindingData: {},
  res: {},
});

describe('StripeWebhookProcessor — REQUEST_LIMIT_EXCEEDED handling', () => {
  it('returns HTTP 503 with Retry-After: 3600 when route() throws REQUEST_LIMIT_EXCEEDED', async () => {
    const deps = makeDeps();
    const processor = new StripeWebhookProcessor(deps);
    const event = makeBaseEvent();

    deps.stripe.verifyEvent = vi.fn().mockReturnValue(event);
    (processor as any).eventRouter = {
      route: vi.fn().mockRejectedValue(makeLimitError()),
    };

    const result = await processor.handle(baseRequest() as any, makeContext());

    expect(result.status).toBe(503);
    expect(result.headers['Retry-After']).toBe('3600');
    expect(result.jsonBody).toMatchObject({
      status: 'error',
      code: 'api_limit_exceeded',
      retryAfterSeconds: 3600,
    });
  });

  it('does NOT mark the event as processed when REQUEST_LIMIT_EXCEEDED occurs', async () => {
    const deps = makeDeps();
    const processor = new StripeWebhookProcessor(deps);
    const event = makeBaseEvent();

    deps.stripe.verifyEvent = vi.fn().mockReturnValue(event);
    (processor as any).eventRouter = {
      route: vi.fn().mockRejectedValue(makeLimitError()),
    };

    await processor.handle(baseRequest() as any, makeContext());

    expect(deps.idempotencyStore.markProcessed).not.toHaveBeenCalled();
  });

  it('returns HTTP 503 (without Retry-After) for non-limit transient errors', async () => {
    const deps = makeDeps();
    const processor = new StripeWebhookProcessor(deps);
    const event = makeBaseEvent();

    deps.stripe.verifyEvent = vi.fn().mockReturnValue(event);
    (processor as any).eventRouter = {
      route: vi.fn().mockRejectedValue(makeTransientError()),
    };

    const result = await processor.handle(baseRequest() as any, makeContext());

    expect(result.status).toBe(503);
    expect(result.headers?.['Retry-After']).toBeUndefined();
    expect(result.jsonBody).toMatchObject({ received: false, error: 'processing_error' });
  });

  it('returns HTTP 200 for duplicate events even when limit would have been hit', async () => {
    const deps = makeDeps();
    const processor = new StripeWebhookProcessor(deps);
    const event = makeBaseEvent();

    deps.stripe.verifyEvent = vi.fn().mockReturnValue(event);
    (deps.idempotencyStore.isProcessed as ReturnType<typeof vi.fn>).mockResolvedValue(true);

    const result = await processor.handle(baseRequest() as any, makeContext());

    expect(result.status).toBe(200);
    expect(result.jsonBody).toMatchObject({ duplicate: true });
  });

  it('includes event type in the apiLimitExceeded response body', async () => {
    const deps = makeDeps();
    const processor = new StripeWebhookProcessor(deps);
    const event = makeBaseEvent({ id: 'evt_lim2', type: 'charge.refunded' });

    deps.stripe.verifyEvent = vi.fn().mockReturnValue(event);
    (processor as any).eventRouter = {
      route: vi.fn().mockRejectedValue(makeLimitError()),
    };

    const result = await processor.handle(baseRequest() as any, makeContext());

    expect(result.jsonBody.eventType).toBe('charge.refunded');
  });
});
