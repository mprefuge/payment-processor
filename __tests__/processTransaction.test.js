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
        internals.resetSalesforceConnectionFactory();
        vi.restoreAllMocks();
    });

    it('returns checkout session details when valid request body is provided', async () => {
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

        const upsertMock = vi.fn().mockResolvedValue({});
        const sobjectMock = vi.fn().mockReturnValue({
            upsert: upsertMock
        });
        internals.setSalesforceConnectionFactory(async () => ({
            sobject: sobjectMock
        }));

        const { context } = createContext();
        const req = {
            body: {
                amount: 5000,
                frequency: 'onetime',
                donor: {
                    email: 'donor@example.com',
                    firstname: 'Donor',
                    lastname: 'Example'
                },
                metadata: {
                    reference: 'ABC123'
                },
                attribution: {
                    source: 'newsletter'
                }
            }
        };

        await handler(context, req);

        expect(context.res.status).toBe(200);
        expect(context.res.headers['Content-Type']).toBe('application/json');
        const body = JSON.parse(context.res.body);
        expect(body).toEqual({
            url: 'https://stripe.test/session',
            id: 'cs_test'
        });

        expect(stripeMock.customers.search).toHaveBeenCalled();
        expect(stripeMock.checkout.sessions.create).toHaveBeenCalled();
        expect(sobjectMock).toHaveBeenCalledWith('Transactions__c');
        expect(upsertMock).toHaveBeenCalledWith(
            expect.objectContaining({
                transaction_type__c: 'charge',
                status__c: 'pending',
                stripe_checkout_session_id__c: 'cs_test',
                attribution_json__c: JSON.stringify({ source: 'newsletter' }),
                metadata_json__c: JSON.stringify({ reference: 'ABC123' })
            }),
            'stripe_checkout_session_id__c'
        );
    });

    it('returns 400 when required fields are missing', async () => {
        const { context } = createContext();
        const req = {
            body: {
                amount: 5000,
                frequency: 'onetime'
            }
        };

        await handler(context, req);

        expect(context.res.status).toBe(400);
        const response = JSON.parse(context.res.body);
        expect(response.error).toContain('Required');
    });

    it('supports legacy donor fields at the root of the payload', async () => {
        const stripeMock = {
            customers: {
                search: vi.fn().mockResolvedValue({ data: [] }),
                create: vi.fn().mockResolvedValue({ id: 'cus_legacy' }),
                update: vi.fn().mockResolvedValue({ id: 'cus_legacy' })
            },
            checkout: {
                sessions: {
                    create: vi.fn().mockResolvedValue({
                        id: 'cs_legacy',
                        url: 'https://stripe.test/legacy'
                    })
                }
            }
        };

        internals.setStripeClientFactory(() => stripeMock);
        internals.setSalesforceConnectionFactory(async () => ({
            sobject: () => ({
                upsert: vi.fn().mockResolvedValue({})
            })
        }));

        const { context } = createContext();
        const req = {
            body: {
                email: 'root@example.com',
                firstname: 'Root',
                lastname: 'Legacy',
                amount: 2500,
                frequency: 'onetime'
            }
        };

        await handler(context, req);

        expect(context.res.status).toBe(200);
        const body = JSON.parse(context.res.body);
        expect(body).toEqual({
            url: 'https://stripe.test/legacy',
            id: 'cs_legacy'
        });
    });
});
