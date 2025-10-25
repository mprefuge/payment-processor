const { logger } = require('../../lib/logger');
const AccountingSyncConfig = require('../payoutRecon/accountingSyncConfig');
const AccountingProviderFactory = require('../qbo/accountingProviderFactory');
const PayoutSyncService = require('../payoutRecon/payoutSyncService');
const WebhookEventStore = require('../idempotency/webhookEventStore');
const SyncLedger = require('../payoutRecon/syncLedger');
const { createPersistentStorageClients } = require('../idempotency/storage/persistentStoreFactory');
const CrmFactory = require('../salesforce/crmFactory');

// Global service instances
const storageNamespace = process.env.PERSISTENT_STORAGE_NAMESPACE || 'default';
const { webhookEventStore: webhookEventStoreClient, syncLedgerStore } =
  createPersistentStorageClients(storageNamespace);

const webhookEventStore = new WebhookEventStore({ storageClient: webhookEventStoreClient });
const syncLedger = new SyncLedger({ storageClient: syncLedgerStore });

/**
 * Get CRM service instance
 */
function getCrmServiceInstance() {
  try {
    const crmConfig = {
      provider: process.env.CRM_PROVIDER,
      salesforce: {
        instanceUrl: process.env.SF_INSTANCE_URL,
        accessToken: process.env.SF_ACCESS_TOKEN,
      },
    };

    if (!crmConfig.provider) {
      return null;
    }

    return CrmFactory.createCrmService(crmConfig);
  } catch (error) {
    logger.warn('Failed to initialize CRM service:', error.message);
    return null;
  }
}

/**
 * Create context logger wrapper
 */
function createContextLogger(context) {
  const baseLog = (...args) => context.log(...args);

  const resolveMethod = (method) => {
    if (context.log && typeof context.log[method] === 'function') {
      return (...args) => context.log[method](...args);
    }

    if (typeof context[method] === 'function') {
      return (...args) => context[method](...args);
    }

    return baseLog;
  };

  return {
    log: baseLog,
    info: resolveMethod('info'),
    warn: resolveMethod('warn'),
    error: resolveMethod('error'),
  };
}

/**
 * Async job processor for payout sync
 * Extracted from stripeWebhook/index.js for reusability
 */
async function processPayoutJob(
  context,
  payoutId,
  stripeAccountId,
  payoutSyncService,
  eventId = null
) {
  try {
    context.log(`[PayoutJob] Processing payout: ${payoutId}`);

    // 1. Pull payout and balance transactions from Stripe
    const { payout, balanceTransactions } = await payoutSyncService.pullPayout(
      payoutId,
      stripeAccountId
    );
    context.log(`[PayoutJob] Pulled payout with ${balanceTransactions.length} transactions`);

    // 2. Summarize activity
    const summary = payoutSyncService.summarize(balanceTransactions);
    context.log('[PayoutJob] Summary:', {
      charges: summary.charges.count,
      refunds: summary.refunds.count,
      total: summary.total,
    });

    // 3. Validate totals
    const validation = payoutSyncService.validateTotals(summary, payout, balanceTransactions);
    if (!validation.isValid) {
      context.log('[PayoutJob] Validation failed - totals mismatch');

      // Generate posting instructions even though validation failed
      const postingInstructions = payoutSyncService.generatePostingInstructions(
        payout,
        summary,
        stripeAccountId,
        balanceTransactions
      );

      // Record the failed sync in ledger
      await syncLedger.recordSync({
        stripeAccountId,
        payoutId,
        provider: payoutSyncService.config.getConfig().provider,
        providerDocIds: {},
        postingInstructions,
        status: 'needs_review',
        metadata: {
          error: 'Totals mismatch',
          validation,
          recordedAt: new Date().toISOString(),
        },
      });
      context.log('[PayoutJob] Recorded failed sync in ledger');

      // Create review task
      await payoutSyncService.createReviewTask({
        payoutId,
        stripeAccountId,
        error: 'Totals mismatch',
        validationResults: validation,
        summary,
      });

      // Update event status
      if (eventId) {
        await webhookEventStore.updateEventStatus(eventId, 'needs_review', {
          error: `Totals mismatch: ${validation.difference} difference`,
          payoutId,
        });
      }

      return;
    }

    // 4. Generate posting instructions
    const postingInstructions = payoutSyncService.generatePostingInstructions(
      payout,
      summary,
      stripeAccountId,
      balanceTransactions
    );
    context.log('[PayoutJob] Generated posting instructions');

    // 5. Post to accounting system
    const providerDocIds = await payoutSyncService.postToAccounting(postingInstructions);
    context.log('[PayoutJob] Posted to accounting:', providerDocIds);

    // 6. Record in sync ledger
    await syncLedger.recordSync({
      stripeAccountId,
      payoutId,
      provider: payoutSyncService.config.getConfig().provider,
      providerDocIds,
      postingInstructions,
      status: 'posted',
      crmPayoutId: null, // Will be set by CRM sync if enabled
    });
    context.log('[PayoutJob] Recorded sync in ledger');

    // 7. Sync to CRM if enabled
    try {
      await payoutSyncService.syncPayoutToCrm(payout, summary, stripeAccountId);
      context.log('[PayoutJob] Synced to CRM');
    } catch (crmError) {
      context.log('[PayoutJob] CRM sync failed (non-fatal):', crmError.message);
    }

    // Update event status
    if (eventId) {
      await webhookEventStore.updateEventStatus(eventId, 'processed', {
        payoutId,
        providerDocIds,
      });
    }

    context.log('[PayoutJob] Payout sync completed successfully');
  } catch (error) {
    context.log('[PayoutJob] Error:', error.message);
    context.log('[PayoutJob] Error stack:', error.stack);

    // Create review task on error
    try {
      await payoutSyncService.createReviewTask({
        payoutId,
        stripeAccountId,
        error: error.message,
      });
    } catch (reviewTaskError) {
      context.log('[PayoutJob] Failed to create review task:', reviewTaskError.message);
    }

    // Update event status
    if (eventId) {
      await webhookEventStore.updateEventStatus(eventId, 'failed', {
        error: error.message,
        stack: error.stack,
        payoutId,
      });
    }

    throw error;
  }
}

/**
 * Process payout.paid event - main payout sync workflow
 * Extracted from stripeWebhook/index.js for reusability
 */
async function processPayoutPaid(context, payout, stripeAccountId = null, eventId = null) {
  try {
    context.log(`Processing payout.paid: ${payout.id}`);
    context.log(`Stripe account ID: ${stripeAccountId || 'default'}`);

    // Check if accounting sync is enabled
    const accountingConfig = new AccountingSyncConfig();
    context.log(`Accounting sync enabled: ${accountingConfig.isEnabled()}`);

    if (!accountingConfig.isEnabled()) {
      context.log('Accounting sync disabled - skipping payout processing');
      return;
    }

    // Validate configuration
    const validation = accountingConfig.validate();
    context.log(`Configuration validation result:`, validation);

    if (!validation.isValid) {
      context.log('Accounting configuration invalid:', validation.errors);
      if (eventId) {
        await webhookEventStore.updateEventStatus(eventId, 'needs_review', {
          error: `Configuration invalid: ${validation.errors.join(', ')}`,
        });
      }
      return;
    }

    // Check if already synced (idempotency)
    const existingSync = await syncLedger.getSync(stripeAccountId, payout.id);
    context.log(`Existing sync status:`, existingSync ? existingSync.status : 'none');

    if (existingSync && existingSync.status === 'posted') {
      context.log(`Payout already synced: ${payout.id}`);
      return;
    }

    // Initialize accounting provider
    context.log(`Initializing accounting provider: ${accountingConfig.getConfig().provider}`);
    const providerConfig = accountingConfig.getProviderConfig();
    context.log(`Provider config keys:`, Object.keys(providerConfig));

    const accountingProvider = AccountingProviderFactory.createProvider(
      accountingConfig.getConfig().provider,
      providerConfig
    );
    context.log(`Accounting provider initialized successfully`);

    // Initialize payout sync service
    const payoutSyncService = new PayoutSyncService(
      accountingConfig,
      accountingProvider,
      syncLedger,
      null, // ReviewTaskService integration can be added later
      getCrmServiceInstance() // Add CRM service for payout storage
    );

    // Set the context logger so we can see the logs
    const contextLogger = createContextLogger(context);
    payoutSyncService.logger = contextLogger;
    if (accountingProvider.logger) {
      accountingProvider.logger = contextLogger;
    }

    // Process payout job
    context.log('Processing payout synchronously');
    await processPayoutJob(context, payout.id, stripeAccountId, payoutSyncService, eventId);

    context.log('Payout processing completed successfully');
  } catch (error) {
    context.log('Error processing payout.paid:', error.message);
    context.log('Error stack:', error.stack);
    if (eventId) {
      await webhookEventStore.updateEventStatus(eventId, 'failed', {
        error: error.message,
        stack: error.stack,
      });
    }
    throw error;
  }
}

module.exports = processPayoutPaid;
module.exports.processPayoutJob = processPayoutJob;
module.exports.createContextLogger = createContextLogger;
module.exports.getCrmServiceInstance = getCrmServiceInstance;
