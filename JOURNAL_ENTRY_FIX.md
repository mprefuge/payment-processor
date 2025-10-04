# QuickBooks Journal Entry Creation Fix

## Problem Summary

When processing a Stripe `payout.paid` webhook, the system attempted to create a journal entry in QuickBooks Online but failed with two critical validation errors:

### Error 1: DocNumber Too Long
```
Error: String length is either shorter or longer than supported by specification
Detail: String length specified does not match the supported length. Min:0 Max:21 supported. Supplied length:45
Element: DocNumber
```

**Example:**
- Original DocNumber: `STRIPE-default-po_1RQI4lBS5xFjv3JBSDz6mGVY-JE` (45 characters)
- QuickBooks Maximum: 21 characters

### Error 2: Missing AccountRef Values
```
Error: Required param missing, need to supply the required value for the API
Detail: Required parameter AccountRef is missing in the request
Element: AccountRef
```

Journal entry lines had empty `AccountRef` objects because `accountId` was not being set.

---

## Root Causes

### 1. DocNumber Generation
The original DocNumber format included the full payout ID:
```javascript
const docNumber = `STRIPE-${accountPrefix}-${payout.id}-JE`;
// Example: STRIPE-default-po_1RQI4lBS5xFjv3JBSDz6mGVY-JE (45 chars)
```

This exceeded QuickBooks' 21-character limit for the `DocNumber` field.

### 2. Missing Account ID Mapping
The `postToAccounting` method in `payoutSyncService.js` passed journal entry lines directly to the QuickBooks provider without mapping account names to account IDs:

```javascript
// Before (incorrect):
result = await this.accountingProvider.upsertJournalEntry({
    docNumber: doc.docNumber,
    date: doc.date,
    memo: doc.memo,
    lines: doc.lines,  // Lines only had accountName, not accountId
    // ...
});
```

The journal entry lines only contained `accountName`, but the QuickBooks provider expected `accountId` on each line:

```javascript
// QuickBooks provider expected:
Line: journalEntry.lines.map((line, index) => ({
    // ...
    JournalEntryLineDetail: {
        PostingType: line.type === 'debit' ? 'Debit' : 'Credit',
        AccountRef: {
            value: line.accountId  // Required but was undefined!
        }
    }
}))
```

---

## Solutions Implemented

### 1. Short DocNumber Generation

Created a hash-based DocNumber generator that keeps DocNumbers under 21 characters while maintaining uniqueness:

```javascript
/**
 * Generate a shortened DocNumber that fits QuickBooks 21-character limit
 * Uses hash of payout ID to ensure uniqueness while staying short
 */
_generateShortDocNumber(payoutId, suffix) {
    const crypto = require('crypto');
    
    // Create hash of payout ID (first 10 chars of hex)
    const hash = crypto.createHash('sha256')
        .update(payoutId)
        .digest('hex')
        .substring(0, 10);
    
    // Format: ST-{hash}-{suffix}
    // Example: ST-283ec7749e-JE (16 chars, well under 21 char limit)
    return `ST-${hash}-${suffix}`;
}
```

**Examples:**
- Journal Entry: `ST-283ec7749e-JE` (16 characters)
- Transfer: `ST-283ec7749e-XF` (16 characters)
- Deposit: `ST-283ec7749e-DP` (16 characters)

The original full DocNumber is preserved in the document metadata as `fullDocNumber` for reference and debugging.

### 2. Account Mapping and Chart of Accounts Initialization

Updated `postToAccounting` to ensure accounts exist and map account names to IDs before creating journal entries:

```javascript
async postToAccounting(postingInstructions) {
    // 1. Collect all unique account names from journal entry lines
    const accountsToEnsure = new Set();
    for (const doc of postingInstructions.documents) {
        if (doc.type === 'journal') {
            doc.lines.forEach(line => {
                if (line.accountName) {
                    accountsToEnsure.add(line.accountName);
                }
            });
        }
    }

    // 2. Ensure all accounts exist in QuickBooks and get their IDs
    const accountMap = {};
    if (accountsToEnsure.size > 0) {
        const accountList = Array.from(accountsToEnsure).map(name => ({
            name,
            type: this._getAccountType(name),
            subType: this._getAccountSubType(name)
        }));

        const mappedAccounts = await this.accountingProvider.ensureChartOfAccounts(accountList);
        Object.assign(accountMap, mappedAccounts);
    }

    // 3. Map account names to IDs when creating journal entries
    for (const doc of postingInstructions.documents) {
        if (doc.type === 'journal') {
            const linesWithAccountIds = doc.lines.map(line => ({
                ...line,
                accountId: accountMap[line.accountName]
            }));

            result = await this.accountingProvider.upsertJournalEntry({
                docNumber: doc.docNumber,
                date: doc.date,
                memo: doc.memo,
                lines: linesWithAccountIds,  // Now includes accountId
                // ...
            });
        }
    }
}
```

### 3. Improved Error Handling

Enhanced error handling in the QuickBooks provider to properly extract and report validation errors:

```javascript
catch (error) {
    this.logger.error('[QBO] Error upserting journal entry:', error);
    
    // Extract error message from Fault if present
    let errorMessage = error.message;
    if (error.Fault && error.Fault.Error && Array.isArray(error.Fault.Error)) {
        const errors = error.Fault.Error.map(e => `${e.Message}: ${e.Detail || ''}`).join('; ');
        errorMessage = errors;
    }
    
    throw new Error(`Failed to upsert journal entry: ${errorMessage}`);
}
```

This provides clear error messages that include the specific validation failures from QuickBooks.

---

## Testing

### Unit Tests

Created comprehensive integration test (`tests/journalEntryCreation.test.js`) that validates:

1. **Complete payout sync flow** - Creates a journal entry with proper DocNumber and AccountRef values
2. **DocNumber validation** - Rejects DocNumbers longer than 21 characters
3. **AccountRef validation** - Rejects journal entries with missing account IDs

### Test Results

```
✅ Complete payout sync flow with journal entry creation
   - DocNumber: ST-283ec7749e-JE (16 chars)
   - Accounts created: 3
   - Journal entry lines: 4
   - All lines have AccountRef: YES

✅ DocNumber validation - correctly rejects long DocNumbers
✅ AccountRef validation - correctly rejects missing AccountRef

Tests passed: 3
Tests failed: 0
```

All existing tests continue to pass:
- ✅ 15/15 QuickBooks Provider tests
- ✅ 9/9 Payout Sync tests
- ✅ All other integration tests

---

## Impact

### Before the Fix
❌ Payout webhooks failed with validation errors:
- DocNumber too long (45 chars > 21 char limit)
- Missing AccountRef on journal entry lines
- No journal entries created in QuickBooks
- Webhooks marked as "Succeeded" but accounting not updated

### After the Fix
✅ Payout webhooks successfully create journal entries:
- DocNumber fits within 21-character limit (16 chars)
- All journal entry lines have proper AccountRef values
- Accounts automatically created if they don't exist
- Full idempotency maintained through hash-based DocNumbers
- Clear error messages for any validation failures

---

## Verification

To verify the fix works in production:

1. **Check the logs** for a successful payout webhook:
   ```
   [PayoutSync] Ensured 3 accounts
   [QBO] Created account: Stripe Clearing (ID: account-1)
   [QBO] Created account: Revenue (ID: account-2)
   [QBO] Created account: Stripe Fees (ID: account-3)
   [QBO] Upserting journal entry: ST-283ec7749e-JE
   [QBO] Created journal entry: ST-283ec7749e-JE (ID: je-1)
   [PayoutSync] Posted journal: je-1
   ```

2. **In QuickBooks**, verify:
   - Journal entry exists with DocNumber like `ST-283ec7749e-JE`
   - All required accounts exist (Stripe Clearing, Revenue, Stripe Fees, etc.)
   - Journal entry lines are balanced (debits = credits)
   - Each line has an account assigned

3. **For subsequent payouts** with the same payout ID:
   ```
   [QBO] Journal entry already exists: ST-283ec7749e-JE (ID: je-1)
   ```
   Confirms idempotency is working correctly.

---

## Files Modified

1. **services/payoutSyncService.js**
   - Added `_generateShortDocNumber()` method
   - Updated `postToAccounting()` to ensure chart of accounts and map account IDs
   - Added `_getAccountType()` and `_getAccountSubType()` helper methods

2. **services/accounting/quickbooksProvider.js**
   - Improved error handling to extract QuickBooks validation errors

3. **tests/payoutSync.test.js**
   - Added `ensureChartOfAccounts()` method to mock provider

4. **tests/journalEntryCreation.test.js** (new)
   - Comprehensive integration test for journal entry creation
   - Validates DocNumber length constraints
   - Validates AccountRef requirements

5. **package.json**
   - Added new test to test suite

---

## Backwards Compatibility

✅ **Fully backwards compatible:**
- Existing journal entries remain accessible via their original DocNumbers
- Hash function is deterministic - same payout ID always generates same DocNumber
- Idempotency preserved through DocNumber-based lookups
- All existing tests continue to pass

---

## Future Improvements

1. **DocNumber Collision Detection**: While SHA-256 hash collisions are astronomically unlikely, could add collision detection and retry logic

2. **Custom DocNumber Format**: Could make the format configurable via environment variables for different accounting preferences

3. **Account Type Configuration**: Currently uses heuristics to determine account types - could make this configurable

4. **Enhanced Logging**: Add structured logging for better debugging and monitoring in production
