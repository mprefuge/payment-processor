import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { createContext } = require('./testUtils');

describe('stripeWebhook', () => {
    const baseRequest = () => ({
        headers: {
            'stripe-signature': 'signature'
        },
        rawBody: '{}',
        body: {
            id: 'evt_test',
            type: 'payout.created',
            data: { object: { id: 'po_test' } },
            livemode: false
        }
    });

    let handler;
    let internals;

    beforeEach(() => {
        vi.resetModules();
        process.env.STRIPE_WEBHOOK_SECRET_TEST = 'whsec_test';
        handler = require('../stripeWebhook');
        internals = handler.__internals;
    });

    afterEach(() => {
        if (internals?.resetDependencies) {
            internals.resetDependencies();
        }
        handler = undefined;
        internals = undefined;
        delete process.env.STRIPE_WEBHOOK_SECRET_TEST;
        delete process.env.STRIPE_WEBHOOK_SECRET_LIVE;
        vi.restoreAllMocks();
    });

    it('returns 400 when signature verification fails', async () => {
        internals.setDependencies({
            stripeFactory: () => ({
                webhooks: {
                    constructEvent: () => {
                        throw new Error('Invalid signature');
                    }
                }
            })
        });

        const { context } = createContext();
        const req = baseRequest();

        await handler(context, req);

        expect(context.res.status).toBe(400);
    });

    it('returns 200 for a valid, non-idempotent payout event', async () => {
        const webhookEventStore = {
            hasEvent: vi.fn().mockResolvedValue(false),
            recordEvent: vi.fn().mockResolvedValue(),
            updateEventStatus: vi.fn().mockResolvedValue()
        };

        internals.setDependencies({
            stripeFactory: () => ({
                webhooks: {
                    constructEvent: () => ({})
                }
            }),
            webhookEventStore
        });

        const { context } = createContext();
        const req = baseRequest();

        await handler(context, req);

        expect(context.res.status).toBe(200);
        const body = JSON.parse(context.res.body);
        expect(body).toEqual({ received: true, eventType: 'payout.created' });
        expect(webhookEventStore.hasEvent).toHaveBeenCalledWith('evt_test');
        expect(webhookEventStore.recordEvent).toHaveBeenCalled();
    });
});
