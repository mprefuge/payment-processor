/**
 * Test to simulate the exact production scenario from user logs
 * 
 * This test recreates the exact issue reported:
 * - 76 transactions fetched
 * - Many type=payout and type=advance transactions
 * - Expected payout amount: 2365
 * - Summary showing total: 0 (before fix)
 */

const PayoutSyncService = require('../dist/services/payoutRecon/payoutSyncService');

// Mock accounting provider
class MockAccountingProvider {
    async healthCheck() {
        return { status: 'ok' };
    }
}

// Mock sync ledger
class MockSyncLedger {
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
                operatingBankAccount: 'Operating Bank'
            },
            posting: {
                granularity: 'per-payout',
                strategy: 'je-transfer',
                dateSource: 'arrival'
            }
        }),
        getStripeAccount: () => null
    };
}

async function testProductionScenario() {
    console.log('\n🧪 Simulating Exact Production Scenario from Logs');
    console.log('=' .repeat(70));
    console.log('');
    console.log('From production logs on 2025-10-03T14:40:09Z:');
    console.log('  Payout: po_1SEA9SBJf9YYVP9mShajRhDH');
    console.log('  Expected amount: 2365 (cents)');
    console.log('  Fetched: 76 transactions');
    console.log('  Summary (before fix): total: 0');
    console.log('  Result: Total mismatch! Expected: 2365, Actual: 0, Diff: 2365');
    console.log('');
    console.log('Sample transactions from logs:');
    console.log('  1. type=advance, amount=2415, net=2415, payout=null');
    console.log('  2. type=payout, amount=-2365, net=-2415, payout=null');
    console.log('  3. type=payout, amount=-2365, net=-2415, payout=null');
    console.log('  4. type=advance, amount=2415, net=2415, payout=null');
    console.log('  ... (76 total transactions)');
    console.log('');
    
    try {
        const mockConfig = createMockConfig();
        const syncLedger = new MockSyncLedger();
        const provider = new MockAccountingProvider();
        const service = new PayoutSyncService(mockConfig, provider, syncLedger);
        
        // Create a realistic set of transactions that would sum to 2365
        // Multiple payout/advance pairs that cancel out, plus real transactions
        const balanceTransactions = [];
        
        // Add several payout/advance pairs (from the logs)
        for (let i = 0; i < 35; i++) {
            balanceTransactions.push(
                {
                    id: `txn_advance_${i}`,
                    type: 'advance',
                    amount: 2415,
                    net: 2415,
                    available_on: 1696262558 + i,
                    payout: null,
                    currency: 'usd'
                },
                {
                    id: `txn_payout_${i}`,
                    type: 'payout',
                    amount: -2365,
                    net: -2415,
                    available_on: 1696262558 + i,
                    payout: null,
                    currency: 'usd'
                }
            );
        }
        
        // Now add the actual business transactions that should sum to 2365
        // Let's say: 1 charge of $50 = 5000 cents, net after fees = 4850
        // And another charge of $25 = 2500 cents, net after fees = 2415
        // Total: 7265, but with some fees bringing it down to ~2365
        balanceTransactions.push(
            {
                id: 'txn_charge_1',
                type: 'charge',
                amount: 5000,
                net: 4850,
                available_on: 1696262560,
                payout: null,
                currency: 'usd',
                fee_details: [{ type: 'stripe_fee', amount: 150 }]
            },
            {
                id: 'txn_charge_2',
                type: 'charge',
                amount: 2500,
                net: 2415,
                available_on: 1696262561,
                payout: null,
                currency: 'usd',
                fee_details: [{ type: 'stripe_fee', amount: 85 }]
            },
            // Add some fees to get to exactly 2365
            {
                id: 'txn_fee_1',
                type: 'stripe_fee',
                amount: -4900,
                net: -4900,
                available_on: 1696262562,
                payout: null,
                currency: 'usd'
            }
        );
        
        console.log(`\nCreated ${balanceTransactions.length} transactions:`);
        console.log(`  - ${balanceTransactions.filter(t => t.type === 'advance').length} advance transactions`);
        console.log(`  - ${balanceTransactions.filter(t => t.type === 'payout').length} payout transactions`);
        console.log(`  - ${balanceTransactions.filter(t => t.type === 'charge').length} charge transactions`);
        console.log(`  - ${balanceTransactions.filter(t => t.type === 'stripe_fee').length} fee transactions`);
        console.log('');
        
        const summary = service.summarize(balanceTransactions);
        
        console.log('✅ Summary Result:');
        console.log(`   Total: ${summary.total}`);
        console.log(`   Charges: ${summary.charges.count}`);
        console.log(`   Fees: ${summary.fees.stripe.amount}`);
        console.log(`   Currency: ${summary.currency}`);
        console.log(`   Excluded: ${summary.excluded.count} transactions (types: ${summary.excluded.types.join(', ')})`);
        console.log('');
        
        // Calculate expected total
        const expectedTotal = 4850 + 2415 - 4900; // charge nets minus fee
        
        console.log('Validation:');
        console.log(`   Expected total: ${expectedTotal} (from business transactions only)`);
        console.log(`   Actual total: ${summary.total}`);
        console.log(`   Excluded payout/advance pairs: ${summary.excluded.count}`);
        console.log('');
        
        if (summary.total !== expectedTotal) {
            console.log(`❌ FAILED: Total mismatch - Expected ${expectedTotal}, got ${summary.total}`);
            return false;
        }
        
        if (summary.excluded.count !== 70) { // 35 advances + 35 payouts
            console.log(`❌ FAILED: Expected 70 excluded transactions, got ${summary.excluded.count}`);
            return false;
        }
        
        if (summary.total === 0) {
            console.log('❌ FAILED: Total is still 0 - fix did not work!');
            return false;
        }
        
        console.log('✅ SUCCESS!');
        console.log('');
        console.log('The fix correctly:');
        console.log('   ✓ Excluded 70 payout/advance transactions');
        console.log('   ✓ Calculated total from business transactions only');
        console.log(`   ✓ Total is ${summary.total}, NOT 0`);
        console.log('   ✓ Would pass validation (if payout amount matched)');
        console.log('');
        console.log('This resolves the production issue where:');
        console.log('   ❌ Before: total=0 due to payout/advance cancelling out');
        console.log('   ✅ After: total=business_activity_sum (correct)');
        console.log('');
        
        return true;
    } catch (error) {
        console.log('❌ Failed:', error.message);
        console.error(error);
        return false;
    }
}

// Run the test
testProductionScenario().then(success => {
    process.exit(success ? 0 : 1);
}).catch(error => {
    console.error('Test execution failed:', error);
    process.exit(1);
});
