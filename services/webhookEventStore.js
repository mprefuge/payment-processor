/**
 * Webhook Event Store
 * 
 * Stores and tracks Stripe webhook events for idempotency and processing state
 * 
 * ⚠️ PRODUCTION WARNING: This implementation uses in-memory storage which will be
 * lost on application restart. For production use, replace with persistent storage:
 * - Database (SQL or NoSQL) for permanent audit trail
 * - Redis for distributed caching with TTL
 * - Azure Table Storage or Cosmos DB
 */

class WebhookEventStore {
    constructor() {
        // WARNING: In-memory storage - not suitable for production at scale
        this.events = new Map(); // event.id -> event data
        this.logger = console;
        
        if (process.env.NODE_ENV === 'production' && !process.env.SUPPRESS_WEBHOOK_STORE_WARNING) {
            this.logger.warn('⚠️ WebhookEventStore using in-memory storage. Use database for production.');
        }
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

        this.events.set(event.id, record);
        this.logger.log(`[WebhookEventStore] Recorded event: ${event.id} (${event.type})`);
        
        return record;
    }

    /**
     * Check if event has been processed (dedupe check)
     * @param {string} eventId - Stripe event ID
     * @returns {boolean} True if event exists
     */
    async hasEvent(eventId) {
        return this.events.has(eventId);
    }

    /**
     * Get event record
     * @param {string} eventId - Stripe event ID
     * @returns {Object|null} Event record or null
     */
    async getEvent(eventId) {
        return this.events.get(eventId) || null;
    }

    /**
     * Update event status
     * @param {string} eventId - Stripe event ID
     * @param {string} status - New status ('processing', 'completed', 'failed', 'needs_review')
     * @param {Object} metadata - Additional metadata
     * @returns {Object} Updated event record
     */
    async updateEventStatus(eventId, status, metadata = {}) {
        const event = this.events.get(eventId);
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

        this.events.set(eventId, event);
        this.logger.log(`[WebhookEventStore] Updated event ${eventId} to status: ${status}`);
        
        return event;
    }

    /**
     * Get events by status
     * @param {string} status - Status to filter by
     * @returns {Array<Object>} Matching events
     */
    async getEventsByStatus(status) {
        return Array.from(this.events.values()).filter(e => e.status === status);
    }

    /**
     * Get events by payout ID
     * @param {string} payoutId - Payout ID
     * @returns {Array<Object>} Matching events
     */
    async getEventsByPayoutId(payoutId) {
        return Array.from(this.events.values()).filter(e => e.payoutId === payoutId);
    }

    /**
     * Clean up old events (optional TTL implementation)
     * @param {number} maxAgeMs - Maximum age in milliseconds
     * @returns {number} Number of events removed
     */
    async cleanupOldEvents(maxAgeMs = 30 * 24 * 60 * 60 * 1000) { // 30 days default
        const cutoff = Date.now() - maxAgeMs;
        let removed = 0;

        for (const [eventId, event] of this.events.entries()) {
            const eventTime = new Date(event.receivedAt).getTime();
            if (eventTime < cutoff) {
                this.events.delete(eventId);
                removed++;
            }
        }

        if (removed > 0) {
            this.logger.log(`[WebhookEventStore] Cleaned up ${removed} old events`);
        }

        return removed;
    }
}

module.exports = WebhookEventStore;
