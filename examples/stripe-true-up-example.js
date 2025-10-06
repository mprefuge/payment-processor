#!/usr/bin/env node

/**
 * Example: Using the Stripe True-Up Endpoint
 * 
 * This script demonstrates how to use the manual true-up endpoint
 * to backfill or reconcile Stripe data.
 */

const https = require('https');

// Configuration
const FUNCTION_URL = process.env.FUNCTION_URL || 'http://localhost:7071';
const FUNCTION_KEY = process.env.FUNCTION_KEY || '';

/**
 * Make a POST request to the true-up endpoint
 */
async function trueUpSync(params) {
    return new Promise((resolve, reject) => {
        const url = new URL('/api/sync/stripe/true-up', FUNCTION_URL);
        
        const options = {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                ...(FUNCTION_KEY && { 'x-functions-key': FUNCTION_KEY })
            }
        };

        const req = (FUNCTION_URL.startsWith('https') ? https : require('http')).request(
            url,
            options,
            (res) => {
                let data = '';
                res.on('data', chunk => data += chunk);
                res.on('end', () => {
                    try {
                        resolve({
                            status: res.statusCode,
                            data: JSON.parse(data)
                        });
                    } catch (e) {
                        reject(new Error(`Invalid JSON response: ${data}`));
                    }
                });
            }
        );

        req.on('error', reject);
        req.write(JSON.stringify(params));
        req.end();
    });
}

/**
 * Example 1: Dry run to see what would be synced
 */
async function example1_DryRun() {
    console.log('\n📋 Example 1: Dry Run\n');
    
    const result = await trueUpSync({
        since: '2024-01-01T00:00:00Z',
        dryRun: true,
        resources: ['payouts']
    });

    console.log('Status:', result.status);
    console.log('Summary:', result.data.summary);
    console.log('\nPayouts found:', result.data.results.payouts.fetched);
    console.log('(Not processed because dryRun=true)');
}

/**
 * Example 2: Sync payouts from the last 30 days
 */
async function example2_Last30Days() {
    console.log('\n📅 Example 2: Sync Last 30 Days\n');
    
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    const result = await trueUpSync({
        since: thirtyDaysAgo.toISOString(),
        resources: ['payouts']
    });

    console.log('Status:', result.status);
    console.log('Summary:', result.data.summary);
    
    if (result.data.summary.totalErrors > 0) {
        console.log('\n⚠️  Errors occurred:');
        console.log(result.data.results.payouts.errors);
    }
}

/**
 * Example 3: Sync specific date range in chunks
 */
async function example3_ChunkedSync() {
    console.log('\n📦 Example 3: Chunked Sync (Month by Month)\n');
    
    const months = [
        '2024-01-01T00:00:00Z',
        '2024-02-01T00:00:00Z',
        '2024-03-01T00:00:00Z',
        '2024-04-01T00:00:00Z'
    ];

    for (const month of months) {
        console.log(`\nSyncing from ${month}...`);
        
        const result = await trueUpSync({
            since: month,
            resources: ['payouts']
        });

        console.log(`  Fetched: ${result.data.results.payouts.fetched}`);
        console.log(`  Processed: ${result.data.results.payouts.processed}`);
        console.log(`  Skipped: ${result.data.results.payouts.skipped}`);
        console.log(`  Errors: ${result.data.summary.totalErrors}`);

        // Wait 5 seconds between months to avoid rate limits
        if (month !== months[months.length - 1]) {
            console.log('  Waiting 5 seconds before next month...');
            await new Promise(resolve => setTimeout(resolve, 5000));
        }
    }
}

/**
 * Example 4: Sync connected account
 */
async function example4_ConnectedAccount() {
    console.log('\n🔗 Example 4: Sync Connected Account\n');
    
    const result = await trueUpSync({
        since: '2024-01-01T00:00:00Z',
        account: 'acct_123456789',  // Replace with actual account ID
        resources: ['payouts']
    });

    console.log('Status:', result.status);
    console.log('Account:', result.data.stripeAccountId);
    console.log('Summary:', result.data.summary);
}

/**
 * Example 5: Fetch all resource types
 */
async function example5_AllResources() {
    console.log('\n📊 Example 5: Fetch All Resources (Dry Run)\n');
    
    const result = await trueUpSync({
        since: '2024-01-01T00:00:00Z',
        dryRun: true,
        resources: ['payouts', 'charges', 'refunds', 'disputes']
    });

    console.log('Status:', result.status);
    console.log('\nResults:');
    console.log('  Payouts:', result.data.results.payouts.fetched);
    console.log('  Charges:', result.data.results.charges.fetched);
    console.log('  Refunds:', result.data.results.refunds.fetched);
    console.log('  Disputes:', result.data.results.disputes.fetched);
    console.log('\nNote: Only payouts are currently processed through accounting sync.');
}

// Main execution
async function main() {
    console.log('🚀 Stripe True-Up Examples');
    console.log('='.repeat(50));
    
    const example = process.argv[2] || '1';
    
    try {
        switch (example) {
            case '1':
                await example1_DryRun();
                break;
            case '2':
                await example2_Last30Days();
                break;
            case '3':
                await example3_ChunkedSync();
                break;
            case '4':
                await example4_ConnectedAccount();
                break;
            case '5':
                await example5_AllResources();
                break;
            default:
                console.log('\nUsage: node stripe-true-up-example.js [1-5]');
                console.log('\nExamples:');
                console.log('  1 - Dry run');
                console.log('  2 - Sync last 30 days');
                console.log('  3 - Chunked sync (month by month)');
                console.log('  4 - Sync connected account');
                console.log('  5 - Fetch all resources');
        }
    } catch (error) {
        console.error('\n❌ Error:', error.message);
        process.exit(1);
    }
}

// Run if called directly
if (require.main === module) {
    main();
}

module.exports = { trueUpSync };
