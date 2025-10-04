# Payout Amount Conversion Fix

## Issue Summary

When processing Stripe `payout.paid` webhooks, journal entries were being created in QuickBooks Online with incorrect amounts. For example, a $65.00 payout would appear as $6500.00 in QuickBooks.

**Root Cause:** Stripe API returns all monetary amounts in the smallest currency unit (cents for USD). The code was passing these cent values directly to QuickBooks, which expects amounts in dollars.

## Example of the Problem

### Before the Fix
- Stripe payout amount: `6500` (cents, representing $65.00)
- Amount sent to QuickBooks: `6500.00` (dollars - WRONG!)
- QuickBooks displays: **$6500.00** ❌

### After the Fix
- Stripe payout amount: `6500` (cents, representing $65.00)
- Amount sent to QuickBooks: `65.00` (dollars - CORRECT!)
- QuickBooks displays: **$65.00** ✅

## Changes Made

Updated `/services/accounting/quickbooksProvider.js` to convert amounts from cents to dollars before sending to QuickBooks:

### 1. Journal Entries (Line 184)
```javascript
// Before:
Amount: line.amount.toFixed(2)

// After:
Amount: (line.amount / 100).toFixed(2) // Convert cents to dollars
```

### 2. Transfers (Line 290)
```javascript
// Before:
Amount: transfer.amount.toFixed(2)

// After:
Amount: (transfer.amount / 100).toFixed(2) // Convert cents to dollars
```

### 3. Deposits (Line 382)
```javascript
// Before:
Amount: line.amount.toFixed(2)

// After:
Amount: (line.amount / 100).toFixed(2) // Convert cents to dollars
```

### 4. Return Values
Since the rest of the application expects amounts in cents, we also updated the return values to convert QuickBooks amounts (in dollars) back to cents:

```javascript
// Before:
amount: parseFloat(created.Amount)

// After:
amount: Math.round(parseFloat(created.Amount) * 100) // Convert dollars back to cents
```

### 5. Validation and Logging
Updated validation tolerance and logging to work with cents internally but display amounts in dollars:

```javascript
// Validation tolerance: 1 cent instead of 0.01 cents
if (Math.abs(totalDebits - totalCredits) > 1) { // Allow 1 cent tolerance

// Logging: Show amounts in dollars for clarity
this.logger.log(`[QBO] Journal entry has ${journalEntry.lines.length} lines, debits=$${(totalDebits / 100).toFixed(2)}, credits=$${(totalCredits / 100).toFixed(2)}`);
```

## Currency Handling Strategy

The application now follows a consistent pattern:

1. **Internal Storage (cents)**: All amounts within the application are stored in cents
   - Matches Stripe API format
   - Avoids floating-point precision issues
   - Consistent with CRM integration (Salesforce expects cents)

2. **QuickBooks Integration (dollars)**: Amounts are converted to dollars only when:
   - Sending data to QuickBooks API (divide by 100)
   - Receiving data from QuickBooks API (multiply by 100)

3. **Display (dollars)**: Logs show amounts in dollars for human readability

## Testing

Added comprehensive test coverage in `tests/amountConversion.test.js`:

```
✅ Journal entry: $65 (6500 cents) → 65 dollars sent to QBO
✅ Transfer: $50 (5000 cents) → 50 dollars sent to QBO
✅ Deposit: $15 (1500 cents) → 15 dollars sent to QBO
✅ Realistic payout: Charges=$65.00, Fees=$3.41 correctly sent to QBO
   Before fix: Would have been $6500 and $341
```

All existing tests continue to pass:
- ✅ 15/15 QuickBooks Provider tests
- ✅ 3/3 Journal Entry Creation tests
- ✅ All integration tests

## Impact

This fix ensures:
1. **Correct amounts in QuickBooks**: Payout journal entries now show the correct dollar amounts
2. **Accurate accounting records**: Financial statements will reflect actual transaction values
3. **No breaking changes**: Internal API contracts remain unchanged (amounts still in cents)
4. **Consistent behavior**: Matches the pattern used in other parts of the system (e.g., CRM integration)

## CRM Payout Records

The CRM integration was already correctly handling amounts in cents. The Salesforce CRM code converts cents to dollars when creating payout records:

```javascript
// services/crm/salesforceCrm.js (already correct)
Amount__c: amount / 100, // Convert cents to dollars
Charge_Amount__c: summary.charges.grossAmount / 100,
Refund_Amount__c: summary.refunds.amount / 100,
Fee_Amount__c: (summary.fees.stripe.amount + summary.fees.application.amount) / 100,
```

If payout records are not appearing in the CRM, possible causes include:
1. CRM service not configured (check environment variables)
2. CRM object/custom fields not created in Salesforce
3. Permissions/authentication issues

Check logs for:
- `[PayoutSync] CRM service not configured` - CRM is disabled
- `[PayoutSync] Failed to create CRM payout record` - Configuration or API error
- `[PayoutSync] Created CRM payout record` - Success

## Deployment Notes

No data migration required. Existing journal entries in QuickBooks with incorrect amounts will need to be manually corrected or deleted and recreated by re-running the payout sync.

## References

- Stripe API: https://stripe.com/docs/api/payouts
- QuickBooks API: https://developer.intuit.com/app/developer/qbo/docs/api/accounting/all-entities/journalentry
- node-quickbooks: https://github.com/mcohen01/node-quickbooks
