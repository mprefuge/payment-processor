# Payout Sync Fix for Stripe Connect Accounts

## Problem

After PR #39 was merged (which fixed manual payout sync by using date-range filtering), automatic payouts on **Stripe Connect accounts** were still failing with 0 transactions returned, despite having positive payout amounts.

### Symptoms
- Payout shows expected amount (e.g., $96.06)
- Balance transactions fetch returns 0 transactions
- Total mismatch error: "Expected: 9606, Actual: 0, Diff: 9606"
- Event marked as "needs_review"

### Example from Logs
```
[PayoutSync] Pulling payout: po_1SE7NUBJf9YYVP9mk8IiZE9x
[PayoutSync] Pulled payout po_1SE7NUBJf9YYVP9mk8IiZE9x: 0 transactions
[PayoutSync] Total mismatch! Expected: 9606, Actual: 0, Diff: 9606
```

## Root Cause

The Stripe API has a **limitation with Stripe Connect accounts**: When fetching balance transactions for a connected account (identified by the `stripe-account` header in webhooks), the `payout` filter parameter **does not work**.

```javascript
// This DOES NOT WORK for connected accounts:
stripe.balanceTransactions.list(
    { payout: 'po_xxx' }, 
    { stripeAccount: 'acct_xxx' }
)
// Returns 0 transactions even when payout has transactions!
```

The previous code only checked if `payout.automatic` was true to decide whether to use the payout filter:

```javascript
// OLD CODE (incorrect for connected accounts)
if (payout.automatic) {
    // Use payout filter directly - FAILS for connected accounts
    const response = stripeAccountId 
        ? await stripe.balanceTransactions.list(params, requestOptions)
        : await stripe.balanceTransactions.list(params);
}
```

## Solution

The fix checks **both** conditions before using the direct payout filter:
1. Must be an automatic payout (`payout.automatic === true`)
2. Must be a platform account (`stripeAccountId === null`)

For connected accounts (or manual payouts), use date-range filtering with client-side filtering:

```javascript
// NEW CODE (correct)
if (payout.automatic && !stripeAccountId) {
    // Use payout filter - only works for platform account
    const response = await stripe.balanceTransactions.list(params);
} else {
    // Use date range filter - works for connected accounts AND manual payouts
    const response = stripeAccountId 
        ? await stripe.balanceTransactions.list(params, requestOptions)
        : await stripe.balanceTransactions.list(params);
    
    // Filter client-side
    const filteredTransactions = response.data.filter(txn => txn.payout === payoutId);
}
```

## Changes Made

### 1. `services/payoutSyncService.js`
- Updated condition from `if (payout.automatic)` to `if (payout.automatic && !stripeAccountId)`
- Removed unnecessary ternary for platform accounts (they never have stripeAccountId)
- Added descriptive logging to indicate which filtering mode is being used
- Updated comments to explain all three scenarios:
  - Platform account automatic payouts (use payout filter)
  - Manual payouts (use date range)
  - Connected accounts (use date range)

### 2. `tests/connectedAccountPayoutFix.test.js` (new file)
- Comprehensive test documenting the fix
- Explains why connected accounts need different handling
- Documents the API limitation
- Validates the solution approach

### 3. `package.json`
- Added new test to test suite

## Validation

All tests pass (45 total tests across 9 test suites):
- ✅ Existing integration tests
- ✅ Transaction creation flow tests
- ✅ Failed/canceled transaction tests
- ✅ Payout sync tests
- ✅ CRM integration tests
- ✅ Manual payout sync tests
- ✅ Date range fix tests
- ✅ **New: Connected account payout fix tests**

## Impact

- **Platform accounts**: Continue to use efficient payout filter (no change in behavior)
- **Connected accounts**: Now correctly fetch transactions using date-range filtering
- **Manual payouts**: No change (already using date-range filtering from PR #39)
- **No regressions**: All existing tests pass

## Monitoring

The fix adds logging to indicate which filtering mode is active:
- `[PayoutSync] Using direct payout filter (automatic payout, platform account)`
- `[PayoutSync] Using date range filter (manual payout)`
- `[PayoutSync] Using date range filter (connected account)`

This makes it easy to verify correct behavior in production logs.

## References

- PR #39: Fixed manual payout sync using date-range filtering
- This fix: Extends date-range filtering to connected accounts
- Stripe API limitation: `payout` filter doesn't work on connected accounts
