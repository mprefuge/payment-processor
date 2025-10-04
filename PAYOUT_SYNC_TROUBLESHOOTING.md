# Payout Sync Troubleshooting Guide

## Overview

This guide helps diagnose why journal entries are not being created when payout webhooks are received.

## Recent Changes

The code has been enhanced with comprehensive logging and validation to help identify the exact failure point. After deploying these changes, the Azure Function logs will show detailed diagnostic information.

## Required Environment Variables

For payout sync to work, these environment variables MUST be set:

### Accounting Sync Configuration
```
ACCOUNTING_SYNC_ENABLED=true
ACCOUNTING_PROVIDER=quickbooks
```

### QuickBooks Configuration
```
QBO_COMPANY_ID=<your-company-id>
QBO_ENVIRONMENT=sandbox  # or 'production'
QBO_ACCESS_TOKEN=<your-access-token>
QBO_REFRESH_TOKEN=<your-refresh-token>
QBO_CLIENT_ID=<your-client-id>
QBO_CLIENT_SECRET=<your-client-secret>
```

### Stripe Configuration
```
STRIPE_TEST_SECRET_KEY=sk_test_...  # for test mode
STRIPE_LIVE_SECRET_KEY=sk_live_...  # for live mode
```

### Optional Account Mappings
```
ACCOUNTING_STRIPE_CLEARING_ACCOUNT=Stripe Clearing
ACCOUNTING_REVENUE_ACCOUNT=Revenue
ACCOUNTING_REFUNDS_ACCOUNT=Refunds
ACCOUNTING_STRIPE_FEE_ACCOUNT=Stripe Fees
ACCOUNTING_CHARGEBACK_ACCOUNT=Chargebacks
ACCOUNTING_ADJUSTMENT_ACCOUNT=Adjustments
```

> ℹ️ The operating bank account name is automatically synced from Stripe; you only need to provide the clearing and revenue
> accounts.

## Diagnostic Log Messages

After deploying the latest changes, look for these log messages when a payout webhook is received:

### 1. Configuration Check
```
Processing payout.paid: po_...
Stripe account ID: default
Accounting sync enabled: true  <-- If false, sync is disabled!
Configuration validation result: { isValid: true/false, errors: [...] }
```

**Action**: If sync is disabled or configuration is invalid:
- Check that `ACCOUNTING_SYNC_ENABLED=true` in Azure Function Application Settings
- Review the error list to see which env vars are missing
- Add any missing environment variables

### 2. Idempotency Check
```
Existing sync status: none  <-- Or 'posted', 'failed', etc.
```

**Action**: If status is 'posted':
- The payout was already synced successfully
- This is normal idempotency behavior - no action needed

### 3. Provider Initialization
```
Initializing accounting provider: quickbooks
Provider config keys: [ 'companyId', 'environment', 'oauthTokens' ]
Accounting provider initialized successfully
```

**Action**: If this step fails:
- Check QuickBooks environment variables (QBO_COMPANY_ID, etc.)
- Verify OAuth tokens are present and not expired
- Check error stack trace for specific missing configuration

### 4. Stripe API Call
```
[PayoutSync] Pulling payout: po_...
[PayoutSync] Stripe account ID: default
[PayoutSync] Stripe account config found: true/false
[PayoutSync] Secret key available: YES
[PayoutSync] Stripe client initialized
[PayoutSync] Fetching payout from Stripe API...
[PayoutSync] Payout retrieved: po_..., status: paid, amount: 10000
[PayoutSync] Pulled payout with 5 transactions
```

**Action**: If this step fails:
- Verify STRIPE_TEST_SECRET_KEY or STRIPE_LIVE_SECRET_KEY is set correctly
- Check that the API key matches the payout mode (test vs live)
- Verify network connectivity to Stripe API
- Check error stack trace for Stripe API errors

### 5. Account Creation
```
[PayoutSync] Ensured 3 accounts
[QBO] Found existing account: Stripe Clearing (ID: 123)
[QBO] Created account: Revenue (ID: 124)
```

**Action**: If this step fails:
- Check QuickBooks OAuth tokens are valid
- Verify QuickBooks client is initialized correctly
- Review QuickBooks API error details in logs

### 6. Journal Entry Creation
```
[PayoutSync] Creating journal entry with 4 lines
[PayoutSync] Journal entry lines: debit Stripe Clearing(123): 100, credit Revenue(124): 100, ...
[QBO] Upserting journal entry: ST-12ab34cd-JE
[QBO] Journal entry has 4 lines, debits=100, credits=100
[QBO] Created journal entry: ST-12ab34cd-JE (ID: 456)
[PayoutSync] Posted journal entry: 456
```

**Action**: If this step fails:
- Check error details - QuickBooks will return specific validation errors
- Common issues:
  - Account IDs are invalid
  - Journal entry lines don't balance
  - DocNumber is too long (max 21 characters)
  - Required fields are missing

## Common Failure Scenarios

### Scenario 1: "Event already processed"
**Log**: `Event already processed: evt_...`

**Cause**: Webhook idempotency check - this event was already successfully processed.

**Action**: This is normal. If you want to reprocess, you need to:
1. Clear the webhook event store (development only)
2. Or wait for a new payout event

### Scenario 2: "Accounting sync disabled"
**Log**: `Accounting sync enabled: false`

**Cause**: `ACCOUNTING_SYNC_ENABLED` environment variable is not set to 'true'.

**Action**: 
1. Go to Azure Portal > Function App > Configuration
2. Add or update: `ACCOUNTING_SYNC_ENABLED=true`
3. Save and restart the function

### Scenario 3: "Configuration validation failed"
**Log**: `Configuration validation result: { isValid: false, errors: [...] }`

**Cause**: Missing or invalid configuration.

**Action**: Review the errors array and add missing environment variables.

### Scenario 4: "Stripe secret key not configured"
**Log**: `Error: Stripe secret key not configured for account: default`

**Cause**: Missing STRIPE_TEST_SECRET_KEY or STRIPE_LIVE_SECRET_KEY.

**Action**:
1. Verify the payout mode (test vs live)
2. Add the appropriate secret key to environment variables

### Scenario 5: "QuickBooks client not initialized"
**Log**: `Error: QuickBooks client not initialized`

**Cause**: Missing QuickBooks configuration (company ID, tokens, etc.).

**Action**: Add all required QBO_* environment variables.

### Scenario 6: "Account ID not found for account"
**Log**: `Error: Account ID not found for account: Stripe Clearing`

**Cause**: Account was not created successfully in QuickBooks.

**Action**: 
1. Check QuickBooks API logs for creation errors
2. Verify OAuth tokens are valid
3. Ensure account type/subtype mappings are correct

### Scenario 7: "Failed to upsert journal entry: ..."
**Log**: Detailed QuickBooks API error with Fault information

**Cause**: QuickBooks rejected the journal entry.

**Action**: Review the specific error message from QuickBooks. Common issues:
- Lines don't balance (debits ≠ credits)
- Invalid account IDs
- DocNumber too long
- Missing required fields

## Testing

To test if everything is configured correctly:

1. Send a test payout webhook to your Azure Function
2. Check the logs for the diagnostic messages above
3. Follow the troubleshooting steps based on where it fails

You can also use this test payload via Postman or curl:

```json
{
  "id": "evt_test_payout_paid_001",
  "type": "payout.paid",
  "livemode": false,
  "created": 1699000000,
  "data": {
    "object": {
      "id": "po_test_12345",
      "object": "payout",
      "amount": 10000,
      "arrival_date": 1699000000,
      "created": 1699000000,
      "currency": "usd",
      "status": "paid"
    }
  }
}
```

## Support

If you're still having issues after following this guide:

1. Collect the full log output from the Azure Function
2. Share the diagnostic messages (with sensitive values redacted)
3. Include the specific error message and stack trace
4. Verify all environment variables are set correctly
