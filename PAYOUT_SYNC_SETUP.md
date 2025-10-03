# Stripe Payout Sync to Accounting

This document describes the Stripe Payout Sync to Accounting feature, which automatically syncs Stripe payouts to accounting systems (QuickBooks Online, Xero, Sage, etc.) in a provider-agnostic manner.

## Table of Contents

1. [Overview](#overview)
2. [Architecture](#architecture)
3. [Configuration](#configuration)
4. [Webhook Events](#webhook-events)
5. [API Endpoints](#api-endpoints)
6. [Accounting Documents](#accounting-documents)
7. [Idempotency and Drift Detection](#idempotency-and-drift-detection)
8. [Error Handling](#error-handling)
9. [Testing](#testing)
10. [Production Deployment](#production-deployment)

## Overview

The payout sync feature provides:

- **Webhook-first design**: Fast webhook acknowledgment (<2s), async job processing
- **Provider-agnostic abstraction**: Support for multiple accounting systems through a common interface
- **Idempotent processing**: Dedupe by event.id and payout.id, with posting hash for drift detection
- **Comprehensive reconciliation**: Validate that gross - refunds - fees - disputes - adjustments = net
- **Multi-account support**: Handle multiple Stripe accounts and Connect platforms
- **Audit trail**: Complete sync ledger with links to accounting documents

## Architecture

### Core Components

1. **AccountingProvider** (interface)
   - Base interface for all accounting system integrations
   - Implementations: QuickBooksProvider (others can be added)
   - Methods: `upsertJournalEntry()`, `upsertTransfer()`, `upsertDeposit()`, `healthCheck()`

2. **PayoutSyncService** (domain service)
   - `pullPayout()` - Fetch payout and balance transactions from Stripe
   - `summarize()` - Aggregate charges, refunds, fees, disputes, adjustments
   - `validateTotals()` - Ensure summary matches payout net amount
   - `generatePostingInstructions()` - Build provider-neutral posting instructions
   - `postToAccounting()` - Post to accounting provider
   - `recordLedger()` - Persist sync ledger entry

3. **WebhookEventStore**
   - Tracks all received webhook events
   - Provides deduplication by event.id
   - Stores processing status and errors

4. **SyncLedger**
   - Links payout_id to accounting document IDs
   - Stores posting_hash for drift detection
   - Provides idempotency and audit trail

5. **AccountingSyncConfig**
   - Loads configuration from environment variables
   - Manages account mappings, posting policies, dimension mappings
   - Validates configuration

### Data Flow

```
Stripe Webhook (payout.paid)
  ↓
WebhookEventStore (dedupe check)
  ↓
ProcessPayoutJob (async)
  ↓
PayoutSyncService.pullPayout()
  ↓
PayoutSyncService.summarize()
  ↓
PayoutSyncService.validateTotals()
  ↓
PayoutSyncService.generatePostingInstructions()
  ↓
PayoutSyncService.postToAccounting()
  ↓
SyncLedger.recordSync()
```

## Configuration

All configuration is managed through environment variables:

### Accounting Provider

```bash
# Enable/disable accounting sync
ACCOUNTING_SYNC_ENABLED=true

# Provider selection (currently: quickbooks)
ACCOUNTING_PROVIDER=quickbooks

# QuickBooks Online configuration
QBO_COMPANY_ID=your_company_id
QBO_ENVIRONMENT=sandbox  # or production
QBO_ACCESS_TOKEN=your_access_token
QBO_REFRESH_TOKEN=your_refresh_token
QBO_REALM_ID=your_realm_id
```

### Stripe Configuration

```bash
# Stripe API keys
STRIPE_LIVE_SECRET_KEY=sk_live_...
STRIPE_TEST_SECRET_KEY=sk_test_...

# Webhook secrets (per account)
STRIPE_WEBHOOK_SECRETS=acct_123:whsec_xxx,acct_456:whsec_yyy

# Or use legacy single secret
STRIPE_WEBHOOK_SECRET_LIVE=whsec_...
STRIPE_WEBHOOK_SECRET_TEST=whsec_...

# Multi-account configuration (optional)
STRIPE_ACCOUNTS=acct_123:live:sk_live_...,acct_456:test:sk_test_...
```

### Account Mappings

```bash
# Primary accounts
ACCOUNTING_STRIPE_CLEARING_ACCOUNT=Stripe Clearing
ACCOUNTING_OPERATING_BANK_ACCOUNT=Operating Bank
ACCOUNTING_REVENUE_ACCOUNT=Revenue
ACCOUNTING_REFUNDS_ACCOUNT=Refunds
ACCOUNTING_STRIPE_FEE_ACCOUNT=Stripe Fees
ACCOUNTING_CHARGEBACK_ACCOUNT=Chargebacks
ACCOUNTING_ADJUSTMENT_ACCOUNT=Adjustments

# Revenue mapping by category (optional)
ACCOUNTING_REVENUE_MAPPING=General Giving:Revenue - Donations,Building Fund:Revenue - Building
```

### Posting Policy

```bash
# Granularity: per-payout (default), per-day, per-transaction
ACCOUNTING_POSTING_GRANULARITY=per-payout

# Strategy: je-transfer (default), deposit
ACCOUNTING_POSTING_STRATEGY=je-transfer

# Date source: arrival (default), created
ACCOUNTING_POSTING_DATE_SOURCE=arrival

# Timezone for posting dates
ACCOUNTING_TIMEZONE=America/New_York

# Auto-create missing accounts (not recommended for production)
ACCOUNTING_AUTO_CREATE_ACCOUNTS=false
```

### Dimension Mappings (Optional)

```bash
# Enable dimensions
ACCOUNTING_ENABLE_CLASS=true
ACCOUNTING_ENABLE_DEPARTMENT=true
ACCOUNTING_ENABLE_LOCATION=false

# Class mapping by category
ACCOUNTING_CLASS_MAPPING=General Giving:Class A,Building Fund:Class B

# Department mapping by category
ACCOUNTING_DEPARTMENT_MAPPING=General Giving:Dept 1,Building Fund:Dept 2
```

### Retry Configuration

```bash
# Maximum retry attempts on provider errors
ACCOUNTING_MAX_RETRY_ATTEMPTS=3

# Backoff time between retries (milliseconds)
ACCOUNTING_RETRY_BACKOFF_MS=5000

# Auto-reversal on payout.failed/canceled
ACCOUNTING_AUTO_REVERSAL=false
```

## Webhook Events

The system handles the following Stripe webhook events:

### payout.paid

**Primary event** - Triggers full payout sync workflow:

1. Fetch payout and balance transactions from Stripe API
2. Summarize activity (charges, refunds, fees, disputes, adjustments)
3. Validate totals match payout net amount
4. Generate posting instructions (JE + Transfer or Deposit)
5. Post to accounting system
6. Record in sync ledger

### payout.failed

Updates sync ledger status to `failed`. If payout was previously posted, creates a review task for manual handling.

### payout.canceled

Updates sync ledger status to `canceled`. If payout was previously posted, creates a review task for manual handling.

### payout.created (optional)

Logged but no action taken. The system waits for `payout.paid` before posting to accounting.

## API Endpoints

### GET /api/sync/stripe/payouts/{payoutId}

Check payout sync status.

**Query Parameters:**
- `account` - Stripe account ID (default: 'default')

**Response:**
```json
{
  "payoutId": "po_1234567890",
  "stripeAccountId": "acct_123",
  "status": "posted",
  "provider": "quickbooks",
  "providerDocIds": {
    "journalEntry": "qbo-je-123",
    "transfer": "qbo-transfer-456"
  },
  "createdAt": "2024-01-01T00:00:00.000Z",
  "updatedAt": "2024-01-01T00:00:00.000Z",
  "postingHash": "abc123..."
}
```

### POST /api/sync/stripe/payouts/{payoutId}

Manually trigger payout sync (idempotent).

**Query Parameters:**
- `account` - Stripe account ID (optional)
- `force` - Force re-sync even if already posted (optional, default: false)

**Request Body:**
```json
{
  "account": "acct_123",
  "force": false
}
```

**Response:**
```json
{
  "message": "Payout synced successfully",
  "payoutId": "po_1234567890",
  "stripeAccountId": "acct_123",
  "providerDocIds": {
    "journalEntry": "qbo-je-123",
    "transfer": "qbo-transfer-456"
  },
  "summary": {
    "charges": 10,
    "refunds": 2,
    "fees": 450,
    "total": 12100
  }
}
```

## Accounting Documents

### Default Strategy: Journal Entry + Transfer

**Journal Entry** - Records activity details:

```
Debit:  Stripe Clearing       $15,000  (gross charges)
Credit: Revenue                $15,000

Debit:  Refunds                 $2,000  (refunds)
Credit: Stripe Clearing         $2,000

Debit:  Stripe Fees               $450  (fees)
Credit: Stripe Clearing           $450

Net effect on Stripe Clearing: $12,100 (matches payout net)
```

**Transfer** - Moves funds to operating account:

```
From: Stripe Clearing
To:   Operating Bank
Amount: $12,100
```

### Alternative Strategy: Deposit

**Bank Deposit** - Single document with fund sources:

```
Deposit to: Operating Bank
Lines:
  - Stripe Clearing: $12,100
Total: $12,100
```

### Document Numbers (Idempotency)

Document numbers follow the pattern:
- `STRIPE-{acct}-{payout_id}` - Base
- `STRIPE-{acct}-{payout_id}-JE` - Journal Entry
- `STRIPE-{acct}-{payout_id}-XFER` - Transfer
- `STRIPE-{acct}-{payout_id}-DEP` - Deposit

Where `{acct}` is first 8 characters of Stripe account ID (or 'default').

## Idempotency and Drift Detection

### Event Deduplication

1. **Event ID**: Each Stripe event has a unique `event.id`
2. **WebhookEventStore**: Tracks all received events
3. **Dedupe Check**: Before processing, check if event.id already exists
4. **Fast ACK**: Return 200 immediately for duplicate events

### Payout Idempotency

1. **Payout ID**: Each payout has a unique `payout.id`
2. **SyncLedger**: Tracks all synced payouts
3. **Sync Check**: Before posting, check if payout already synced
4. **Skip or Force**: Skip if already posted, or force re-sync with `?force=true`

### Drift Detection

**Posting Hash**: SHA-256 hash of posting instructions (sorted JSON)

```javascript
const hash = sha256(JSON.stringify(sortedPostingInstructions))
```

**Drift Check**:
1. When re-syncing a payout, compare new hash to stored hash
2. If different, instructions have changed (e.g., mapping updated)
3. Policy options:
   - Skip (use existing posting)
   - Review (create task for manual decision)
   - Reverse and repost (auto-reversal if enabled)

## Error Handling

### Configuration Errors

- **Missing mappings**: Create review task with actionable diagnostics
- **Invalid configuration**: Return 400 with validation errors
- **Provider not configured**: Return 400 with setup instructions

### Provider Errors

- **Token expired**: Attempt refresh, retry
- **Account not found**: Create review task with account setup instructions
- **API rate limit (429)**: Exponential backoff, retry
- **API error (5xx)**: Exponential backoff, retry
- **Hard error**: Create review task, mark event as needs_review

### Validation Errors

- **Totals mismatch**: Create review task with detailed breakdown
- **Currency mismatch**: Create review task (multicurrency not yet implemented)
- **Missing transactions**: Create review task with Stripe link

### Review Tasks

When errors occur, the system creates review tasks with:
- Payout ID and Stripe account
- Error message and diagnostics
- Summary of activity (charges, refunds, fees)
- Links to Stripe dashboard
- Recommended actions

## Testing

### Unit Tests

Run payout sync tests:

```bash
npm test
```

Tests include:
- ✅ Balance transaction summarization
- ✅ Total validation and mismatch detection
- ✅ Posting instructions generation
- ✅ Journal entry line balancing
- ✅ Posting hash generation and drift detection
- ✅ Sync ledger idempotency
- ✅ Accounting provider posting
- ✅ Idempotent posting

### Manual Testing with Stripe CLI

1. Install [Stripe CLI](https://stripe.com/docs/stripe-cli)

2. Forward webhooks to local function:
   ```bash
   stripe listen --forward-to http://localhost:7071/api/stripe/webhook
   ```

3. Trigger payout.paid event:
   ```bash
   stripe trigger payout.paid
   ```

4. Check webhook processing in function logs

5. Query sync status:
   ```bash
   curl http://localhost:7071/api/sync/stripe/payouts/po_xxx?account=acct_xxx
   ```

### Integration Testing

For integration testing with Stripe test mode:

1. Set up test mode API keys
2. Create test payouts in Stripe
3. Configure webhook endpoint to receive test events
4. Verify accounting documents created in QBO sandbox
5. Verify sync ledger records
6. Test idempotency by replaying events

## Production Deployment

### Prerequisites

1. **QuickBooks Online Account**
   - Company ID and Realm ID
   - OAuth 2.0 tokens (access and refresh)
   - API access enabled

2. **Stripe Account**
   - Webhook secret for production
   - API key for production
   - Payouts enabled

3. **Azure Function App**
   - All environment variables configured
   - Sufficient timeout (5+ minutes for large payouts)
   - Queue or Service Bus for async job processing (recommended)

### Deployment Steps

1. **Configure Environment Variables**
   - Set all required configuration in Azure App Settings
   - Use Key Vault for sensitive values (tokens, API keys)

2. **Set Up Webhooks**
   - Add webhook endpoint in Stripe Dashboard
   - Select events: `payout.paid`, `payout.failed`, `payout.canceled`
   - Save webhook secret to environment

3. **Test in Sandbox**
   - Use QBO sandbox and Stripe test mode
   - Process test payouts end-to-end
   - Verify accounting documents

4. **Enable Production**
   - Set `ACCOUNTING_SYNC_ENABLED=true`
   - Set `QBO_ENVIRONMENT=production`
   - Monitor webhook processing

5. **Monitor**
   - Set up Application Insights alerts
   - Monitor webhook event store for failures
   - Monitor sync ledger for review tasks
   - Set up daily reconciliation reports

### Production Considerations

⚠️ **Storage**: Replace in-memory storage with persistent storage:
- Use Azure Table Storage or Cosmos DB for WebhookEventStore
- Use SQL Database for SyncLedger
- Implement proper indexes and TTL policies

⚠️ **Async Processing**: Use Azure Queue Storage or Service Bus:
- Webhook handler enqueues job and returns 200 immediately
- Separate function processes queue messages
- Implement dead letter queue for failed jobs

⚠️ **Token Management**: Implement OAuth token refresh:
- Store tokens securely in Key Vault
- Refresh before expiry
- Handle refresh failures gracefully

⚠️ **Monitoring**: Set up comprehensive monitoring:
- Webhook receipt and processing metrics
- Sync success/failure rates
- Review task creation rate
- Provider API latency and errors

⚠️ **Reconciliation**: Implement regular reconciliation:
- Daily report of synced vs unsynced payouts
- Validate accounting totals match Stripe totals
- Alert on discrepancies

### Troubleshooting

**Issue**: Webhook signature verification fails
- **Solution**: Check that webhook secret matches Stripe dashboard

**Issue**: Totals don't match
- **Solution**: Check for unreported balance transactions, review Stripe dashboard

**Issue**: QBO API errors
- **Solution**: Check token expiry, refresh tokens, verify account access

**Issue**: Duplicate postings
- **Solution**: Check sync ledger, verify idempotency working

**Issue**: Events processed out of order
- **Solution**: System is designed to handle this - check final sync status

## Support and Extension

### Adding a New Accounting Provider

1. Create new provider class extending `BaseAccountingProvider`
2. Implement all required methods
3. Add to `AccountingProviderFactory`
4. Update configuration validation
5. Add provider-specific environment variables
6. Test with provider sandbox/test environment

Example:
```javascript
// services/accounting/xeroProvider.js
const BaseAccountingProvider = require('./baseAccountingProvider');

class XeroProvider extends BaseAccountingProvider {
    async upsertJournalEntry(je) {
        // Xero-specific implementation
    }
    // ... implement other methods
}

module.exports = XeroProvider;
```

### Technical Notes

#### Manual vs Automatic Payouts

The Stripe API has a limitation when fetching balance transactions for payouts:

- **Automatic payouts**: Can use `balanceTransactions.list({ payout: 'po_xxx' })` filter directly
- **Manual payouts**: Cannot filter by payout ID - API returns error "Balance transaction history can only be filtered on automatic transfers, not manual"

**Solution**: The `pullPayout()` method checks the `payout.automatic` field:
- For automatic payouts: uses the efficient payout filter
- For manual payouts: fetches transactions in a date range (±7 days from arrival date) and filters client-side

This ensures compatibility with both payout types without errors.

### Future Enhancements

- [ ] Backfill API endpoint for date range
- [ ] Multicurrency support with exchange rates
- [ ] Per-transaction posting granularity
- [ ] Document attachments (CSV/JSON summaries)
- [ ] Class/Department/Location dimension support
- [ ] Custom reporting categories
- [ ] Automated reconciliation reports
- [ ] Webhook retry with exponential backoff
- [ ] Admin UI for review task management

## License

MIT License - See LICENSE file for details
