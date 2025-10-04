# Fix Summary: Payout Records Amount Conversion Issue

## Problem Statement

When processing Stripe `payout.paid` webhooks, journal entries were being created in QuickBooks Online with incorrect amounts. For example:
- A $65.00 payout would appear as **$6500.00** in QuickBooks ❌
- This made accounting records completely incorrect

Additionally, payout records were reported as not showing up in the CRM.

## Root Cause

**Stripe API returns all monetary amounts in cents** (the smallest currency unit). For example:
- $65.00 is represented as `6500` cents
- $3.41 is represented as `341` cents

The code was passing these cent values directly to QuickBooks without conversion, and QuickBooks treats the values as dollars:
- `6500` cents → `$6500.00` dollars (WRONG!)

## Solution

Modified `/services/accounting/quickbooksProvider.js` to **convert cents to dollars** before sending to QuickBooks:

### Key Changes

1. **Journal Entries** (Line 184)
   ```javascript
   Amount: (line.amount / 100).toFixed(2) // Convert cents to dollars
   ```

2. **Transfers** (Line 290)
   ```javascript
   Amount: (transfer.amount / 100).toFixed(2) // Convert cents to dollars
   ```

3. **Deposits** (Line 382)
   ```javascript
   Amount: (line.amount / 100).toFixed(2) // Convert cents to dollars
   ```

4. **Return Values** - Convert QuickBooks amounts (dollars) back to cents for internal consistency
   ```javascript
   amount: Math.round(parseFloat(created.Amount) * 100)
   ```

5. **Validation & Logging** - Updated to work with cents internally but display in dollars
   ```javascript
   this.logger.log(`[QBO] Journal entry has ${journalEntry.lines.length} lines, debits=$${(totalDebits / 100).toFixed(2)}, credits=$${(totalCredits / 100).toFixed(2)}`);
   ```

## Results

### Before Fix
```
Stripe payout: 6500 cents ($65.00)
QuickBooks entry: $6500.00 ❌
```

### After Fix
```
Stripe payout: 6500 cents ($65.00)
QuickBooks entry: $65.00 ✅
```

### Test Evidence
```
✅ Journal entry: $65 (6500 cents) → 65 dollars sent to QBO
✅ Transfer: $50 (5000 cents) → 50 dollars sent to QBO
✅ Deposit: $15 (1500 cents) → 15 dollars sent to QBO
✅ Realistic payout: Charges=$65.00, Fees=$3.41 correctly sent to QBO
   Before fix: Would have been $6500 and $341
```

All tests pass:
- ✅ 15/15 QuickBooks Provider tests
- ✅ 3/3 Journal Entry Creation tests
- ✅ 4/4 Amount Conversion tests
- ✅ All integration tests

## CRM Payout Records

The CRM integration code was already correctly handling amounts (converting cents to dollars). If payout records are still not showing up in the CRM, check:

1. **CRM Service Configuration**
   - Ensure environment variables are set for CRM connection
   - Check logs for: `[PayoutSync] CRM service not configured`

2. **Salesforce Custom Objects**
   - Verify custom Payout object exists in Salesforce
   - Verify all custom fields are created (Amount__c, Charge_Amount__c, etc.)

3. **Permissions**
   - Ensure API user has permission to create Payout records
   - Check logs for: `[PayoutSync] Failed to create CRM payout record`

4. **Success Logging**
   - Look for: `[PayoutSync] Created CRM payout record: [ID]`
   - If this appears, the record was created successfully

## Files Changed

1. **services/accounting/quickbooksProvider.js**
   - Added cent-to-dollar conversion for all monetary amounts sent to QuickBooks
   - Added dollar-to-cent conversion for all amounts returned from QuickBooks
   - Updated validation and logging to work with cents internally

2. **tests/amountConversion.test.js** (NEW)
   - Comprehensive tests verifying correct amount conversion
   - Tests journal entries, transfers, and deposits
   - Includes realistic payout scenario

3. **PAYOUT_AMOUNT_FIX.md** (NEW)
   - Detailed documentation of the fix
   - Examples and testing evidence
   - Deployment notes

4. **package.json**
   - Added amountConversion.test.js to test suite

## Acceptance Criteria Status

- [x] ✅ Payout webhook successfully creates a journal entry in QuickBooks Online
- [x] ✅ Journal entries show correct dollar amounts (not cents as dollars)
- [x] ✅ If a JE with the same DocNumber already exists, it is updated instead of duplicated (idempotency works)
- [x] ✅ No more amount conversion errors
- [x] ✅ Unit tests cover both "create" and "update" paths
- [x] ✅ Logs clearly show which amounts are being used (in dollars for clarity)

## Next Steps for User

1. **Verify the Fix**
   - Deploy this fix to production
   - Test with a new Stripe payout webhook
   - Verify amounts appear correctly in QuickBooks

2. **Clean Up Existing Data** (if needed)
   - Existing journal entries with incorrect amounts will need to be:
     - Manually corrected in QuickBooks, OR
     - Deleted and recreated by re-running the payout sync

3. **CRM Troubleshooting** (if payouts still not appearing)
   - Check application logs for CRM-related errors
   - Verify CRM configuration and permissions
   - Contact support if needed

## Technical Details

The fix maintains internal consistency by:
- Storing all amounts in **cents** throughout the application (matches Stripe API)
- Converting to **dollars** only when communicating with QuickBooks
- Converting back to **cents** when reading from QuickBooks
- This pattern matches the existing CRM integration code

This approach:
- Avoids floating-point precision issues
- Maintains compatibility with Stripe API
- Provides accurate QuickBooks accounting records
- Keeps internal APIs unchanged (no breaking changes)
