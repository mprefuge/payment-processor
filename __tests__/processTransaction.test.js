import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { createContext } = require('./testUtils');

describe('processTransaction', () => {
    let handler;
    let internals;

    beforeEach(() => {
        vi.resetModules();
        delete process.env.SECURE_DEBUG;
        handler = require('../processTransaction');
        internals = handler.__internals;
    });

    afterEach(() => {
        internals.resetStripeClientFactory();
        vi.restoreAllMocks();
    });

    it('returns checkout URL when valid request body is provided', async () => {
        const stripeMock = {
            customers: {
                search: vi.fn().mockResolvedValue({ data: [] }),
                create: vi.fn().mockResolvedValue({ id: 'cus_test' }),
                update: vi.fn().mockResolvedValue({ id: 'cus_test' })
            },
            checkout: {
                sessions: {
                    create: vi.fn().mockResolvedValue({
                        id: 'cs_test',
                        url: 'https://stripe.test/session'
                    })
                }
            }
        };

        internals.setStripeClientFactory(() => stripeMock);

        const { context } = createContext();
        const req = {
            body: {
                email: 'donor@example.com',
                firstname: 'Donor',
                lastname: 'Example',
                amount: 5000,
                frequency: 'onetime'
            }
        };

        await handler(context, req);

        expect(context.res.status).toBe(200);
        expect(context.res.headers['Content-Type']).toBe('application/json');
        const body = JSON.parse(context.res.body);
        expect(body).toEqual({
            success: true,
            checkoutUrl: 'https://stripe.test/session',
            sessionId: 'cs_test'
        });

        expect(stripeMock.customers.search).toHaveBeenCalled();
        expect(stripeMock.checkout.sessions.create).toHaveBeenCalled();
    });
});
