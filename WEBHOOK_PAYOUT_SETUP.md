# Webhook-Only Payout Processing Setup Guide

This guide provides complete instructions for setting up automated, webhook-driven payout processing with accounting and CRM integration. The system uses **only Stripe webhooks** - there is no manual payout sync capability.

## Table of Contents

1. [Overview](#overview)
2. [Prerequisites](#prerequisites)
3. [Architecture](#architecture)
4. [Step-by-Step Setup](#step-by-step-setup)
5. [CRM Integration (Salesforce Example)](#crm-integration-salesforce-example)
6. [Testing & Validation](#testing--validation)
7. [Test Case Scenarios](#test-case-scenarios)
8. [Troubleshooting](#troubleshooting)
9. [Monitoring](#monitoring)
10. [Future CRM Extensibility](#future-crm-extensibility)

---

## Overview

### What This System Does

When a Stripe payout is paid (funds arrive in your bank account), the system automatically:

1. **Receives webhook** from Stripe (`payout.paid` event)
2. **Fetches payout details** and all associated transactions
3. **Validates totals** to ensure accuracy
4. **Posts to accounting system** (QuickBooks Online, Xero, etc.)
5. **Creates CRM record** (Salesforce, HubSpot, etc.) with payout details
6. **Records in sync ledger** for audit trail and idempotency

### Key Features

- ✅ **Webhook-only processing** - No manual intervention required
- ✅ **Automatic reconciliation** - Validates gross - refunds - fees = net
- ✅ **Dual-system sync** - Both accounting and CRM in one flow
- ✅ **Idempotent** - Prevents duplicate processing
- ✅ **Extensible** - Easy to add new CRM providers
- ✅ **Complete audit trail** - Links Stripe → Accounting → CRM

---

## Prerequisites

### Required Accounts

1. **Stripe Account**
   - Test and/or Live mode enabled
   - Webhook endpoint access

2. **Accounting System**
   - QuickBooks Online account (or other supported provider)
   - API credentials configured

3. **CRM System** (Optional but recommended)
   - Salesforce account (or other supported provider)
   - API credentials configured
   - Custom objects created (see [CRM Integration](#crm-integration-salesforce-example))

4. **Azure Account**
   - Azure Functions app deployed
   - Environment variables configured

### Required Knowledge

- Basic understanding of Stripe webhooks
- Familiarity with your CRM system (e.g., Salesforce)
- Understanding of double-entry accounting (helpful for troubleshooting)

---

## Architecture

### System Flow

```
┌─────────────────┐
│  Stripe Payout  │
│   Completed     │
└────────┬────────┘
         │
         │ Webhook Event
         ▼
┌─────────────────────────────┐
│  Azure Function             │
│  stripeWebhook/index.js     │
└────────┬────────────────────┘
         │
         │ payout.paid event
         ▼
┌─────────────────────────────┐
│  ProcessPayoutJob           │
│  - Pull transactions        │
│  - Validate totals          │
│  - Generate posting         │
└────────┬────────────────────┘
         │
         ├───────────────────┐
         │                   │
         ▼                   ▼
┌──────────────────┐  ┌──────────────────┐
│  Accounting      │  │  CRM System      │
│  (QuickBooks)    │  │  (Salesforce)    │
│                  │  │                  │
│  - Journal Entry │  │  - Payout Record │
│  - Transfer      │  │  - Summary Data  │
│  - Deposit       │  │  - Accounting IDs│
└──────────────────┘  └──────────────────┘
         │                   │
         └─────────┬─────────┘
                   ▼
         ┌──────────────────┐
         │   Sync Ledger    │
         │   (Audit Trail)  │
         └──────────────────┘
```

### Key Components

- **stripeWebhook/index.js** - Receives and validates Stripe webhooks
- **PayoutSyncService** - Core payout processing logic
- **AccountingProvider** - Abstraction layer for accounting systems
- **CrmFactory** - Creates appropriate CRM service instances
- **SyncLedger** - Tracks processed payouts for idempotency

---

## Step-by-Step Setup

### Step 1: Configure Accounting Integration

Set up your accounting provider credentials in Azure Function environment variables.

**For QuickBooks Online:**

```bash
# Enable accounting sync
ACCOUNTING_SYNC_ENABLED=true
ACCOUNTING_PROVIDER=quickbooks

# QuickBooks credentials
QBO_COMPANY_ID=your_company_id
QBO_ENVIRONMENT=sandbox  # or production
QBO_ACCESS_TOKEN=your_access_token
QBO_REFRESH_TOKEN=your_refresh_token

# Account mappings (use your actual account names from QuickBooks)
ACCOUNTING_STRIPE_CLEARING_ACCOUNT=Stripe Clearing
ACCOUNTING_REVENUE_ACCOUNT=Revenue
ACCOUNTING_REFUNDS_ACCOUNT=Refunds
ACCOUNTING_STRIPE_FEE_ACCOUNT=Stripe Fees
ACCOUNTING_DISPUTE_ACCOUNT=Customer Disputes
```

> ℹ️ The operating bank account name is now read directly from Stripe payout destinations and no longer needs to be configured.

**For other providers (Xero, Sage):**

See [PAYOUT_SYNC_SETUP.md](./PAYOUT_SYNC_SETUP.md) for provider-specific configuration.

### Step 2: Configure CRM Integration (Optional)

**For Salesforce:**

```bash
# Enable CRM integration
CRM_PROVIDER=salesforce

# Salesforce credentials
SALESFORCE_USERNAME=integration.user@yourorg.com
SALESFORCE_PASSWORD=your_password
SALESFORCE_SECURITY_TOKEN=your_security_token
SALESFORCE_LOGIN_URL=https://login.salesforce.com  # or test.salesforce.com for sandbox
```

**For other CRMs:**

The system is built to support additional CRM providers. See [Future CRM Extensibility](#future-crm-extensibility).

### Step 3: Configure Stripe Webhooks

1. **Go to Stripe Dashboard** → Developers → Webhooks

2. **Add endpoint:**
   ```
   https://your-function-app.azurewebsites.net/api/stripe/webhook
   ```

3. **Select events to send:**
   - ✅ `payout.paid` (Required)
   - ✅ `payout.failed` (Optional - for error tracking)
   - ✅ `payout.canceled` (Optional - for error tracking)

4. **Copy webhook signing secret**
   
   Add to environment variables:
   ```bash
   STRIPE_WEBHOOK_SECRET_TEST=whsec_your_test_secret
   STRIPE_WEBHOOK_SECRET_LIVE=whsec_your_live_secret
   ```

5. **Test the endpoint**
   
   Use Stripe's "Send test webhook" button to verify connectivity.

### Step 4: Verify Configuration

Check that all required environment variables are set:

```bash
# In Azure Portal → Function App → Configuration → Application Settings
# Verify these are present:

# Stripe
STRIPE_TEST_SECRET_KEY
STRIPE_LIVE_SECRET_KEY
STRIPE_WEBHOOK_SECRET_TEST
STRIPE_WEBHOOK_SECRET_LIVE

# Accounting (QuickBooks example)
ACCOUNTING_SYNC_ENABLED=true
ACCOUNTING_PROVIDER=quickbooks
QBO_COMPANY_ID
QBO_ACCESS_TOKEN
QBO_REFRESH_TOKEN
ACCOUNTING_STRIPE_CLEARING_ACCOUNT
ACCOUNTING_REVENUE_ACCOUNT

# CRM (Salesforce example) - Optional
CRM_PROVIDER=salesforce
SALESFORCE_USERNAME
SALESFORCE_PASSWORD
SALESFORCE_SECURITY_TOKEN
```

---

## CRM Integration (Salesforce Example)

### Why Integrate with CRM?

Storing payout data in your CRM provides:

- **Unified reporting** - View transactions and payouts together
- **Easy reconciliation** - Lookup accounting documents from CRM
- **Business intelligence** - Build dashboards on payout trends
- **Complete audit trail** - Links to both Stripe and accounting system

### Salesforce Object Setup

#### Create Custom Object: Payout__c

1. **Navigate to:** Setup → Object Manager → Create → Custom Object

2. **Object Properties:**
   - Label: `Payout`
   - Plural Label: `Payouts`
   - Object Name: `Payout__c`
   - Record Name: `Payout Name` (Text, Auto-number optional)

3. **Create Custom Fields:**

**Stripe Identifiers:**

| Field Label | API Name | Type | Length | Required | Unique | External ID |
|------------|----------|------|--------|----------|--------|-------------|
| Payout ID | `Payout_ID__c` | Text | 255 | ✓ | ✓ | ✓ |
| Stripe Account ID | `Stripe_Account_ID__c` | Text | 255 | | | |

**Financial Details:**

| Field Label | API Name | Type | Decimals | Default | Required |
|------------|----------|------|----------|---------|----------|
| Amount | `Amount__c` | Currency | 2 | | ✓ |
| Currency | `Currency__c` | Text(3) | | USD | |
| Arrival Date | `Arrival_Date__c` | Date | | | |
| Created Date | `Created_Date__c` | Date/Time | | | |
| Status | `Status__c` | Picklist* | | Paid | |
| Description | `Description__c` | Long Text Area | | | |

*Status picklist values: `Paid`, `Pending`, `Failed`, `Canceled`

**Transaction Summary Fields:**

| Field Label | API Name | Type | Decimals | Default |
|------------|----------|------|----------|---------|
| Charge Count | `Charge_Count__c` | Number | 0 | 0 |
| Charge Amount | `Charge_Amount__c` | Currency | 2 | 0 |
| Refund Count | `Refund_Count__c` | Number | 0 | 0 |
| Refund Amount | `Refund_Amount__c` | Currency | 2 | 0 |
| Fee Amount | `Fee_Amount__c` | Currency | 2 | 0 |
| Dispute Count | `Dispute_Count__c` | Number | 0 | 0 |
| Dispute Amount | `Dispute_Amount__c` | Currency | 2 | 0 |

**Accounting Integration References:**

| Field Label | API Name | Type | Length |
|------------|----------|------|--------|
| Accounting Journal Entry ID | `Accounting_Journal_Entry_ID__c` | Text | 255 |
| Accounting Transfer ID | `Accounting_Transfer_ID__c` | Text | 255 |
| Accounting Deposit ID | `Accounting_Deposit_ID__c` | Text | 255 |

**Metadata:**

| Field Label | API Name | Type | Length | Visible Lines |
|------------|----------|------|--------|---------------|
| Metadata | `Metadata__c` | Long Text Area | 32768 | 5 |

#### Page Layout

Organize fields into logical sections:

1. **Payout Information**
   - Payout Name
   - Payout ID
   - Stripe Account ID
   - Status
   - Description

2. **Financial Details**
   - Amount
   - Currency
   - Arrival Date
   - Created Date

3. **Transaction Summary**
   - Charge Count | Charge Amount
   - Refund Count | Refund Amount
   - Fee Amount
   - Dispute Count | Dispute Amount

4. **Accounting Integration**
   - Accounting Journal Entry ID
   - Accounting Transfer ID
   - Accounting Deposit ID

5. **System Information**
   - Metadata
   - Created By, Last Modified By

For complete Salesforce setup instructions, see [SALESFORCE_PAYOUT_SETUP.md](./SALESFORCE_PAYOUT_SETUP.md).

### CRM Integration Behavior

- **Automatic creation** - When `CRM_PROVIDER` is configured, payout records are created automatically
- **Graceful degradation** - If `Payout__c` object doesn't exist, system logs and continues
- **Error isolation** - CRM errors don't prevent accounting sync
- **Linked data** - Accounting document IDs are stored in CRM payout record

---

## Testing & Validation

### Test Preparation

Before triggering a real payout:

1. **Verify Stripe webhook configuration**
   ```bash
   # Use Stripe CLI to test webhook delivery
   stripe listen --forward-to https://your-function-app.azurewebsites.net/api/stripe/webhook
   ```

2. **Check Azure Function logs**
   ```bash
   # In Azure Portal → Function App → Monitor → Log Stream
   # You should see webhook events being received
   ```

3. **Verify accounting connection**
   - Check that accounting provider credentials are valid
   - Verify account names match your chart of accounts

4. **Verify CRM connection** (if enabled)
   - Test Salesforce login credentials
   - Ensure `Payout__c` object exists with all required fields

### Manual Test (Using Stripe Test Mode)

1. **Create a test payment in Stripe**
   ```bash
   # Use Stripe Dashboard or API to create a test charge
   # Wait for test payout to be created (Stripe test mode creates instant payouts)
   ```

2. **Trigger payout.paid webhook**
   
   Option A - Use Stripe CLI:
   ```bash
   stripe trigger payout.paid
   ```
   
   Option B - Use Stripe Dashboard:
   - Go to Webhooks → Your endpoint → Send test webhook
   - Select `payout.paid` event

3. **Check Azure Function logs**
   
   You should see:
   ```
   [PayoutJob] Processing payout: po_xxxxx
   [PayoutJob] Pulled payout with N transactions
   [PayoutJob] Posted to accounting: {...}
   [PayoutJob] Created payout record in CRM: a0X...
   [PayoutJob] Payout sync completed successfully
   ```

4. **Verify in accounting system**
   
   Check QuickBooks (or your provider) for:
   - Journal Entry created
   - Transfer transaction created
   - All amounts match Stripe payout

5. **Verify in CRM** (if enabled)
   
   Check Salesforce for:
   - New `Payout__c` record created
   - All fields populated correctly
   - Accounting document IDs linked

### Status Check API

You can check the status of any payout sync:

```bash
GET https://your-function-app.azurewebsites.net/api/sync/stripe/payouts/{payoutId}?account=default

# Example response:
{
  "payoutId": "po_1234567890",
  "stripeAccountId": "default",
  "status": "posted",
  "provider": "quickbooks",
  "providerDocIds": {
    "journalEntry": "123",
    "transfer": "456"
  },
  "crmPayoutId": "a0X1234567890ABC",
  "createdAt": "2024-01-15T10:30:00Z",
  "updatedAt": "2024-01-15T10:30:00Z"
}
```

**Note:** Manual payout sync (POST) has been removed. The system is webhook-only.

---

## Test Case Scenarios

### Scenario 1: Simple Payout (Charges Only)

**Setup:**
- 5 successful charges totaling $500
- Stripe fees: $15.50
- Net payout: $484.50

**Expected Behavior:**

1. **Webhook received:** `payout.paid` for po_xxxxx
2. **Accounting entries:**
   - Journal Entry:
     * Debit: Stripe Clearing $500
     * Credit: Revenue $500
   - Journal Entry:
     * Debit: Stripe Fees $15.50
     * Credit: Stripe Clearing $15.50
   - Transfer:
     * Debit: Operating Bank $484.50
     * Credit: Stripe Clearing $484.50

3. **CRM record created:**
   - Payout ID: po_xxxxx
   - Amount: $484.50
   - Charge Count: 5
   - Charge Amount: $500.00
   - Fee Amount: $15.50
   - Accounting Journal Entry ID: [QuickBooks JE ID]
   - Accounting Transfer ID: [QuickBooks Transfer ID]

**Validation:**
- ✅ QuickBooks balance: Stripe Clearing = $0
- ✅ Operating Bank increased by $484.50
- ✅ Salesforce payout record exists with correct amounts
- ✅ Sync ledger shows status: "posted"

### Scenario 2: Payout with Charges and Refunds

**Setup:**
- 10 charges totaling $1,000
- 2 refunds totaling $150
- Stripe fees: $26.20 (charges) + $0 (refunds)
- Net payout: $823.80

**Expected Behavior:**

1. **Webhook received:** `payout.paid` for po_yyyyy

2. **Accounting entries:**
   - Journal Entry (Charges):
     * Debit: Stripe Clearing $1,000
     * Credit: Revenue $1,000
   - Journal Entry (Refunds):
     * Debit: Refunds $150
     * Credit: Stripe Clearing $150
   - Journal Entry (Fees):
     * Debit: Stripe Fees $26.20
     * Credit: Stripe Clearing $26.20
   - Transfer:
     * Debit: Operating Bank $823.80
     * Credit: Stripe Clearing $823.80

3. **CRM record created:**
   - Amount: $823.80
   - Charge Count: 10
   - Charge Amount: $1,000.00
   - Refund Count: 2
   - Refund Amount: $150.00
   - Fee Amount: $26.20

**Validation:**
- ✅ Net calculation: $1,000 - $150 - $26.20 = $823.80
- ✅ QuickBooks entries balance correctly
- ✅ Salesforce shows both charge and refund summaries

### Scenario 3: Payout with Dispute

**Setup:**
- 8 charges totaling $800
- 1 dispute loss: $100
- Stripe fees: $24.00
- Net payout: $676.00

**Expected Behavior:**

1. **Webhook received:** `payout.paid` for po_zzzzz

2. **Accounting entries:**
   - Journal Entry (Charges):
     * Debit: Stripe Clearing $800
     * Credit: Revenue $800
   - Journal Entry (Dispute):
     * Debit: Customer Disputes $100
     * Credit: Stripe Clearing $100
   - Journal Entry (Fees):
     * Debit: Stripe Fees $24.00
     * Credit: Stripe Clearing $24.00
   - Transfer:
     * Debit: Operating Bank $676.00
     * Credit: Stripe Clearing $676.00

3. **CRM record created:**
   - Charge Count: 8
   - Charge Amount: $800.00
   - Dispute Count: 1
   - Dispute Amount: $100.00
   - Fee Amount: $24.00
   - Amount: $676.00

**Validation:**
- ✅ Dispute properly recorded in separate account
- ✅ CRM shows dispute count and amount
- ✅ Net matches Stripe payout amount

### Scenario 4: Idempotency Test (Duplicate Webhook)

**Setup:**
- Same `payout.paid` webhook sent twice

**Expected Behavior:**

1. **First webhook:** Processes normally
2. **Second webhook:** 
   ```
   [PayoutJob] Payout already synced: po_xxxxx
   ```
   - No duplicate accounting entries
   - No duplicate CRM record
   - Returns 200 OK immediately

**Validation:**
- ✅ Only one journal entry in QuickBooks
- ✅ Only one payout record in Salesforce
- ✅ Sync ledger shows single entry

### Scenario 5: Failed Payout

**Setup:**
- Payout fails in Stripe (insufficient balance)

**Expected Behavior:**

1. **Webhook received:** `payout.failed` for po_xxxxx
2. **System updates status:**
   - Sync ledger updated to "failed"
   - No accounting entries created
   - No CRM record created (or existing record updated to Failed)

3. **Logs show:**
   ```
   [PayoutJob] Updated sync status to failed for payout: po_xxxxx
   ```

**Validation:**
- ✅ No accounting impact
- ✅ Status tracked in sync ledger

---

## Troubleshooting

### Issue: Webhook not received

**Symptoms:**
- Payout marked as paid in Stripe
- No logs in Azure Function

**Solutions:**
1. Check webhook endpoint URL is correct
2. Verify webhook is enabled in Stripe
3. Check webhook secret is configured
4. Review Stripe webhook delivery attempts (Dashboard → Webhooks → Your endpoint)
5. Test with Stripe CLI: `stripe listen --forward-to your-url`

### Issue: Accounting sync fails

**Symptoms:**
- Webhook received
- Error: "Failed to post to accounting"

**Solutions:**
1. Verify accounting provider credentials
2. Check account names match chart of accounts exactly
3. Verify QuickBooks access token is not expired
4. Check QuickBooks API limits
5. Review error details in Azure Function logs

### Issue: CRM record not created

**Symptoms:**
- Accounting sync succeeds
- No Salesforce record created

**Solutions:**
1. Verify `CRM_PROVIDER` is set to `salesforce`
2. Check Salesforce credentials are valid
3. Ensure `Payout__c` object exists with all required fields
4. Check field API names match exactly (case-sensitive)
5. Review field-level security settings
6. Check Salesforce API limits

### Issue: Validation fails

**Symptoms:**
- Error: "Payout totals do not match"

**Solutions:**
1. Check for missing transaction types
2. Verify all balance transactions were fetched
3. Review Stripe payout details for unusual transactions
4. Check for timezone/rounding issues
5. Contact support if totals consistently mismatch

### Issue: Duplicate processing

**Symptoms:**
- Multiple accounting entries for same payout
- Multiple CRM records

**Solutions:**
1. Check `Payout_ID__c` is marked as External ID in Salesforce
2. Verify sync ledger is working (check storage connection)
3. Review webhook event deduplication logs
4. Check for race conditions (very rare with idempotency checks)

---

## Monitoring

### Key Metrics to Track

1. **Webhook Delivery Success Rate**
   - Monitor in Stripe Dashboard → Webhooks
   - Should be >99%

2. **Processing Time**
   - Check Azure Function execution time
   - Should be <30 seconds per payout

3. **Error Rate**
   - Monitor Azure Application Insights
   - Alerts on repeated failures

4. **Accounting Sync Success**
   - Query sync ledger for failed statuses
   - Review and resolve errors

5. **CRM Sync Success**
   - Count Salesforce records vs. sync ledger entries
   - Investigate discrepancies

### Azure Monitor Queries

```kusto
// Failed payout syncs in last 24 hours
traces
| where timestamp > ago(24h)
| where message contains "PayoutJob" and message contains "Error"
| project timestamp, message

// Processing time distribution
requests
| where name == "stripeWebhook"
| summarize avg(duration), percentile(duration, 95) by bin(timestamp, 1h)
```

### Recommended Alerts

1. **Webhook Failures** - Alert if >5 webhook failures in 1 hour
2. **Accounting Sync Errors** - Alert on any accounting posting failure
3. **Validation Failures** - Alert on total validation mismatches
4. **CRM Sync Errors** - Alert if CRM sync fails >10% of time

---

## Future CRM Extensibility

The system is designed to easily support additional CRM providers beyond Salesforce.

### Architecture for Multi-CRM Support

```javascript
// services/crm/crmFactory.js
class CrmFactory {
    static createCrmService(provider, config) {
        switch (provider.toLowerCase()) {
            case 'salesforce':
                return new SalesforceCrmService(config);
            case 'hubspot':
                return new HubspotCrmService(config);
            case 'dynamics':
                return new DynamicsCrmService(config);
            // Add more providers here
        }
    }
}
```

### Adding a New CRM Provider

To add support for a new CRM (e.g., HubSpot):

1. **Create CRM service class:**
   ```javascript
   // services/crm/hubspotCrm.js
   const BaseCrmService = require('./baseCrm');
   
   class HubspotCrmService extends BaseCrmService {
       async createPayout(payoutData) {
           // Implement HubSpot-specific logic
       }
       // Implement other required methods
   }
   ```

2. **Add to factory:**
   ```javascript
   case 'hubspot':
       return new HubspotCrmService(config);
   ```

3. **Add configuration:**
   ```javascript
   case 'hubspot':
       return {
           provider: 'hubspot',
           config: {
               apiKey: process.env.HUBSPOT_API_KEY,
               portalId: process.env.HUBSPOT_PORTAL_ID
           }
       };
   ```

4. **Update documentation** with HubSpot-specific setup instructions

### Required Methods for CRM Providers

Any CRM provider must implement:

- `createPayout(payoutData)` - Create payout record
- `updatePayout(id, updates)` - Update payout record (for failed payouts)
- `findPayoutByStripeId(payoutId)` - Search for existing payout

See `services/crm/baseCrm.js` for the complete interface.

---

## Summary

This webhook-only payout processing system provides:

✅ **Automated processing** - No manual intervention required
✅ **Dual-system sync** - Accounting and CRM updated together
✅ **Reliable** - Idempotent, validated, with complete audit trail
✅ **Extensible** - Easy to add new CRM and accounting providers
✅ **Production-ready** - Error handling, monitoring, logging

For questions or issues, refer to:
- [PAYOUT_SYNC_SETUP.md](./PAYOUT_SYNC_SETUP.md) - Detailed accounting configuration
- [SALESFORCE_PAYOUT_SETUP.md](./SALESFORCE_PAYOUT_SETUP.md) - Salesforce object setup
- [STRIPE_WEBHOOK_SETUP.md](./STRIPE_WEBHOOK_SETUP.md) - Stripe webhook configuration
- GitHub Issues - For bug reports and feature requests
