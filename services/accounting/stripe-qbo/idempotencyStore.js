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
        this.pending = new Set();
        this.loaded = false;
        this.inFlight = null;
        this.dirty = false;
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
                await this._writePayload({});
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

    async _writePayload(payload) {
        await this.fs.mkdir(path.dirname(this.storagePath), { recursive: true });
        const serialized = JSON.stringify(payload, null, 2);
        await this.fs.writeFile(this.storagePath, serialized, 'utf8');
        return serialized;
    }

    _scheduleFlush() {
        if (this.inFlight) {
            return;
        }

        this.inFlight = this._doFlush()
            .catch(error => {
                this.logger.error('[Stripe→QBO] Failed to persist idempotency state', {
                    storagePath: this.storagePath,
                    error: error.message
                });
                throw error;
            })
            .finally(() => {
                this.inFlight = null;
                if (this.pending.size > 0) {
                    // New records arrived while flushing; immediately schedule the follow-up
                    this._scheduleFlush();
                } else {
                    this.dirty = false;
                }
            });
    }

    async _doFlush() {
        await this._ensureLoaded();

        while (this.pending.size > 0) {
            const payload = Object.fromEntries(this.records.entries());
            const pendingIds = Array.from(this.pending);
            this.pending.clear();

            try {
                await this._writePayload(payload);
            } catch (error) {
                // Restore pending IDs so callers can retry
                pendingIds.forEach(id => this.pending.add(id));
                this.dirty = true;
                throw error;
            }
        }
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
        this.pending.add(record.stripeId);
        this.dirty = true;
        this._scheduleFlush();

        return stored;
    }

    async flush(options = {}) {
        await this._ensureLoaded();

        if (this.pending.size === 0 && !this.inFlight) {
            return;
        }

        if (!this.inFlight) {
            this._scheduleFlush();
        }

        const timeoutMs = options.timeoutMs;
        if (timeoutMs && Number.isFinite(timeoutMs) && timeoutMs > 0) {
            await Promise.race([
                this.inFlight,
                new Promise((_, reject) => setTimeout(() => {
                    const error = new Error('Timed out while flushing idempotency store');
                    error.code = 'FLUSH_TIMEOUT';
                    reject(error);
                }, timeoutMs))
            ]);
        } else if (this.inFlight) {
            await this.inFlight;
        }
    }
}

module.exports = {
    ProcessedStripeStore
};
