/**
 * Webhook Event Store
 * 
 * Stores and tracks Stripe webhook events for idempotency and processing state
 * 
 * Backed by a persistent key/value provider (file-based by default) so webhook
 * receipts are durable across process restarts and multiple instances. The
 * storage client can be swapped for Azure Cache for Redis, Cosmos DB, etc.
 */

const { createPersistentStorageClients } = require('./storage/persistentStoreFactory');

class WebhookEventStore {
    constructor({ storageClient, logger = console, namespace } = {}) {
        const storageNamespace = namespace || process.env.PERSISTENT_STORAGE_NAMESPACE || 'default';

        const clients = storageClient
            ? { webhookEventStore: storageClient }
            : createPersistentStorageClients(storageNamespace);

        this.storage = clients.webhookEventStore;
        if (!this.storage) {
            throw new Error('WebhookEventStore requires a storage client');
        }

        this.logger = logger;
    }

    /**
     * Record a webhook event
     * @param {Object} event - Stripe event object
     * @returns {Object} Stored event record
     */
    async recordEvent(event) {
        const record = {
            eventId: event.id,
            type: event.type,
            accountId: event.account || null,
            livemode: event.livemode || false,
            created: event.created,
            receivedAt: new Date().toISOString(),
            status: 'received',
            lastError: null,
            processedAt: null,
            attempts: 0,
            data: event.data?.object || null
        };

        await this.storage.set(event.id, record);
        this.logger.log(`[WebhookEventStore] Recorded event: ${event.id} (${event.type})`);

        return record;
    }

    /**
     * Check if event has been processed (dedupe check)
     * @param {string} eventId - Stripe event ID
     * @returns {boolean} True if event exists
     */
    async hasEvent(eventId) {
        return await this.storage.has(eventId);
    }

    /**
     * Get event record
     * @param {string} eventId - Stripe event ID
     * @returns {Object|null} Event record or null
     */
    async getEvent(eventId) {
        return await this.storage.get(eventId);
    }

    /**
     * Update event status
     * @param {string} eventId - Stripe event ID
     * @param {string} status - New status ('processing', 'completed', 'failed', 'needs_review')
     * @param {Object} metadata - Additional metadata
     * @returns {Object} Updated event record
     */
    async updateEventStatus(eventId, status, metadata = {}) {
        const event = await this.storage.get(eventId);
        if (!event) {
            throw new Error(`Event not found: ${eventId}`);
        }

        event.status = status;
        event.attempts = (event.attempts || 0) + 1;
        
        if (status === 'completed') {
            event.processedAt = new Date().toISOString();
        }
        
        if (metadata.error) {
            event.lastError = metadata.error;
        }
        
        if (metadata.payoutId) {
            event.payoutId = metadata.payoutId;
        }

        await this.storage.set(eventId, event);
        this.logger.log(`[WebhookEventStore] Updated event ${eventId} to status: ${status}`);

        return event;
    }

    /**
     * Get events by status
     * @param {string} status - Status to filter by
     * @returns {Array<Object>} Matching events
     */
    async getEventsByStatus(status) {
        const events = await this.storage.values();
        return events.filter(e => e.status === status);
    }

    /**
     * Get events by payout ID
     * @param {string} payoutId - Payout ID
     * @returns {Array<Object>} Matching events
     */
    async getEventsByPayoutId(payoutId) {
        const events = await this.storage.values();
        return events.filter(e => e.payoutId === payoutId);
    }

    /**
     * Clean up old events (optional TTL implementation)
     * @param {number} maxAgeMs - Maximum age in milliseconds
     * @returns {number} Number of events removed
     */
    async cleanupOldEvents(maxAgeMs = 30 * 24 * 60 * 60 * 1000) { // 30 days default
        const cutoff = Date.now() - maxAgeMs;
        let removed = 0;

        const entries = await this.storage.entries();
        for (const [eventId, event] of entries) {
            const eventTime = new Date(event.receivedAt).getTime();
            if (eventTime < cutoff) {
                await this.storage.delete(eventId);
                removed++;
            }
        }

        if (removed > 0) {
            this.logger.log(`[WebhookEventStore] Cleaned up ${removed} old events`);
        }

        return removed;
    }

    async clear() {
        await this.storage.clear();
        this.logger.log('[WebhookEventStore] Cleared all events');
    }
}

module.exports = WebhookEventStore;
