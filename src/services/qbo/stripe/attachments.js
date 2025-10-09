'use strict';

const { logger: rootLogger } = require('../../../lib/logger');

const MAX_ATTACHMENT_BYTES = 1.5 * 1024 * 1024; // 1.5MB guardrail

function serializeArtifact(artifact) {
    if (artifact === null || artifact === undefined) {
        return null;
    }

    if (typeof artifact === 'string') {
        return artifact.trim().length > 0 ? artifact.trim() : null;
    }

    try {
        return JSON.stringify(artifact, null, 2);
    } catch (error) {
        return null;
    }
}

function buildAttachment(artifact, index) {
    const serialized = serializeArtifact(artifact);
    if (!serialized) {
        return null;
    }

    const buffer = Buffer.from(serialized, 'utf8');
    if (buffer.length > MAX_ATTACHMENT_BYTES) {
        return null;
    }

    const suffix = typeof artifact === 'string' ? 'url' : 'json';
    const fileName = `stripe-artifact-${index + 1}.${suffix === 'url' ? 'txt' : 'json'}`;

    return {
        fileName,
        contentType: suffix === 'url' ? 'text/plain' : 'application/json',
        data: buffer.toString('base64')
    };
}

async function attachStripeArtifacts(quickbooksProvider, transactionId, artifacts = [], options = {}) {
    if (!transactionId) {
        throw new Error('A QuickBooks transaction ID is required to attach artifacts');
    }

    if (!quickbooksProvider || typeof quickbooksProvider.attachDocument !== 'function') {
        throw new Error('QuickBooks provider with attachDocument is required to attach artifacts');
    }

    const logger = options.logger || rootLogger;
    const attachments = artifacts
        .map((artifact, index) => buildAttachment(artifact, index))
        .filter(Boolean);

    const results = [];

    for (const attachment of attachments) {
        try {
            const response = await quickbooksProvider.attachDocument(transactionId, attachment);
            results.push(response);
        } catch (error) {
            logger.error('[Stripe→QBO] Failed to attach artifact', {
                transactionId,
                fileName: attachment?.fileName,
                error: error.message
            });
        }
    }

    if (results.length === 0 && attachments.length > 0) {
        logger.warn('[Stripe→QBO] No attachments were successfully linked to QBO transaction', {
            transactionId
        });
    }

    return results;
}

module.exports = {
    attachStripeArtifacts,
    buildAttachment,
    MAX_ATTACHMENT_BYTES
};
