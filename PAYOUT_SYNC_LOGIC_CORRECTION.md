# Payout Sync Logic Correction - Implementation Summary

## Overview

This implementation corrects the payout sync logic to handle manual payouts, connected accounts, and platform automatic payouts correctly, while adding diagnostic logging and optimizing date windows.

## Changes Made

### 1. Corrected Payout Sync Logic (`services/payoutSyncService.js`)

#### Three Distinct Code Paths

**Case 1: Platform Automatic Payouts** (UNCHANGED - most efficient)
- Condition: `payout.automatic && !stripeAccountId`
- Method: Direct payout filter `balanceTransactions.list({ payout: id })`
- Filtering: None needed (Stripe API handles it)
- Performance: Optimal

**Case 2: Connected Account Automatic Payouts** (NEW - with fallback)
- Condition: `payout.automatic && stripeAccountId`
- Method: Try direct filter first, fallback to date range
- Steps:
  1. Attempt `balanceTransactions.list({ payout: id }, { stripeAccount })`
  2. If result is empty → Fallback to date range filter
  3. In fallback: Filter by `txn.payout === payoutId`
- Reason: Connected accounts may not support direct payout filter reliably

**Case 3: Manual Payouts** (CORRECTED - no payout ID filtering)
- Condition: `!payout.automatic`
- Method: Date range filter WITHOUT payout ID filtering
- Critical Fix: DO NOT filter by `txn.payout === payoutId`
- Reason: Manual payouts include ALL available balance at time of creation
- Transactions may not have `payout` field set reliably

### 2. Date Window Optimization

Added `_getPreviousPayoutSync()` method to tighten date windows:

```javascript
// OLD: Always use 30-day window
const startTime = referenceDate - (30 * 24 * 60 * 60);
const endTime = referenceDate;

// NEW: Use previous payout arrival date when available
const previousSync = await this._getPreviousPayoutSync(stripeAccountId, payout);
const startTime = previousSync 
    ? previousSync.payout.arrival_date 
    : (payout.arrival_date || payout.created) - (30 * 24 * 60 * 60);
const endTime = payout.arrival_date || payout.created;
```

**Benefits:**
- Reduces API calls to Stripe
- Prevents transaction overlap between payouts
- More accurate transaction windows
- Fallback to 30-day window if no previous payout exists

### 3. Enhanced Diagnostic Logging

#### Webhook Request Logging (`stripeWebhook/index.js`)

Added safe, redacted logging of all incoming webhook requests:

```javascript
function logWebhookRequest(context, req, event) {
    const logEntry = {
        method: req.method,
        url: req.url,
        headers: {
            'content-type': safeHeaders['content-type'],
            'stripe-account': safeHeaders['stripe-account'],
            // Sensitive headers redacted: stripe-signature, authorization, etc.
        },
        event: {
            id: event?.id,
            type: event?.type,
            livemode: event?.livemode,
            created: event?.created
        }
    };
}
```

**Security:**
- All sensitive headers redacted (signatures, tokens, cookies)
- No full payload logging
- Only event identity and type included
- Safe for production logging

#### Validation Mismatch Diagnostics

Enhanced `validateTotals()` to log transaction samples on mismatch:

```javascript
if (!isValid) {
    this.logger.error(`[PayoutSync] Diagnostic: Considered ${balanceTransactions.length} transactions`);
    
    // Log first 10 transactions with key details
    for (let i = 0; i < sampleSize; i++) {
        const txn = balanceTransactions[i];
        this.logger.error(`[PayoutSync]   ${i+1}. id=${txn.id}, type=${txn.type}, ` +
            `amount=${txn.amount}, net=${txn.net}, ` +
            `available_on=${new Date(txn.available_on * 1000).toISOString()}, ` +
            `payout=${txn.payout || 'null'}`);
    }
}
```

**Helps Debug:**
- Which transactions were considered
- Whether payout field is set
- Transaction amounts and types
- Available dates

### 4. Comprehensive Test Coverage

Created `tests/payoutSyncLogicCorrection.test.js` with tests for:

1. ✅ Manual payout behavior (no payout ID filtering)
2. ✅ Connected account fallback logic
3. ✅ Platform automatic efficiency (unchanged)
4. ✅ Date window optimization
5. ✅ Diagnostic logging for validation mismatches
6. ✅ Logic decision tree validation

Updated existing tests to use new `validateTotals` signature with `balanceTransactions` parameter.

## Test Results

All 11 test suites passing:
- ✅ Integration tests
- ✅ Transaction creation flow tests
- ✅ Failed/canceled transaction tests
- ✅ Payout sync tests
- ✅ Payout CRM integration tests
- ✅ Payout sync fix tests
- ✅ Manual payout sync tests
- ✅ Payout date range fix tests
- ✅ Connected account payout fix tests
- ✅ Payout arrival date fix tests
- ✅ **NEW:** Payout sync logic correction tests

## Acceptance Criteria - All Met ✅

1. ✅ **Manual Payouts**: Sync summary based on ALL transactions in date window - not filtered by payout ID
2. ✅ **Connected Account Automatic Payouts**: Fallback gracefully to date-range if payout filtering yields 0 transactions
3. ✅ **Platform Automatic Payouts**: Continue to work efficiently with direct payout filter
4. ✅ **Date Window Optimization**: Tightened using previous payout's arrival date where possible
5. ✅ **Webhook Request Logs**: Include safe, redacted information for every request
6. ✅ **Diagnostic Logs**: Help explain mismatches and transaction selection
7. ✅ **Tests**: Confirm correct code path and prevent regression for all payout types

## Migration Notes

### No Breaking Changes
- Platform automatic payouts: No change in behavior
- All existing tests pass
- Backward compatible with existing sync ledger data

### Expected Behavior Changes
1. **Manual payouts**: Will now include ALL transactions in date window instead of 0
2. **Connected account automatic**: More reliable with fallback logic
3. **All payouts**: Tighter date windows reduce API overhead

### Monitoring

Look for these log messages to verify correct behavior:

```
[PayoutSync] Using direct payout filter (automatic payout, platform account)
[PayoutSync] Trying direct payout filter for connected account automatic payout
[PayoutSync] Direct payout filter returned X transactions
[PayoutSync] Direct payout filter returned 0 transactions, falling back to date range filter
[PayoutSync] Using date range filter for manual payout (no payout ID filtering)
[PayoutSync] Date window: <start> to <end>
[PayoutSync] Found previous payout: po_xxx
[Webhook] Request: {"method":"POST","url":"/api/stripe/webhook",...}
```

## Production Deployment

1. Deploy code to staging environment
2. Test with real Stripe webhooks in test mode:
   - Manual payout
   - Connected account automatic payout
   - Platform automatic payout
3. Verify log output shows correct code paths
4. Verify transaction counts match expectations
5. Deploy to production
6. Monitor webhook logs for correct behavior

## Support

If validation mismatches occur, the diagnostic logs will now show:
- Total number of transactions considered
- Sample of first 10 transactions with full details
- Whether payout field is set on each transaction
- This makes troubleshooting much easier

## References

- Original issue: Correct payout sync logic for manual, connected, and automatic payouts
- Related docs:
  - `PAYOUT_SYNC_SETUP.md`
  - `CONNECTED_ACCOUNT_PAYOUT_FIX.md`
  - `PAYOUT_ARRIVAL_DATE_FIX.md`
