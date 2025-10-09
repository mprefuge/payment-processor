import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { createContext } = require('./testUtils');

describe('payoutSyncTrigger', () => {
    let handler;
    let internals;

    beforeEach(() => {
        vi.resetModules();
        handler = require('../payoutSyncTrigger');
        internals = handler.__internals;
    });

    afterEach(() => {
        if (internals?.resetDependencies) {
            internals.resetDependencies();
        }
        handler = undefined;
        internals = undefined;
        vi.restoreAllMocks();
    });

    it('completes without throwing when no payouts are available', async () => {
        const syncLedger = {
            getSync: vi.fn().mockResolvedValue(null)
        };

        internals.setDependencies({ syncLedger });

        const { context } = createContext({ bindingData: { payoutId: 'po_missing' } });
        const req = { method: 'GET', query: {} };

        await handler(context, req);

        expect(context.res.status).toBe(404);
        expect(syncLedger.getSync).toHaveBeenCalledWith('default', 'po_missing');
    });
});
