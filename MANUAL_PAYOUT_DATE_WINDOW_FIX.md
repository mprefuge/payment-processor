# Manual Payout Date Window Fix - Implementation Summary

## Problem

Manual Stripe payouts in test mode were experiencing validation mismatches because they were fetching transactions from too wide a date window (30 days), which included transactions from previous payouts.

### Symptoms from Production Logs

```
[PayoutSync] Using date range filter for manual payout (no payout ID filtering)
[PayoutSync] Date window: 2025-09-03T15:03:57.000Z to 2025-10-03T15:03:57.000Z (30 days!)
[PayoutSync] Fetched 78 transactions in date range
[PayoutSync] Summary: { charges: 43, refunds: 0, fees: 4117, total: 111312, currency: 'usd', excluded: '35 transactions (types: payout, advance)' }
[PayoutSync] Total mismatch! Expected: 2365, Actual: 111312, Diff: 108947
```

- Payout amount: $23.65
- Calculated total from transactions: $1,113.12
- **The 78 transactions included many from previous payouts**
- 35 payout/advance transactions correctly excluded
- But the 43 charges were from a 30-day window, not just this payout

### Root Cause

1. **Manual payouts in test mode** don't set the `payout` field on balance transactions (it's `null`)
2. **Previous payout lookup failed** because it only looked for payouts with `status === 'posted'`
3. **When validation failed**, the sync was NOT recorded in the ledger at all
4. **Without a previous payout record**, the system fell back to a 30-day window
5. **The wide window picked up transactions** from OTHER previous payouts, causing validation mismatches

### Why This Happened

The code in `_getPreviousPayoutSync()` was filtering for only successfully posted payouts:

```javascript
// OLD CODE
const previousPayouts = syncs.filter(sync => {
    // ...
    return syncDate < currentDate && sync.status === 'posted'; // ❌ Only 'posted' status
});
```

When validation failed, the payout job would:
1. Validate totals → fail
2. Create review task
3. Update event status to 'needs_review'
4. **Return early without recording in ledger** ❌

So the next payout would not find any previous payout and fall back to the 30-day window.

## Solution

### Change 1: Record Failed Syncs in Ledger

Modified `stripeWebhook/index.js` to record failed syncs with status `'needs_review'` BEFORE returning:

```javascript
// NEW CODE in processPayoutJob()
if (!validation.isValid) {
    context.log('[PayoutJob] Validation failed - totals mismatch');
    
    // Generate posting instructions even though validation failed
    // This ensures we have the arrival_date for future payouts
    const postingInstructions = payoutSyncService.generatePostingInstructions(
        payout,
        summary,
        stripeAccountId
    );
    
    // ✅ Record the failed sync in ledger
    await syncLedger.recordSync({
        stripeAccountId,
        payoutId,
        provider: payoutSyncService.config.getConfig().provider,
        providerDocIds: {},
        postingInstructions,
        status: 'needs_review', // ← Failed status
        metadata: {
            error: 'Totals mismatch',
            validation,
            recordedAt: new Date().toISOString()
        }
    });
    
    // ... create review task and return
}
```

### Change 2: Find Previous Payouts Regardless of Status

Modified `services/payoutSyncService.js` to find previous payouts with ANY status:

```javascript
// NEW CODE in _getPreviousPayoutSync()
const previousPayouts = syncs.filter(sync => {
    // ...
    return syncDate < currentDate; // ✅ Accept ANY status (posted OR needs_review)
});
```

## Impact

### Before Fix

```
Payout 1 (14:40:06): Validation fails → NOT recorded in ledger
Payout 2 (15:03:57): No previous payout found → Use 30-day window
                      Date range: 2025-09-03 to 2025-10-03
                      Fetches: 78 transactions (including Payout 1's transactions)
                      Result: Validation mismatch (Expected: 2365, Actual: 111312)
```

### After Fix

```
Payout 1 (14:40:06): Validation fails → Recorded with status 'needs_review' ✅
Payout 2 (15:03:57): Previous payout found ✅
                      Date range: 2025-10-03T14:40:06 to 2025-10-03T15:03:57
                      Duration: 23 minutes (not 30 days!) ✅
                      Fetches: Only transactions from this 23-minute window
                      Result: Correct validation
```

## Test Coverage

Created comprehensive test: `tests/manualPayoutDateWindow.test.js`

### Test 1: Manual Payout Date Window Optimization
- Simulates two sequential manual payouts
- First payout validation fails and is recorded with status 'needs_review'
- Second payout finds the first payout as previous
- Verifies date window is tightened from 30 days to 23 minutes

### Test 2: Payout/Advance Transaction Exclusion
- Verifies payout and advance type transactions are still excluded
- Ensures business transactions are correctly summarized
- Validates the total matches expected value

## Validation

All existing tests pass (14 test suites):
- ✅ integration.test.js
- ✅ transactionCreationFlow.test.js
- ✅ failedCanceledTransactions.test.js
- ✅ payoutSync.test.js
- ✅ payoutCrmIntegration.test.js
- ✅ payoutSyncFix.test.js
- ✅ manualPayoutSync.test.js
- ✅ payoutDateRangeFix.test.js
- ✅ connectedAccountPayoutFix.test.js
- ✅ payoutArrivalDateFix.test.js
- ✅ payoutSyncLogicCorrection.test.js
- ✅ payoutAdvanceExclusion.test.js
- ✅ productionScenarioSimulation.test.js
- ✅ manualPayoutDateWindow.test.js (new)

## Monitoring

Look for these log messages to verify correct behavior:

### Successful Previous Payout Lookup
```
[PayoutSync] Found previous payout: po_xxx
```

### Optimized Date Window
```
[PayoutSync] Date window: 2025-10-03T14:40:06.000Z to 2025-10-03T15:03:57.000Z
```
(Duration should be small, not 30 days)

### Failed Sync Recorded
```
[PayoutJob] Recorded failed sync in ledger for date window optimization
```

## Benefits

1. **Tighter date windows**: Minutes/hours instead of 30 days
2. **No transaction overlap**: Each payout only includes its own transactions
3. **Accurate validation**: Totals match payout amounts
4. **Audit trail**: Failed syncs are tracked in ledger
5. **Production-ready**: Works in both test and live mode

## Migration Notes

### No Breaking Changes
- Existing payout syncs continue to work
- All tests pass
- Backward compatible with existing ledger data

### Expected Behavior Changes
1. **Failed syncs now recorded**: Ledger will contain records with status 'needs_review'
2. **Date windows tightened**: Subsequent payouts use previous payout's arrival_date
3. **Validation more accurate**: Less likely to fetch wrong transactions

## Additional Resources

### Webhook Simulation Script
Added `examples/webhook-simulation.js` with example HTTP requests that simulate what Stripe would send:
- Manual payout events
- Automatic payout events (platform and connected accounts)
- Proper headers and payload structure

Run with:
```bash
node examples/webhook-simulation.js
```

This helps test the webhook endpoint without creating real Stripe transactions.
