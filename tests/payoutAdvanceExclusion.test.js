/**
 * Test to verify that payout and advance type transactions are excluded from summary
 * 
 * This test validates the fix for the issue where manual payouts were showing
 * total: 0 because payout and advance transactions were being included and
 * cancelling each other out.
 * 
 * According to the user's logs:
 * - 76 transactions fetched
 * - Many were type=payout and type=advance
 * - These cancelled out, resulting in total: 0
 * 
 * The fix excludes these internal Stripe balance movement types from the summary.
 */

const PayoutSyncService = require('../services/payoutSyncService');

// Mock accounting provider
class MockAccountingProvider {
    async healthCheck() {
        return { status: 'ok' };
    }

    async upsertJournalEntry(entry) {
        return { id: `je-${Date.now()}` };
    }

    async upsertTransfer(transfer) {
        return { id: `xfer-${Date.now()}` };
    }

    async upsertDeposit(deposit) {
        return { id: `dep-${Date.now()}` };
    }
}

// Mock sync ledger
class MockSyncLedger {
    async recordSync(record) {
        return { id: `sync-${Date.now()}` };
    }

    async getSync(stripeAccountId, payoutId) {
        return null;
    }

    async getSyncsByAccount(accountId) {
        return [];
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
                dateSource: 'arrival',
                timezone: 'America/New_York'
            }
        }),
        getStripeAccount: () => null
    };
}

async function testPayoutAndAdvanceExclusion() {
    console.log('\n🧪 Test: Payout and Advance transactions are excluded from summary');
    console.log('=' .repeat(70));
    
    try {
        const mockConfig = createMockConfig();
        const syncLedger = new MockSyncLedger();
        const provider = new MockAccountingProvider();
        const service = new PayoutSyncService(mockConfig, provider, syncLedger);
        
        console.log('\nScenario: Manual payout with payout/advance type transactions mixed in');
        console.log('This matches the production logs from the user showing:');
        console.log('  - type=advance, amount=2415, net=2415');
        console.log('  - type=payout, amount=-2365, net=-2415');
        console.log('  - type=charge and other business transactions');
        console.log('');
        
        // Create sample transactions matching the user's logs
        const balanceTransactions = [
            // Advance transaction (Stripe internal)
            {
                id: 'txn_advance_1',
                type: 'advance',
                amount: 2415,
                net: 2415,
                available_on: 1696262558,
                payout: null,
                currency: 'usd'
            },
            // Payout transaction (Stripe internal)
            {
                id: 'txn_payout_1',
                type: 'payout',
                amount: -2365,
                net: -2415,
                available_on: 1696262558,
                payout: null,
                currency: 'usd'
            },
            // Actual business transaction - charge
            {
                id: 'txn_charge_1',
                type: 'charge',
                amount: 10000,
                net: 9700,
                available_on: 1696262558,
                payout: null,
                currency: 'usd',
                fee_details: [{ type: 'stripe_fee', amount: 300 }]
            },
            // Actual business transaction - refund
            {
                id: 'txn_refund_1',
                type: 'refund',
                amount: -2000,
                net: -2000,
                available_on: 1696262559,
                payout: null,
                currency: 'usd'
            }
        ];
        
        console.log('Transactions:');
        console.log(`  1. advance: net=2415 (should be EXCLUDED)`);
        console.log(`  2. payout: net=-2415 (should be EXCLUDED)`);
        console.log(`  3. charge: net=9700 (should be INCLUDED)`);
        console.log(`  4. refund: net=-2000 (should be INCLUDED)`);
        console.log('');
        
        const summary = service.summarize(balanceTransactions);
        
        console.log('✅ Summary result:');
        console.log(`   Total: ${summary.total} (expected: 7700 = 9700 - 2000)`);
        console.log(`   Charges: ${summary.charges.count} transactions, gross: ${summary.charges.grossAmount}`);
        console.log(`   Refunds: ${summary.refunds.count} transactions, amount: ${summary.refunds.amount}`);
        console.log(`   Excluded: ${summary.excluded.count} transactions (types: ${summary.excluded.types.join(', ')})`);
        console.log('');
        
        // Validate results
        const expectedTotal = 7700; // 9700 (charge net) - 2000 (refund net)
        const actualTotal = summary.total;
        
        if (actualTotal !== expectedTotal) {
            console.log(`❌ FAILED: Expected total ${expectedTotal}, got ${actualTotal}`);
            return false;
        }
        
        if (summary.excluded.count !== 2) {
            console.log(`❌ FAILED: Expected 2 excluded transactions, got ${summary.excluded.count}`);
            return false;
        }
        
        if (!summary.excluded.types.includes('advance')) {
            console.log(`❌ FAILED: Expected 'advance' in excluded types`);
            return false;
        }
        
        if (!summary.excluded.types.includes('payout')) {
            console.log(`❌ FAILED: Expected 'payout' in excluded types`);
            return false;
        }
        
        if (summary.charges.count !== 1) {
            console.log(`❌ FAILED: Expected 1 charge, got ${summary.charges.count}`);
            return false;
        }
        
        if (summary.refunds.count !== 1) {
            console.log(`❌ FAILED: Expected 1 refund, got ${summary.refunds.count}`);
            return false;
        }
        
        console.log('✅ All assertions passed:');
        console.log('   ✓ Total excludes payout and advance transactions');
        console.log('   ✓ Excluded count is correct (2)');
        console.log('   ✓ Excluded types tracked correctly');
        console.log('   ✓ Business transactions counted correctly');
        console.log('');
        
        return true;
    } catch (error) {
        console.log('❌ Failed:', error.message);
        console.error(error);
        return false;
    }
}

async function testPayoutCancelExclusion() {
    console.log('\n🧪 Test: Payout_cancel transactions are also excluded');
    console.log('=' .repeat(70));
    
    try {
        const mockConfig = createMockConfig();
        const syncLedger = new MockSyncLedger();
        const provider = new MockAccountingProvider();
        const service = new PayoutSyncService(mockConfig, provider, syncLedger);
        
        const balanceTransactions = [
            {
                id: 'txn_payout_cancel_1',
                type: 'payout_cancel',
                amount: 5000,
                net: 5000,
                available_on: 1696262558,
                payout: null,
                currency: 'usd'
            },
            {
                id: 'txn_charge_1',
                type: 'charge',
                amount: 10000,
                net: 9700,
                available_on: 1696262558,
                payout: null,
                currency: 'usd'
            }
        ];
        
        const summary = service.summarize(balanceTransactions);
        
        if (summary.total !== 9700) {
            console.log(`❌ FAILED: Expected total 9700, got ${summary.total}`);
            return false;
        }
        
        if (summary.excluded.count !== 1) {
            console.log(`❌ FAILED: Expected 1 excluded transaction, got ${summary.excluded.count}`);
            return false;
        }
        
        if (!summary.excluded.types.includes('payout_cancel')) {
            console.log(`❌ FAILED: Expected 'payout_cancel' in excluded types`);
            return false;
        }
        
        console.log('✅ PASSED: payout_cancel transactions excluded correctly');
        console.log(`   Total: ${summary.total} (only charge net)`);
        console.log(`   Excluded: ${summary.excluded.count} (payout_cancel)`);
        console.log('');
        
        return true;
    } catch (error) {
        console.log('❌ Failed:', error.message);
        return false;
    }
}

async function testNoExclusionsWhenNotNeeded() {
    console.log('\n🧪 Test: No exclusions when only business transactions present');
    console.log('=' .repeat(70));
    
    try {
        const mockConfig = createMockConfig();
        const syncLedger = new MockSyncLedger();
        const provider = new MockAccountingProvider();
        const service = new PayoutSyncService(mockConfig, provider, syncLedger);
        
        const balanceTransactions = [
            {
                id: 'txn_charge_1',
                type: 'charge',
                amount: 10000,
                net: 9700,
                available_on: 1696262558,
                payout: 'po_123',
                currency: 'usd'
            },
            {
                id: 'txn_charge_2',
                type: 'charge',
                amount: 5000,
                net: 4850,
                available_on: 1696262559,
                payout: 'po_123',
                currency: 'usd'
            }
        ];
        
        const summary = service.summarize(balanceTransactions);
        
        if (summary.total !== 14550) {
            console.log(`❌ FAILED: Expected total 14550, got ${summary.total}`);
            return false;
        }
        
        if (summary.excluded.count !== 0) {
            console.log(`❌ FAILED: Expected 0 excluded transactions, got ${summary.excluded.count}`);
            return false;
        }
        
        console.log('✅ PASSED: No exclusions when all transactions are business transactions');
        console.log(`   Total: ${summary.total}`);
        console.log(`   Excluded: ${summary.excluded.count}`);
        console.log('');
        
        return true;
    } catch (error) {
        console.log('❌ Failed:', error.message);
        return false;
    }
}

async function runTests() {
    console.log('🧪 Testing Payout/Advance Transaction Exclusion');
    console.log('=' .repeat(70));
    console.log('');
    console.log('This test validates the fix for the issue where manual payouts');
    console.log('were showing total: 0 because payout and advance transactions');
    console.log('were being included in the summary and cancelling each other out.');
    console.log('');
    console.log('The fix excludes these Stripe internal balance movement types:');
    console.log('  - payout: The payout transfer itself');
    console.log('  - advance: Instant payout advance');
    console.log('  - payout_cancel: Cancelled payout');
    console.log('');
    
    const test1 = await testPayoutAndAdvanceExclusion();
    const test2 = await testPayoutCancelExclusion();
    const test3 = await testNoExclusionsWhenNotNeeded();
    
    console.log('=' .repeat(70));
    console.log('📊 Test Results:');
    console.log(`   Payout/Advance exclusion: ${test1 ? '✅ PASS' : '❌ FAIL'}`);
    console.log(`   Payout_cancel exclusion: ${test2 ? '✅ PASS' : '❌ FAIL'}`);
    console.log(`   No false positives: ${test3 ? '✅ PASS' : '❌ FAIL'}`);
    console.log('');
    
    if (test1 && test2 && test3) {
        console.log('🎉 All tests passed!');
        console.log('');
        console.log('✨ This fix ensures that:');
        console.log('   1. Payout and advance transactions are excluded from summaries');
        console.log('   2. Only business transactions (charges, refunds, fees, etc.) are counted');
        console.log('   3. Manual payouts now show correct totals instead of 0');
        console.log('   4. Excluded transactions are tracked and logged for transparency');
        return true;
    } else {
        console.log('❌ Some tests failed');
        return false;
    }
}

// Run tests
runTests().then(success => {
    process.exit(success ? 0 : 1);
}).catch(error => {
    console.error('Test execution failed:', error);
    process.exit(1);
});
