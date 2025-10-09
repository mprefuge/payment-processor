import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { createContext } = require('./testUtils');

describe('healthCheck', () => {
    let handler;
    let internals;

    beforeEach(() => {
        vi.resetModules();
        handler = require('../healthCheck');
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

    it('returns a health report with component statuses', async () => {
        const storageClient = {
            set: vi.fn().mockResolvedValue(undefined),
            delete: vi.fn().mockResolvedValue(true)
        };

        internals.setDependencies({
            persistentStorageFactory: () => ({ syncLedgerStore: storageClient })
        });

        const { context } = createContext();
        const req = {};

        await handler(context, req);

        expect(context.res.status).toBe(200);
        expect(Array.isArray(context.res.body.connections)).toBe(true);
        expect(context.res.body.connections.length).toBeGreaterThan(0);
        context.res.body.connections.forEach(connection => {
            expect(connection).toHaveProperty('name');
            expect(connection).toHaveProperty('type');
            expect(connection).toHaveProperty('status');
        });

        expect(storageClient.set).toHaveBeenCalled();
        expect(storageClient.delete).toHaveBeenCalled();
    });
});
