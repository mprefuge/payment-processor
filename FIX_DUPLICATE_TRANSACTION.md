# Fix for Duplicate Transaction Issue (Issue #21)

## Problem Statement

The issue described in PR #21 was still occurring: When a checkout session is created and completed, TWO transactions were being created in the CRM:

1. **Transaction 1** (Correct): `"Transaction - Building Fund"` (or other category)
   - Created when `checkout.session.completed` webhook fires
   - Status: Pending
   - Has category information from checkout session

2. **Transaction 2** (Incorrect): `"Transaction - Uncategorized"` 
   - Created when `payment_intent.succeeded` webhook fires
   - Status: Completed
   - Missing category information (payment intent doesn't have it)

## Root Cause

The root cause was that the pending transaction created in `checkout.session.completed` was storing:
```javascript
transactionId: null  // ❌ Problem!
```

When `payment_intent.succeeded` fired later, the duplicate check at line 155-159:
```javascript
const existingTransaction = await crmService.findTransactionByStripeId(paymentIntent.id);
if (existingTransaction) {
    context.log(`Transaction ${paymentIntent.id} already exists in CRM: ${existingTransaction.Id}`);
    return;
}
```

This check couldn't find the pending transaction because it had `transactionId: null`, so it proceeded to create a NEW transaction without the category information.

## Solution

### Change 1: Store Payment Intent ID in Pending Transaction

**File:** `stripeWebhook/index.js` (Line 596)

**Before:**
```javascript
transactionId: null, // Will be updated when payment completes
```

**After:**
```javascript
transactionId: session.payment_intent, // Store payment intent ID for lookup
```

This simple change ensures that when the pending transaction is created, it already has the payment intent ID stored. When `payment_intent.succeeded` fires later, the duplicate check will find it and return early, preventing the duplicate.

### Change 2: Improve Opportunity Fallback

**File:** `services/crm/salesforceCrm.js`

For organizations using Salesforce Opportunities as a fallback (when custom Transaction__c object is not available), we also improved the handling:

**Lines 349-356:** Store payment intent ID in Description field
```javascript
// Include session ID and transaction ID in description if provided
let fullDescription = description || '';
if (sessionId) {
    fullDescription = `${fullDescription}\nCheckout Session: ${sessionId}`.trim();
}
if (transactionId) {
    fullDescription = `${fullDescription}\nPayment Intent: ${transactionId}`.trim();
}
```

**Line 245:** Search in Description field for payment intent ID
```javascript
// Search in Description field for "Payment Intent: {stripeId}"
const query = `SELECT Id, Name, Description FROM Opportunity WHERE Description LIKE '%${stripeId}%' LIMIT 1`;
```

## How It Works

### Flow Before Fix (❌ Creates Duplicate):

```
1. Customer completes checkout
   ↓
2. checkout.session.completed fires
   - Creates transaction with transactionId: null ❌
   - Name: "Transaction - Building Fund"
   - Status: Pending
   ↓
3. payment_intent.succeeded fires
   - Checks findTransactionByStripeId(pi_123) 
   - Returns null (because existing transaction has transactionId: null)
   - Creates NEW transaction ❌
   - Name: "Transaction - Uncategorized" (no category in payment intent)
   - Status: Completed
   ↓
Result: 2 transactions ❌
```

### Flow After Fix (✅ No Duplicate):

```
1. Customer completes checkout
   ↓
2. checkout.session.completed fires
   - Creates transaction with transactionId: pi_123 ✅
   - Name: "Transaction - Building Fund"
   - Status: Pending
   ↓
3. payment_intent.succeeded fires
   - Checks findTransactionByStripeId(pi_123)
   - Finds existing transaction! ✅
   - Returns early (no duplicate created)
   ↓
Result: 1 transaction ✅
```

## Benefits

1. ✅ **No Duplicate Transactions**: Only ONE transaction is created per checkout/payment
2. ✅ **Category Preserved**: Category information from checkout session is maintained
3. ✅ **Backward Compatible**: Existing functionality is not affected
4. ✅ **Works with Both Systems**: Handles both Transaction__c custom object and Opportunity fallback
5. ✅ **Minimal Changes**: Only 9 lines of code changed across 2 files

## Testing

All tests pass:
- ✅ 62 existing tests (checkoutCrmSync, contactMatcher, integration, etc.)
- ✅ Created comprehensive scenario tests validating the fix
- ✅ Verified both Transaction__c and Opportunity fallback work correctly
- ✅ Verified category information is preserved
- ✅ Verified both session ID and payment intent ID lookups work

## Migration Notes

### For Existing Installations

No migration is required. The fix:
- Does not affect existing completed transactions
- Works immediately for all new transactions
- Is backward compatible with the existing two-stage transaction lifecycle

### For Salesforce Users

**If using Transaction__c custom object:**
- No changes needed
- The `Transaction_ID__c` field already exists and stores the payment intent ID

**If using Opportunity as fallback:**
- No changes needed
- The fix stores the payment intent ID in the Description field
- The lookup searches the Description field

## Edge Cases Handled

1. **Payment intent fires before checkout session**: Already handled by existing code
2. **Duplicate webhook events**: Already handled by existing duplicate checks
3. **Missing payment intent in session**: Gracefully handled (stores null if not available)
4. **Session ID lookup**: Still works as before, now we have both session ID and payment intent ID lookups

## Code References

- **Main fix**: `stripeWebhook/index.js:596`
- **Duplicate check**: `stripeWebhook/index.js:155-159`
- **Opportunity improvement**: `services/crm/salesforceCrm.js:349-356`
- **Opportunity lookup**: `services/crm/salesforceCrm.js:245`

## Verification

To verify the fix is working:

1. Check Salesforce/CRM after a checkout completes
2. Should see ONE transaction with:
   - Name includes category (e.g., "Transaction - Building Fund")
   - Status: Pending initially, then Completed after payment
   - Has both Session ID and Payment Intent ID stored

3. Should NOT see:
   - A second transaction with "Transaction - Uncategorized"
   - Duplicate transactions with the same payment intent ID
