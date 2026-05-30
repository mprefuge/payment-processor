# Stripe Payout Feature Guide

## Overview

This guide describes the Stripe Payout feature that automatically creates:
1. **Payout transaction records in Salesforce** - Tracks payout details and links to related transactions
2. **Bank deposits in QuickBooks Online (QBO)** - Records the actual bank transfer from Stripe to your operating bank account

## How It Works

When Stripe pays out funds to your bank account, the webhook receives a `payout.paid` event. The system then:

1. **Fetches all balance transactions** included in the payout (charges, fees, refunds, adjustments)
2. **Links existing Salesforce transactions** to the payout via `Stripe_Payout_Id__c`
3. **Creates a new Payout transaction in Salesforce** with aggregated totals
4. **Posts a Bank Deposit to QuickBooks** moving funds from Stripe Clearing to Operating Bank
5. **Marks the Salesforce transaction** as posted to QBO with the document reference

## Salesforce Field Requirements

### Required Custom Fields on Transaction__c Object

The following custom fields must exist on your `Transaction__c` Salesforce object:

| API Name | Label | Type | Description |
|----------|-------|------|-------------|
| `Transaction_Type__c` | Transaction Type | Picklist | Values: charge, refund, dispute, **payout** |
| `Status__c` | Status | Picklist | Values: pending, processing, **paid**, refunded, disputed, failed |
| `Stripe_Payout_Id__c` | Stripe Payout ID | Text(255) | External ID for payout (e.g., `po_1ABC...`) |
| `Stripe_Balance_Transaction_Id__c` | Stripe Balance Transaction ID | Text(255) | External ID, unique identifier |
| `Amount_Gross__c` | Amount Gross | Currency | Gross amount before fees |
| `Amount_Fee__c` | Amount Fee | Currency | Total fees deducted |
| `Amount_Net__c` | Amount Net | Currency | Net amount received |
| `Currency_ISO_Code__c` | Currency ISO Code | Text(3) | Three-letter currency code (USD, EUR, etc.) |
| `Memo__c` | Memo | Text Area (Long) | Descriptive memo with breakdown |
| `Received_At__c` | Received At | DateTime | When the payout arrived/will arrive |
| `Posted_to_QBO__c` | Posted to QBO | Checkbox | Whether synced to QuickBooks |
| `QBO_Doc_Type__c` | QBO Document Type | Text(50) | Type of QBO document (bank-deposit, sales-receipt, etc.) |
| `QBO_Doc_Id__c` | QBO Document ID | Text(50) | QuickBooks document ID |
| `QBO_Posted_At__c` | QBO Posted At | DateTime | When posted to QuickBooks |
| `Posting_Error__c` | Posting Error | Text Area | Error message if posting failed |

### Field Details

#### Transaction_Type__c Picklist
Add "payout" to the existing values:
- charge
- refund
- dispute
- **payout** ← NEW

#### Status__c Picklist
Ensure these values exist:
- pending
- processing
- paid
- refunded
- disputed
- failed

### Setting Up External IDs

Make sure `Stripe_Balance_Transaction_Id__c` is marked as an **External ID** field in Salesforce. This enables efficient upserts.

## QuickBooks Configuration

### Required Accounts

The following accounts must exist in your QuickBooks chart of accounts (or update environment variables to match your account names):

| Account Name | Type | Purpose |
|--------------|------|---------|
| Stripe Clearing | Bank | Temporary holding account for Stripe funds |
| Operating Bank | Bank | Your main business bank account |

### Environment Variables

Configure these in your `local.settings.json` or Azure Function configuration:

```json
{
  "QBO_ACCOUNT_STRIPE_CLEARING": "Stripe Clearing",
  "QBO_ACCOUNT_OPERATING_BANK": "Operating Bank",
  "ACCOUNTING_SYNC_ENABLED": "true"
}
```

## Example Webhook Payloads

### 1. Successful Payout (payout.paid)

This is the most common scenario when Stripe successfully pays out to your bank.

```json
{
  "id": "evt_1QAbCdEfGhIjKlMn",
  "object": "event",
  "api_version": "2023-10-16",
  "created": 1699564800,
  "data": {
    "object": {
      "id": "po_1QAbCdEfGhIjKlMn",
      "object": "payout",
      "amount": 97000,
      "arrival_date": 1699564800,
      "automatic": true,
      "balance_transaction": "txn_1QAbCdEfGhIjKlMn",
      "created": 1699478400,
      "currency": "usd",
      "description": "STRIPE PAYOUT",
      "destination": "ba_1QAbCdEfGhIjKlMn",
      "failure_balance_transaction": null,
      "failure_code": null,
      "failure_message": null,
      "livemode": false,
      "metadata": {},
      "method": "standard",
      "original_payout": null,
      "reversed_by": null,
      "source_type": "card",
      "statement_descriptor": null,
      "status": "paid",
      "type": "bank_account"
    }
  },
  "livemode": false,
  "pending_webhooks": 1,
  "request": {
    "id": null,
    "idempotency_key": null
  },
  "type": "payout.paid"
}
```

**Expected Result:**
- ✅ Payout transaction created in Salesforce
- ✅ Bank Deposit posted to QBO (Stripe Clearing → Operating Bank)
- ✅ Existing transactions linked to payout via Stripe_Payout_Id__c

### 2. Failed Payout (payout.failed)

When a payout fails (e.g., invalid bank account):

```json
{
  "id": "evt_2QAbCdEfGhIjKlMn",
  "object": "event",
  "api_version": "2023-10-16",
  "created": 1699564800,
  "data": {
    "object": {
      "id": "po_2QAbCdEfGhIjKlMn",
      "object": "payout",
      "amount": 45000,
      "arrival_date": 1699564800,
      "automatic": true,
      "balance_transaction": null,
      "created": 1699478400,
      "currency": "usd",
      "description": "STRIPE PAYOUT",
      "destination": "ba_2QAbCdEfGhIjKlMn",
      "failure_balance_transaction": "txn_2QAbCdEfGhIjKlMn",
      "failure_code": "account_closed",
      "failure_message": "The bank account has been closed.",
      "livemode": false,
      "metadata": {},
      "method": "standard",
      "original_payout": null,
      "reversed_by": null,
      "source_type": "card",
      "statement_descriptor": null,
      "status": "failed",
      "type": "bank_account"
    }
  },
  "livemode": false,
  "pending_webhooks": 1,
  "request": {
    "id": null,
    "idempotency_key": null
  },
  "type": "payout.failed"
}
```

**Expected Result:**
- ✅ Payout transaction created in Salesforce with Status = "failed"
- ❌ No deposit posted to QBO
- ✅ Payout marked for review

### 3. Canceled Payout (payout.canceled)

When a payout is canceled before completion:

```json
{
  "id": "evt_3QAbCdEfGhIjKlMn",
  "object": "event",
  "api_version": "2023-10-16",
  "created": 1699564800,
  "data": {
    "object": {
      "id": "po_3QAbCdEfGhIjKlMn",
      "object": "payout",
      "amount": 12500,
      "arrival_date": 1699564800,
      "automatic": false,
      "balance_transaction": null,
      "created": 1699478400,
      "currency": "usd",
      "description": "STRIPE PAYOUT",
      "destination": "ba_3QAbCdEfGhIjKlMn",
      "failure_balance_transaction": null,
      "failure_code": null,
      "failure_message": null,
      "livemode": false,
      "metadata": {},
      "method": "standard",
      "original_payout": null,
      "reversed_by": null,
      "source_type": "card",
      "statement_descriptor": null,
      "status": "canceled",
      "type": "bank_account"
    }
  },
  "livemode": false,
  "pending_webhooks": 1,
  "request": {
    "id": null,
    "idempotency_key": null
  },
  "type": "payout.canceled"
}
```

**Expected Result:**
- ✅ Payout transaction created in Salesforce with Status = "pending"
- ❌ No deposit posted to QBO
- ✅ Payout marked for review

## Testing the Feature

### Via Stripe CLI

You can test with the Stripe CLI:

```bash
# Forward webhooks to your local environment
stripe listen --forward-to http://localhost:7071/api/stripeWebhook

# Trigger a test payout event
stripe trigger payout.paid
```

### Via Direct HTTP Request

You can also test by posting directly to your webhook endpoint with proper Stripe signature:

```bash
curl -X POST http://localhost:7071/api/stripeWebhook \
  -H "Content-Type: application/json" \
  -H "Stripe-Signature: t=1699564800,v1=mock_signature_for_testing" \
  -d @payout-paid-event.json
```

**Note:** For local testing, you may need to disable signature verification or use the Stripe CLI.

## Salesforce Transaction Example

After processing a payout, the Salesforce record will look like:

```
Transaction__c Record
├─ Transaction_Type__c: "payout"
├─ Status__c: "paid"
├─ Stripe_Payout_Id__c: "po_1QAbCdEfGhIjKlMn"
├─ Stripe_Balance_Transaction_Id__c: "txn_1QAbCdEfGhIjKlMn"
├─ Amount_Gross__c: 1000.00
├─ Amount_Fee__c: 30.00
├─ Amount_Net__c: 970.00
├─ Currency_ISO_Code__c: "USD"
├─ Memo__c: "Stripe Payout po_1QA... | Charges: $1000.00 | Fees: -$30.00 | Net: $970.00"
├─ Received_At__c: 2023-11-09T12:00:00Z
├─ Posted_to_QBO__c: true
├─ QBO_Doc_Type__c: "bank-deposit"
├─ QBO_Doc_Id__c: "123"
└─ QBO_Posted_At__c: 2023-11-09T12:01:15Z
```

## QuickBooks Deposit Example

The QuickBooks Bank Deposit will be created as:

```
Bank Deposit
├─ Doc Number: PO-po_1QAbCdEfGhIjKl
├─ Transaction Date: 2023-11-09
├─ Deposit To: Operating Bank
├─ Amount: $970.00
└─ Line Items:
    └─ From Account: Stripe Clearing
        Amount: $970.00
        Memo: Stripe payout po_1QAbCdEfGhIjKlMn
```

## Troubleshooting

### Payout transaction not created in Salesforce

**Possible causes:**
1. Salesforce authentication failed
2. Missing required custom fields
3. Field API names don't match

**Solution:** Check logs for Salesforce errors and verify field setup.

### Deposit not posted to QuickBooks

**Possible causes:**
1. `ACCOUNTING_SYNC_ENABLED` is set to `false`
2. QuickBooks authentication expired
3. Account names don't match configuration

**Solution:** 
- Verify `ACCOUNTING_SYNC_ENABLED=true`
- Check QBO token refresh status
- Confirm account names in QBO match env variables

### Transactions not linked to payout

**Possible causes:**
1. Balance transactions missing `id` field
2. Salesforce upsert failed

**Solution:** Check that `Stripe_Balance_Transaction_Id__c` is an External ID field.

## Architecture Notes

### Flow Diagram

```
Stripe Payout Event
        ↓
1. Fetch Balance Transactions
        ↓
2. Link to Existing SF Transactions
   (Update Stripe_Payout_Id__c)
        ↓
3. Calculate Totals
   - Charges
   - Fees
   - Refunds
   - Adjustments
        ↓
4. Create SF Payout Transaction
   (Type: payout, Status: paid/failed)
        ↓
5. Post QBO Bank Deposit
   (Stripe Clearing → Operating Bank)
        ↓
6. Update SF Transaction
   (Mark as Posted to QBO)
```

### Key Files

- **Payout Handler**: `src/stripe/handlers/payouts.ts`
- **QBO Service**: `src/services/qboSvc.ts` (postPayoutToQbo, buildBankDeposit)
- **Salesforce Service**: `src/services/salesforceSvc.ts` (upsertTransactionByExternalId, linkPayoutOnTransactions)
- **Event Router**: `src/handlers/webhook/StripeEventRouter.ts`

## Additional Resources

- [Stripe Payout API Documentation](https://stripe.com/docs/api/payouts)
- [Stripe Balance Transaction API](https://stripe.com/docs/api/balance_transactions)
- [QuickBooks Online API - Deposit](https://developer.intuit.com/app/developer/qbo/docs/api/accounting/all-entities/deposit)
