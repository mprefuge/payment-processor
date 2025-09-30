# Failed and Canceled Transaction Support

## Overview

This update adds support for handling failed and canceled payments by updating pending transactions in the CRM to reflect the appropriate status when a payment fails or is canceled.

## Problem Statement

Previously, when a payment failed or was canceled, the pending transaction in the CRM would remain in "Pending" status indefinitely. This didn't accurately reflect the actual state of the payment.

## Solution

Added webhook event handlers for:
- `payment_intent.payment_failed` - Updates pending transactions to "Failed" status
- `payment_intent.canceled` - Updates pending transactions to "Canceled" status

## Changes Made

### 1. Webhook Event Handlers (`stripeWebhook/index.js`)

#### Added `processPaymentFailure` Function
Handles the `payment_intent.payment_failed` webhook event:
- Checks if a pending transaction exists for the payment intent
- Updates the transaction status to "Failed" if it's in "Pending" status
- Logs the status change
- Skips updates for non-pending transactions

#### Added `processPaymentCanceled` Function
Handles the `payment_intent.canceled` webhook event:
- Checks if a pending transaction exists for the payment intent
- Updates the transaction status to "Canceled" if it's in "Pending" status
- Logs the status change
- Skips updates for non-pending transactions

#### Updated Event Switch Statement
Added two new cases to handle the new webhook events:
```javascript
case 'payment_intent.payment_failed':
    await processPaymentFailure(context, event.data.object);
    break;

case 'payment_intent.canceled':
    await processPaymentCanceled(context, event.data.object);
    break;
```

### 2. CRM Service Updates (`services/crm/salesforceCrm.js`)

Added "Canceled" status mapping for Salesforce Opportunities:
```javascript
else if (stageName === 'Canceled') {
    stageName = 'Closed Lost';
}
```

This ensures that when using Salesforce Opportunities (fallback when custom Transaction object is not available), the "Canceled" status is properly mapped to "Closed Lost" stage.

### 3. New Tests (`tests/failedCanceledTransactions.test.js`)

Created comprehensive test suite with 4 tests:
1. **Failed payment updates pending transaction to Failed status** - Verifies that a pending transaction is properly updated to "Failed" when payment fails
2. **Canceled payment updates pending transaction to Canceled status** - Verifies that a pending transaction is properly updated to "Canceled" when payment is canceled
3. **Non-pending transaction is not updated on failure** - Ensures completed transactions are not affected by failure events
4. **Multiple transactions can have different statuses** - Validates that the system supports all transaction statuses (Pending, Failed, Canceled, Completed)

All tests pass ✅

## Transaction Status Flow

### Normal Flow (Success)
```
1. User completes checkout
   ↓
2. checkout.session.completed fires
   - Creates transaction with Status: "Pending"
   ↓
3. payment_intent.succeeded fires
   - Updates transaction to Status: "Completed" ✅
```

### Failed Payment Flow (NEW)
```
1. User completes checkout
   ↓
2. checkout.session.completed fires
   - Creates transaction with Status: "Pending"
   ↓
3. payment_intent.payment_failed fires
   - Updates transaction to Status: "Failed" ❌
```

### Canceled Payment Flow (NEW)
```
1. User completes checkout
   ↓
2. checkout.session.completed fires
   - Creates transaction with Status: "Pending"
   ↓
3. payment_intent.canceled fires
   - Updates transaction to Status: "Canceled" 🚫
```

## Supported Transaction Statuses

| Status | Description | Salesforce Opportunity Mapping |
|--------|-------------|-------------------------------|
| Pending | Payment initiated but not completed | Prospecting |
| Completed | Payment succeeded | Closed Won |
| Failed | Payment failed | Closed Lost |
| Canceled | Payment canceled | Closed Lost |

## Implementation Details

### Error Handling
Both new functions include try-catch blocks and:
- Log errors without throwing to prevent webhook failures
- Check for CRM configuration before processing
- Only update transactions that are in "Pending" status
- Handle both Transaction__c (custom) and Opportunity (standard) objects

### Backward Compatibility
- ✅ No breaking changes
- ✅ Works with existing transaction flow
- ✅ All existing tests still pass
- ✅ No configuration changes required
- ✅ No schema changes required

### Stripe Webhook Configuration

To receive these events, ensure the following webhook events are enabled in your Stripe dashboard:
- `payment_intent.succeeded` (already configured)
- `payment_intent.payment_failed` (NEW - add this)
- `payment_intent.canceled` (NEW - add this)
- `checkout.session.completed` (already configured)

## Benefits

1. **Accurate Transaction Status** - CRM reflects the actual state of payments
2. **Better Reporting** - Can track failed and canceled payments separately
3. **Improved Visibility** - See which payments failed vs were canceled
4. **Data Integrity** - No more perpetually pending transactions
5. **Audit Trail** - Complete history of all payment attempts

## Testing

Run the test suite:
```bash
node tests/failedCanceledTransactions.test.js
```

All tests pass:
```
✅ Failed payments properly update pending transactions
✅ Canceled payments properly update pending transactions
✅ Completed transactions are not affected by failure events
✅ Multiple transaction statuses are supported
```

## Migration

### No Action Required ✅

This change is:
- ✅ Backward compatible
- ✅ No schema changes needed
- ✅ No configuration changes needed
- ✅ Works with existing CRM setup

The system will automatically:
- ✅ Update pending transactions when payments fail
- ✅ Update pending transactions when payments are canceled
- ✅ Leave completed transactions unchanged
- ✅ Handle all webhook events properly

### Recommended: Enable New Webhook Events

In your Stripe dashboard:
1. Go to **Developers** → **Webhooks**
2. Select your webhook endpoint
3. Add these events if not already enabled:
   - `payment_intent.payment_failed`
   - `payment_intent.canceled`

## Files Modified

```
 services/crm/salesforceCrm.js            |   2 +
 stripeWebhook/index.js                   |  92 +++++++++++++++++++++
 tests/failedCanceledTransactions.test.js | 309 +++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++
 3 files changed, 403 insertions(+)
```

## Related Documentation

- [TRANSACTION_LIFECYCLE.md](TRANSACTION_LIFECYCLE.md) - See "Future Enhancements" section (item #1)
- [TRANSACTION_STATUS_FLOW.md](TRANSACTION_STATUS_FLOW.md) - Transaction status update patterns
- [FIX_PENDING_UPDATE.md](FIX_PENDING_UPDATE.md) - How pending transactions are updated
