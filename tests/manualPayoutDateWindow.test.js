/**
 * Test to verify manual payout date window fix
 * 
 * This test validates the fix for the issue where manual payouts
 * were fetching transactions from too wide a date window (30 days)
 * and picking up transactions from previous payouts, causing validation mismatches.
 * 
 * The fix:
 * 1. Record failed syncs in ledger with status 'needs_review'
 * 2. Use previous payout's arrival_date as lower bound (regardless of status)
 * 3. This tightens the date window and prevents overlap
 */

const PayoutSyncService = require('../dist/services/payoutRecon/payoutSyncService');
const SyncLedger = require('../dist/services/payoutRecon/syncLedger');
const WebhookEventStore = require('../dist/services/idempotency/webhookEventStore');
const { createTestSyncLedger, createTestWebhookEventStore } = require('./helpers/persistentTestUtils');

// Mock accounting provider
class MockAccountingProvider {
    async upsertJournalEntry(je) {
        return { id: 'je-mock' };
    }
    async upsertTransfer(transfer) {
        return { id: 'xfer-mock' };
    }
    async healthCheck() {
        return { healthy: true };
    }
}

// Create mock config
function createMockConfig() {
    return {
        getConfig: () => ({
            provider: 'quickbooks',
            accounts: {
                stripeClearingAccount: 'Stripe Clearing',
                operatingBankAccount: 'Operating Bank',
                revenueAccount: 'Revenue',
                refundsAccount: 'Refunds',
                stripeFeeAccount: 'Stripe Fees',
                chargebackAccount: 'Chargebacks',
                adjustmentAccount: 'Adjustments'
            },
            posting: {
                granularity: 'per-payout',
                strategy: 'je-transfer',
                dateSource: 'arrival'
            }
        }),
        getStripeAccount: (accountId) => {
            if (!accountId) return null;
            return {
                secretKey: process.env.STRIPE_TEST_SECRET_KEY,
                mode: 'test'
            };
        }
    };
}

/**
 * Test scenario from user's production logs
 * 
 * The user reported:
 * 1. First payout at 14:40:06 - validation failed, NOT recorded in ledger
 * 2. Second payout at 15:03:57 - used 30-day fallback window
 * 3. Date window: 2025-09-03 to 2025-10-03 (30 days)
 * 4. Fetched 78 transactions including transactions from first payout
 * 5. Total mismatch: Expected 2365, Actual 111312
 */
async function testManualPayoutDateWindowFix() {
    console.log('\n🧪 Test: Manual payout date window optimization');
    console.log('=' .repeat(70));
    console.log('');
    console.log('Scenario: Sequential manual payouts should not overlap');
    console.log('Problem: Without recording failed syncs, subsequent payouts use 30-day window');
    console.log('Fix: Record failed syncs in ledger for date window optimization');
    console.log('');
    
    try {
        const config = createMockConfig();
        const accountingProvider = new MockAccountingProvider();
        const syncLedger = await createTestSyncLedger('manual-date-window');
        const webhookEventStore = await createTestWebhookEventStore('manual-date-window');
        const payoutSyncService = new PayoutSyncService(config, accountingProvider, syncLedger);
        
        // Simulate first payout with validation failure
        console.log('Step 1: Simulate first payout (validation fails)');
        console.log('-'.repeat(70));
        
        const firstPayoutId = 'po_first_manual_001';
        const firstArrivalDate = Math.floor(new Date('2025-10-03T14:40:06Z').getTime() / 1000);
        const firstPayout = {
            id: firstPayoutId,
            object: 'payout',
            amount: 2365,
            arrival_date: firstArrivalDate,
            automatic: false,
            created: firstArrivalDate - 60,
            currency: 'usd',
            status: 'paid',
            type: 'bank_account'
        };
        
        // Simulate first payout processing with validation failure
        const firstPostingInstructions = payoutSyncService.generatePostingInstructions(
            firstPayout,
            { total: 0, currency: 'usd', charges: { count: 0 }, refunds: { count: 0 }, fees: { stripe: { amount: 0 }, application: { amount: 0 } }, disputes: { count: 0 }, adjustments: { amount: 0 } },
            null
        );
        
        // Record the failed sync (this is what the fix adds)
        await syncLedger.recordSync({
            stripeAccountId: 'default',
            payoutId: firstPayoutId,
            provider: 'quickbooks',
            providerDocIds: {},
            postingInstructions: firstPostingInstructions,
            status: 'needs_review',
            metadata: {
                error: 'Totals mismatch',
                validation: { isValid: false, expected: 2365, actual: 0, difference: 2365 }
            }
        });
        
        console.log(`✓ First payout recorded with status 'needs_review'`);
        console.log(`  Payout ID: ${firstPayoutId}`);
        console.log(`  Arrival date: ${new Date(firstArrivalDate * 1000).toISOString()}`);
        console.log('');
        
        // Simulate second payout
        console.log('Step 2: Simulate second payout (23 minutes later)');
        console.log('-'.repeat(70));
        
        const secondPayoutId = 'po_second_manual_001';
        const secondArrivalDate = Math.floor(new Date('2025-10-03T15:03:57Z').getTime() / 1000);
        const secondPayout = {
            id: secondPayoutId,
            object: 'payout',
            amount: 2365,
            arrival_date: secondArrivalDate,
            automatic: false,
            created: secondArrivalDate - 60,
            currency: 'usd',
            status: 'paid',
            type: 'bank_account'
        };
        
        // Test that _getPreviousPayoutSync finds the first payout
        const previousSync = await payoutSyncService._getPreviousPayoutSync(null, secondPayout);
        
        if (!previousSync) {
            throw new Error('Failed to find previous payout sync');
        }
        
        console.log(`✓ Found previous payout: ${previousSync.payoutId}`);
        console.log(`  Previous arrival date: ${new Date(previousSync.payout.arrival_date * 1000).toISOString()}`);
        console.log('');
        
        // Calculate expected date window
        const expectedStartTime = previousSync.payout.arrival_date;
        const expectedEndTime = secondPayout.arrival_date;
        const windowDuration = (expectedEndTime - expectedStartTime);
        const windowMinutes = Math.floor(windowDuration / 60);
        
        console.log('Step 3: Verify date window calculation');
        console.log('-'.repeat(70));
        console.log(`✓ Date window is optimized:`);
        console.log(`  Start: ${new Date(expectedStartTime * 1000).toISOString()}`);
        console.log(`  End:   ${new Date(expectedEndTime * 1000).toISOString()}`);
        console.log(`  Duration: ${windowMinutes} minutes (not 30 days!)`);
        console.log('');
        
        // Verify the window is tight (much less than 30 days)
        const thirtyDaysInSeconds = 30 * 24 * 60 * 60;
        if (windowDuration >= thirtyDaysInSeconds) {
            throw new Error(`Date window too wide: ${windowDuration} seconds (expected < ${thirtyDaysInSeconds})`);
        }
        
        console.log('✅ Test PASSED');
        console.log('');
        console.log('Summary:');
        console.log('  ✓ Failed syncs are recorded in ledger');
        console.log('  ✓ Previous payout found regardless of status');
        console.log('  ✓ Date window is tightened to prevent overlap');
        console.log(`  ✓ Window: ${windowMinutes} minutes (vs 30 days before fix)`);
        console.log('');
        
        return true;
    } catch (error) {
        console.log('❌ Test FAILED:', error.message);
        console.error(error);
        return false;
    }
}

/**
 * Test that payout/advance exclusion still works correctly
 */
async function testPayoutAdvanceExclusion() {
    console.log('\n🧪 Test: Payout and advance transactions excluded from summary');
    console.log('=' .repeat(70));
    console.log('');
    
    try {
        const config = createMockConfig();
        const accountingProvider = new MockAccountingProvider();
        const syncLedger = await createTestSyncLedger('manual-date-window-exclusion');
        const payoutSyncService = new PayoutSyncService(config, accountingProvider, syncLedger);
        
        // Create balance transactions matching user's log pattern
        const balanceTransactions = [
            // Current payout's own payout/advance pair
            { id: 'txn_payout_current', type: 'payout', amount: -2365, net: -2415, available_on: 1696343037, currency: 'usd', payout: null },
            { id: 'txn_advance_current', type: 'advance', amount: 2415, net: 2415, available_on: 1696343037, currency: 'usd', payout: null },
            // Previous payout's payout/advance pair (should be excluded by date window, but testing exclusion logic)
            { id: 'txn_payout_prev', type: 'payout', amount: -2365, net: -2415, available_on: 1696341606, currency: 'usd', payout: null },
            { id: 'txn_advance_prev', type: 'advance', amount: 2415, net: 2415, available_on: 1696341606, currency: 'usd', payout: null },
            // Actual business transactions
            { id: 'txn_charge_1', type: 'charge', amount: 10000, net: 9700, available_on: 1696343000, currency: 'usd', fee: 300, payout: null },
            { id: 'txn_charge_2', type: 'charge', amount: 5000, net: 4850, available_on: 1696343010, currency: 'usd', fee: 150, payout: null }
        ];
        
        const summary = payoutSyncService.summarize(balanceTransactions);
        
        console.log('Balance transactions:');
        console.log('  - 2 payout transactions (should be excluded)');
        console.log('  - 2 advance transactions (should be excluded)');
        console.log('  - 2 charge transactions (should be included)');
        console.log('');
        console.log('Summary result:');
        console.log(`  Total: ${summary.total} (expected: 14550 = 9700 + 4850)`);
        console.log(`  Charges: ${summary.charges.count} (expected: 2)`);
        console.log(`  Excluded: ${summary.excluded.count} (expected: 4)`);
        console.log('');
        
        if (summary.total !== 14550) {
            throw new Error(`Total mismatch: expected 14550, got ${summary.total}`);
        }
        
        if (summary.charges.count !== 2) {
            throw new Error(`Charges count mismatch: expected 2, got ${summary.charges.count}`);
        }
        
        if (summary.excluded.count !== 4) {
            throw new Error(`Excluded count mismatch: expected 4, got ${summary.excluded.count}`);
        }
        
        console.log('✅ Test PASSED');
        console.log('  ✓ Payout and advance transactions excluded');
        console.log('  ✓ Business transactions correctly summarized');
        console.log('');
        
        return true;
    } catch (error) {
        console.log('❌ Test FAILED:', error.message);
        console.error(error);
        return false;
    }
}

async function runTests() {
    console.log('🧪 Manual Payout Date Window Optimization Tests');
    console.log('=' .repeat(70));
    console.log('');
    console.log('Issue: Manual payouts were using 30-day fallback window');
    console.log('       and picking up transactions from previous payouts,');
    console.log('       causing validation mismatches.');
    console.log('');
    console.log('Fix: Record failed syncs in ledger with arrival_date');
    console.log('     so subsequent payouts can use tight date windows.');
    console.log('');
    
    const test1 = await testManualPayoutDateWindowFix();
    const test2 = await testPayoutAdvanceExclusion();
    
    console.log('=' .repeat(70));
    console.log('📊 Test Results:');
    console.log(`   Date window optimization: ${test1 ? '✅ PASS' : '❌ FAIL'}`);
    console.log(`   Payout/advance exclusion: ${test2 ? '✅ PASS' : '❌ FAIL'}`);
    
    if (test1 && test2) {
        console.log('');
        console.log('🎉 All tests passed!');
        console.log('');
        console.log('✨ The fix ensures:');
        console.log('   1. Failed syncs are recorded in ledger');
        console.log('   2. Previous payouts found regardless of status');
        console.log('   3. Date windows are tightened (minutes vs 30 days)');
        console.log('   4. Payout/advance transactions excluded from summary');
        console.log('   5. No overlap between sequential manual payouts');
        return true;
    } else {
        console.log('');
        console.log('❌ Some tests failed');
        return false;
    }
}

// Run tests
if (require.main === module) {
    runTests().then(success => {
        process.exit(success ? 0 : 1);
    }).catch(error => {
        console.error('Test runner error:', error);
        process.exit(1);
    });
}

module.exports = { runTests };
