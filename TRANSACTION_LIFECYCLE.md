# Transaction Lifecycle Changes

## Overview

This document describes the changes made to support creating transactions at checkout with "Pending" status and completing them when payment succeeds.

## Problem Statement

Previously, transactions were only created when the `payment_intent.succeeded` webhook event fired. This meant:
1. No transaction record existed while payment was being processed
2. If the webhook failed or was delayed, there was no record of the attempted transaction
3. Transaction timing didn't align with when the customer initiated checkout

## Solution

The system now creates transactions in two stages:

### Stage 1: Checkout Session Completed
When `checkout.session.completed` event fires:
1. Creates a transaction record with status `"Pending"`
2. Stores all available information from the checkout session:
   - Category from metadata or product name
   - Amount and currency
   - Customer contact information
   - Checkout session ID for future lookup
3. Associates with or creates a contact in the CRM
4. Transaction has no payment intent ID yet (since payment hasn't completed)

### Stage 2: Payment Intent Succeeded
When `payment_intent.succeeded` event fires:
1. Looks up the checkout session ID from the payment intent
2. Searches for existing pending transaction by session ID
3. If found, updates the pending transaction to:
   - Status: `"Completed"`
   - Payment method: Determined from the payment intent
   - Transaction ID: Stripe payment intent ID
4. If no pending transaction found (backward compatibility):
   - Creates a new completed transaction as before
   - This handles cases where checkout.session.completed didn't fire

## Technical Changes

### New CRM Service Methods

Added to `BaseCrmService` interface and implemented in `SalesforceCrmService`:

```javascript
/**
 * Update an existing transaction record in the CRM
 * @param {string} transactionId - ID of the transaction to update
 * @param {Object} transactionData - Transaction information to update
 * @returns {Promise<Object>} Updated transaction object
 */
async updateTransaction(transactionId, transactionData)

/**
 * Find a transaction by checkout session ID
 * @param {string} sessionId - Stripe checkout session ID
 * @returns {Promise<Object|null>} Existing transaction or null if not found
 */
async findTransactionBySessionId(sessionId)
```

### Salesforce Schema Changes (Optional)

For custom Transaction__c object, add a new field:
- **Session_ID__c** (Text, 255): Stores the Stripe checkout session ID

If using Opportunity as fallback, the session ID is stored in the Description field.

### Modified Functions

#### `processCheckoutSessionCompleted()`
- Now creates pending transactions when CRM is configured
- Includes duplicate protection (checks if transaction already exists for session)
- Performs contact matching and creates/associates contacts
- Stores category and all transaction metadata from checkout session

#### `processPaymentSuccess()`
- Now checks for pending transactions before creating new ones
- Retrieves checkout session ID from payment intent
- Updates pending transaction if found
- Falls back to creating new transaction if no pending one exists

#### `prepareTransactionDataFromSession()` (New Helper)
- Extracts transaction data from checkout session
- Normalizes category and generates transaction name
- Handles customer information extraction
- Shared logic for consistent transaction preparation

## Flow Diagrams

### Normal Flow (CRM Configured)
```
Customer completes checkout
    ↓
checkout.session.completed event fires
    ↓
System creates PENDING transaction in CRM
    ↓
Customer's payment is processed
    ↓
payment_intent.succeeded event fires
    ↓
System finds pending transaction by session ID
    ↓
System updates transaction to COMPLETED
```

### Backward Compatible Flow (No Checkout Event)
```
Customer completes checkout
    ↓
(checkout.session.completed event missed/failed)
    ↓
Customer's payment is processed
    ↓
payment_intent.succeeded event fires
    ↓
System searches for pending transaction
    ↓
Not found → Creates new COMPLETED transaction
```

### No CRM Flow
```
Customer completes checkout
    ↓
checkout.session.completed event fires
    ↓
System skips transaction creation (no CRM)
    ↓
payment_intent.succeeded event fires
    ↓
System skips transaction creation (no CRM)
```

## Duplicate Event Protection

The system handles duplicate webhook events:

1. **Duplicate checkout.session.completed**: 
   - Checks if transaction already exists for session ID
   - Skips creation if found

2. **Duplicate payment_intent.succeeded**:
   - Checks if transaction already exists with payment intent ID
   - Skips processing if found

## Benefits

1. **Early Transaction Capture**: Transaction exists from the moment checkout completes
2. **Better Tracking**: Can track pending vs completed transactions
3. **Resilience**: If payment webhook fails, pending transaction shows checkout occurred
4. **Backward Compatible**: Works with older flows that don't have checkout events
5. **Status Visibility**: CRM users can see which transactions are pending payment

## Testing

See `/tmp/test-transaction-flow.js` for validation tests covering:
- Normal flow (checkout → payment_intent)
- Direct payment (no checkout session)
- Duplicate event protection

## Migration Notes

### Existing Installations
- No migration required
- New transactions will use the two-stage flow
- Existing completed transactions are unaffected

### Salesforce Setup
- **Recommended**: Add `Session_ID__c` field to Transaction__c object
- **Alternative**: System falls back to Description field for Opportunity objects
- If field doesn't exist, system still works but can't find pending transactions

### Configuration
- No new environment variables required
- CRM_PROVIDER must be set for pending transaction creation
- Works with existing CRM configuration

## Future Enhancements

Potential improvements:
1. Add failed payment handling to update pending transactions to "Failed" status
2. Add timeout logic to mark pending transactions as "Expired" after X hours
3. Add webhook event for abandoned checkouts to mark as "Abandoned"
4. Support partial payments (installments)
