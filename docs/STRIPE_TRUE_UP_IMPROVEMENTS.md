# Stripe True-Up Logic Improvements

## Overview
This document details the improvements made to the Stripe true-up handler (`stripeTrueUp.ts`) to ensure it properly syncs historic data from Stripe to Salesforce and QuickBooks Online (QBO) with appropriate safeguards.

## Key Improvements

### 0. Runtime Control Parameters (`bypassQbo`, `skipQbo`, `limit`)

The true-up endpoint now supports additional runtime controls so you can safely run targeted backfills.

#### QBO Bypass Override
- **Query params**: `bypassQbo=true` or `skipQbo=true`
- **Headers**: `x-bypass-qbo: true` or `x-skip-qbo: true`
- **Env default**: `STRIPE_TRUE_UP_BYPASS_QBO=true`

When enabled:
- Salesforce updates still run
- QuickBooks posting is skipped for payments, refunds, and payouts
- QBO credentials are not required for that run

#### Per-Run Limit
- **Query param**: `limit=<positive integer>`
- Caps processing to the first `N` records returned by Stripe for the selected type/date range
- Applies to `payments`, `refunds`, and `payouts`

Examples:
- Process only 5 payments: `...&type=payments&limit=5`
- Re-associate/contact backfill without QBO posting: `...&type=payments&resubmit=true&bypassQbo=true&limit=25`

### 1. Status Filtering for Transactions

#### Charges (Payments)
- **Previous Behavior**: All charges were processed regardless of status
- **New Behavior**: Only charges with `status === 'succeeded'` are processed
- **Rationale**: Failed, pending, or other non-successful charges should not be posted to QBO as they represent incomplete or unsuccessful transactions
- **Impact**: Prevents incorrect revenue recognition in QBO

#### Refunds
- **Previous Behavior**: All refunds were processed regardless of status
- **New Behavior**: Only refunds with `status === 'succeeded'` are processed
- **Rationale**: Failed or pending refunds should not be posted to QBO
- **Impact**: Ensures only actual refunds are recorded in accounting system

#### Payouts
- **Previous Behavior**: All payouts were processed regardless of status
- **New Behavior**: Only payouts with `status === 'paid'` are processed
- **Rationale**: Only completed payouts should be recorded in QBO
- **Impact**: Ensures only actual bank transfers are recorded

### 2. Balance Transaction Handling

#### Problem
Balance transactions could come from the Stripe API as either:
- A full expanded object (when using `expand` parameter)
- A string ID (when not expanded)

The previous code assumed it was always an expanded object, which would fail for string IDs.

#### Solution
Enhanced `ensureStripeBalanceTransaction` function to:
1. Check if the value is a string ID
2. If it's a string, fetch the full balance transaction from Stripe API
3. Return the full object for processing
4. Handle errors gracefully by returning null

```typescript
const ensureStripeBalanceTransaction = async (
  stripe: Stripe,
  value: Stripe.BalanceTransaction | string | null | undefined
): Promise<Stripe.BalanceTransaction | null> => {
  if (!value) return null;
  if (typeof value === 'string') {
    try {
      return await stripe.balanceTransactions.retrieve(value);
    } catch (error) {
      return null;
    }
  }
  return value;
};
```

### 3. Duplicate Prevention

#### Mechanism
- Uses idempotency store keyed by balance transaction ID (`bt_{id}`) for charges and refunds
- Uses payout ID (`payout_{id}`) for payouts
- Checks if transaction was already processed before attempting to post
- Marks transaction as processed after successful posting

#### Benefits
- Prevents duplicate entries in both Salesforce and QBO
- Allows safe re-running of true-up operations
- Handles interrupted processes gracefully

### 4. Historic Date Preservation

#### Approach
All dates are preserved from the original Stripe objects:

**For Charges and Refunds:**
```typescript
date: timestampToDate(
  balanceTransaction.created ?? balanceTransaction.available_on ?? null
)
```

**For Payouts:**
```typescript
date: timestampToDate(payout.created ?? payout.arrival_date ?? null)
```

#### Rationale
- Historic data must retain original transaction dates for accurate reporting
- `balance_transaction.created` represents when the transaction actually occurred
- `balance_transaction.available_on` is the fallback for when funds become available
- This ensures QBO entries match the actual transaction timeline

### 5. Enhanced Error Handling and Logging

#### Charge Processing
- Logs when charges are skipped due to non-successful status
- Logs when balance transaction is missing
- Logs each failed charge with charge ID and error details

#### Refund Processing
- Logs when refunds are skipped due to non-successful status
- Logs when balance transaction is missing
- Logs each failed refund with refund ID and error details

#### Payout Processing
- Logs when payouts are skipped due to non-paid status
- Logs each failed payout with payout ID and error details

### 6. Idempotency Store Flushing

Added automatic flushing of the idempotency store after processing completes:

```typescript
if (!dryRun) {
  await dependencies.idempotencyStore.flush();
  context.log('[StripeTrueUp] Idempotency store flushed successfully');
}
```

This ensures all processed transaction IDs are persisted to Azure Table Storage immediately.

## Processing Flow

### Charges (Payments)
1. Fetch all charges in the date range
2. For each charge:
   - Check if status is 'succeeded' → skip if not
   - Ensure balance transaction is loaded (fetch if needed)
   - Check idempotency store → skip if already processed
   - Create/update transaction in Salesforce
  - Post charge to QBO with original date (unless QBO bypass override is enabled)
   - Mark as processed in idempotency store

### Refunds
1. Fetch all refunds in the date range
2. For each refund:
   - Check if status is 'succeeded' → skip if not
   - Ensure balance transaction is loaded (fetch if needed)
   - Check idempotency store → skip if already processed
   - Link to parent charge transaction in Salesforce (if found)
   - Create/update transaction in Salesforce
  - Post refund to QBO with original date (unless QBO bypass override is enabled)
   - Mark as processed in idempotency store

### Payouts
1. Fetch all payouts in the date range
2. For each payout:
   - Check if status is 'paid' → skip if not
   - Check idempotency store → skip if already processed
   - Link payout to related balance transactions in Salesforce
  - Post payout to QBO with original date (unless QBO bypass override is enabled)
   - Mark as processed in idempotency store

## QBO Posting Details

### Charges
- Uses `postChargeToQbo` which creates either:
  - Sales Receipt (if posting strategy is 'sales-receipt')
  - Journal Entry (if posting strategy is 'journal-entry')
- Includes gross amount and fee amount
- Uses original transaction date
- Includes customer information if available

### Refunds
- Uses `postRefundToQbo` which creates a Journal Entry
- Debits refunds account
- Credits Stripe clearing account
- Uses original refund date

### Payouts
- Uses `postPayoutToQbo` which creates a Bank Deposit
- Moves funds from Stripe clearing to bank account
- Uses original payout date (created or arrival_date)

## Testing Recommendations

### Test Scenarios
1. **Dry Run Mode**: Test with `dryRun=true` to verify filtering without persisting data
2. **Failed Charges**: Verify failed charges are skipped
3. **Pending Refunds**: Verify pending refunds are skipped
4. **Cancelled Payouts**: Verify non-paid payouts are skipped
5. **Duplicate Prevention**: Run same date range twice, verify no duplicates
6. **Date Preservation**: Verify QBO entries have correct historic dates
7. **String vs Expanded Balance Transactions**: Test with both formats

### Test Commands

**Using PowerShell Script:**
```powershell
# Set the authentication token (required)
$env:STRIPE_TRUE_UP_TOKEN = "your-secret-token-here"

# Dry run for payments
.\scripts\test-true-up.ps1 -From "2024-01-01" -To "2024-01-31" -Type payments -DryRun $true -FunctionKey $functionKey

# Actual run for payments
.\scripts\test-true-up.ps1 -From "2024-01-01" -To "2024-01-31" -Type payments -DryRun $false -FunctionKey $functionKey

# Test refunds
.\scripts\test-true-up.ps1 -From "2024-01-01" -To "2024-01-31" -Type refunds -DryRun $true -FunctionKey $functionKey

# Test payouts
.\scripts\test-true-up.ps1 -From "2024-01-01" -To "2024-01-31" -Type payouts -DryRun $true -FunctionKey $functionKey
```

**Using cURL (Windows PowerShell):**
```powershell
# Set your function key
$functionKey = "your-function-key-here"

# Dry run
curl -X GET `
  "https://payment-processing-function.azurewebsites.net/api/stripe/true-up?from=2024-01-01&to=2024-01-31&type=payments&dryRun=true&code=$functionKey"

# Actual run
curl -X GET `
  "https://payment-processing-function.azurewebsites.net/api/stripe/true-up?from=2024-01-01&to=2024-01-31&type=payments&dryRun=false&code=$functionKey"

# Process only first 5 records and skip QBO posting
curl -X GET `
  "https://payment-processing-function.azurewebsites.net/api/stripe/true-up?from=2024-01-01&to=2024-01-31&type=payments&dryRun=false&limit=5&bypassQbo=true&code=$functionKey"
```

**Using cURL (Bash/Linux):**
```bash
# Set your function key
functionKey="your-function-key-here"

# Dry run
curl -X GET \
  "https://payment-processing-function.azurewebsites.net/api/stripe/true-up?from=2024-01-01&to=2024-01-31&type=payments&dryRun=true&code=$functionKey"

# Actual run
curl -X GET \
  "https://payment-processing-function.azurewebsites.net/api/stripe/true-up?from=2024-01-01&to=2024-01-31&type=payments&dryRun=false&code=$functionKey"

# Process only first 5 records and skip QBO posting
curl -X GET \
  "https://payment-processing-function.azurewebsites.net/api/stripe/true-up?from=2024-01-01&to=2024-01-31&type=payments&dryRun=false&limit=5&bypassQbo=true&code=$functionKey"
```

**Using Postman:**
1. Method: `GET`
2. URL: `https://payment-processing-function.azurewebsites.net/api/stripe/true-up`
3. Query Parameters:
   - `from`: `2024-01-01`
   - `to`: `2024-01-31`
   - `type`: `payments`
   - `dryRun`: `true`
  - `limit`: `5` (optional)
  - `bypassQbo`: `true` (optional)
   - `code`: `your-function-key-here`
```

## Summary of Changes

| Area | Previous Behavior | New Behavior |
|------|------------------|--------------|
| Charge Status | All charges processed | Only 'succeeded' charges processed |
| Refund Status | All refunds processed | Only 'succeeded' refunds processed |
| Payout Status | All payouts processed | Only 'paid' payouts processed |
| Balance Transaction | Assumed expanded object | Fetches if string ID |
| Duplicate Prevention | ✅ Already implemented | ✅ Enhanced with better logging |
| Date Preservation | ✅ Already implemented | ✅ Maintained |
| Idempotency Flush | Manual | Automatic after processing |
| Error Logging | Basic | Detailed with status info |

## Migration Notes

### Existing Data
- Re-running true-up on already processed data is safe due to idempotency
- However, previously processed failed/pending transactions won't be retroactively removed
- Consider manual cleanup if needed

### Configuration
No configuration changes required. All improvements are backward compatible.

### Monitoring
Enhanced logging allows better monitoring of:
- How many transactions are skipped due to status
- Balance transaction retrieval failures
- Processing success rates by status

## Future Enhancements

Consider these potential improvements:
1. Add support for filtering by specific Stripe status codes
2. Add batch processing with configurable batch sizes
3. Add webhook-based incremental sync as alternative to full true-up
4. Add reconciliation report showing differences between Stripe and QBO
5. Add support for dispute transactions in true-up process
