'use strict';

const fs = require('fs/promises');
const path = require('path');

class ProcessedStripeStore {
    constructor(options = {}) {
        this.storagePath = options.storagePath
            || process.env.STRIPE_QBO_STATE_PATH
            || path.join(process.cwd(), '.data', 'stripe-qbo-state.json');
        this.logger = options.logger || console;
        this.fs = options.fs || fs;
        this.records = new Map();
        this.loaded = false;
        this.persistPromise = null;
    }

    async _ensureLoaded() {
        if (this.loaded) {
            return;
        }

        try {
            const contents = await this.fs.readFile(this.storagePath, 'utf8');
            const parsed = JSON.parse(contents);
            Object.entries(parsed).forEach(([stripeId, record]) => {
                if (record && stripeId) {
                    this.records.set(stripeId, record);
                }
            });
            this.loaded = true;
        } catch (error) {
            if (error.code === 'ENOENT') {
                await this._persist();
                this.loaded = true;
                return;
            }

            this.logger.error('[Stripe→QBO] Failed to load idempotency store', {
                storagePath: this.storagePath,
                error: error.message
            });
            throw error;
        }
    }

    async _persist() {
        if (!this.persistPromise) {
            this.persistPromise = (async () => {
                const payload = Object.fromEntries(this.records.entries());
                await this.fs.mkdir(path.dirname(this.storagePath), { recursive: true });
                await this.fs.writeFile(this.storagePath, JSON.stringify(payload, null, 2), 'utf8');
                return payload;
            })()
                .finally(() => {
                    this.persistPromise = null;
                });
        }

        return this.persistPromise;
    }

    async alreadyProcessed(stripeId) {
        if (!stripeId) {
            return false;
        }

        await this._ensureLoaded();
        return this.records.has(stripeId);
    }

    async get(stripeId) {
        if (!stripeId) {
            return null;
        }

        await this._ensureLoaded();
        return this.records.get(stripeId) || null;
    }

    async recordProcessed(record) {
        if (!record || !record.stripeId) {
            throw new Error('recordProcessed requires a stripeId');
        }

        await this._ensureLoaded();

        const stored = {
            stripeId: record.stripeId,
            qboEntityId: record.qboEntityId || null,
            qboDocNumber: record.qboDocNumber || null,
            type: record.type || 'unknown',
            processedAt: new Date().toISOString(),
            memo: record.memo || null,
            payoutId: record.payoutId || null,
            metadata: record.metadata || {}
        };

        this.records.set(record.stripeId, stored);
        await this._persist();
        return stored;
    }
}

module.exports = {
    ProcessedStripeStore
};
