# Resubmit Feature for Stripe True-Up

## Overview

The `resubmit` parameter enables reprocessing of historical Stripe transactions while intelligently skipping records that already exist in Salesforce. This is useful for:

- **Backfilling historical data** after system migrations
- **Recovering from partial processing failures** without creating duplicates
- **Rerunning true-up jobs** after configuration changes

## How It Works

### Normal Mode (resubmit=false, default)
- Uses local **idempotency store** to track processed transactions
- Once processed, transactions are permanently skipped
- Fast, efficient, prevents any reprocessing

### Resubmit Mode (resubmit=true)
- **Bypasses the idempotency store**
- Queries **Salesforce directly** to check if records exist
- Only skips transactions that are already in Salesforce
- Allows reprocessing of transactions not yet in Salesforce

## Usage

Add the `resubmit=true` query parameter to your stripeTrueUp HTTP request:

```http
POST /api/stripeTrueUp?from=2024-01-01&type=payments&resubmit=true
```

### Complete Examples

#### Resubmit All Payments from January 2024
```http
POST /api/stripeTrueUp?from=2024-01-01&to=2024-01-31&type=payments&resubmit=true
```

#### Resubmit Recent Refunds (Last 7 Days)
```http
POST /api/stripeTrueUp?from=-7d&type=refunds&resubmit=true
```

#### Dry Run with Resubmit
```http
POST /api/stripeTrueUp?from=2024-01-01&type=payments&resubmit=true&dryRun=true
```
*Checks what would be resubmitted without actually processing*

#### Resubmit Payouts from Last Month
```http
POST /api/stripeTrueUp?from=-30d&type=payouts&resubmit=true
```

## Query Parameters

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `from` | string | **required** | Start date (ISO 8601 or relative like `-7d`) |
| `to` | string | optional | End date (ISO 8601 or relative) |
| `type` | string | `payments` | Transaction type: `payments`, `refunds`, or `payouts` |
| `resubmit` | boolean | `false` | Enable resubmit mode |
| `dryRun` | boolean | `false` | Preview without processing |

## Technical Details

### Payments
**Normal Check**: `idempotencyStore.isProcessed(bt_${balanceTransactionId})`

**Resubmit Check**: 
```typescript
salesforce.findTransactionIdByExternalId('stripe_charge_id__c', chargeId)
```
- Queries Salesforce for existing transaction by Stripe charge ID
- Skips only if Salesforce record exists
- Processes charge if not found in Salesforce

### Refunds
**Normal Check**: `idempotencyStore.isProcessed(bt_${balanceTransactionId})`

**Resubmit Check**:
```typescript
salesforce.findTransactionIdByExternalId('stripe_refund_id__c', refundId)
```
- Queries Salesforce for existing refund record
- Skips only if found in Salesforce
- Processes refund if not found

### Payouts
**Normal Check**: `idempotencyStore.isProcessed(payout_${payoutId})`

**Resubmit Check**:
```typescript
salesforce.findTransactionIdByExternalId('stripe_payout_id__c', payoutId)
```
- Queries for any transaction with this payout ID linked
- If any transaction has this payout, skip the entire payout
- Otherwise, links payout to all related transactions

## Response Format

The API response includes the `resubmit` status:

```json
{
  "type": "payments",
  "dryRun": false,
  "resubmit": true,
  "liveMode": false,
  "range": {
    "from": "2024-01-01T00:00:00.000Z",
    "to": "2024-01-31T23:59:59.999Z"
  },
  "counts": {
    "fetched": 150,
    "processed": 75,
    "skipped": 70,
    "salesforceUpdates": 75,
    "qboPosts": 75,
    "errors": 5
  }
}
```

### Understanding the Counts

- **fetched**: Total transactions retrieved from Stripe
- **skipped**: Transactions already in Salesforce (in resubmit mode) or in idempotency store (normal mode)
- **processed**: Transactions successfully processed
- **salesforceUpdates**: Salesforce records created/updated
- **qboPosts**: QuickBooks records created
- **errors**: Transactions that failed to process

## Use Cases

### 1. Initial Data Migration
When first setting up the integration, use resubmit to import historical data:

```http
POST /api/stripeTrueUp?from=2023-01-01&type=payments&resubmit=true
```

### 2. Recovery After Failures
If a job partially completes and some records fail:

1. First, check what would be reprocessed:
   ```http
   POST /api/stripeTrueUp?from=2024-03-01&type=payments&resubmit=true&dryRun=true
   ```

2. Then resubmit:
   ```http
   POST /api/stripeTrueUp?from=2024-03-01&type=payments&resubmit=true
   ```

### 3. Configuration Changes
After changing metadata mapping or adding new fields, reprocess to update existing records:

```http
POST /api/stripeTrueUp?from=2024-01-01&type=payments&resubmit=true
```

*Note: Salesforce upserts will update existing records with new data*

### 4. Customer Sync Backfill
After implementing customer sync feature, backfill historical customers:

```http
POST /api/stripeTrueUp?from=2023-01-01&type=payments&resubmit=true
```

*Customer records will be created/updated based on charge metadata*

## Important Notes

### Performance Considerations
- **Resubmit mode is slower** than normal mode because it queries Salesforce for each transaction
- Use date ranges (`from`/`to`) to limit the scope
- Consider running during off-peak hours for large backfills

### Idempotency Store Behavior
- In resubmit mode, the idempotency store is **still updated** after successful processing
- This ensures that future normal runs won't reprocess these transactions
- The idempotency store is only **bypassed for the check**, not for the update

### Salesforce Query Limits
- Each resubmit check performs a SOQL query
- Be mindful of Salesforce API limits when processing large batches
- For very large backfills (>10,000 transactions), consider breaking into smaller date ranges

### Customer Upserts
- Customer sync happens during payment/refund processing
- Uses Stripe customer ID as external ID for upserts
- Existing customers are updated with latest information
- Customer name comes from `category` metadata field

## Error Handling

### Payout Query Failures
For payouts, if the Salesforce query fails, the system logs the error but **continues processing**:

```
[StripeTrueUp] Failed to check payout in Salesforce, will process
```

This ensures payout processing isn't blocked by transient Salesforce issues.

### Transaction Processing Errors
Errors during individual transaction processing are logged and counted in the `errors` field, but don't stop the batch.

## Monitoring & Logging

Watch for these log messages in resubmit mode:

**Skipping already-synced payments:**
```
[StripeTrueUp] Skipping charge already in Salesforce
  chargeId: ch_xxx
  salesforceId: a01xxx
```

**Skipping already-synced refunds:**
```
[StripeTrueUp] Skipping refund already in Salesforce
  refundId: re_xxx
  salesforceId: a01xxx
```

**Skipping already-synced payouts:**
```
[StripeTrueUp] Skipping payout already linked in Salesforce
  payoutId: po_xxx
  salesforceId: a01xxx
```

## Best Practices

1. **Always test with dryRun first**
   ```http
   POST /api/stripeTrueUp?from=2024-01-01&resubmit=true&dryRun=true
   ```

2. **Use specific date ranges** rather than processing all history at once

3. **Monitor the response counts** to ensure expected behavior

4. **Check Salesforce and QuickBooks** after processing to verify records

5. **Run during low-traffic periods** for large backfills

6. **Keep resubmit=false for scheduled jobs** - only use resubmit for one-time backfills

## Comparison: Normal vs Resubmit

| Aspect | Normal Mode | Resubmit Mode |
|--------|-------------|---------------|
| **Check Method** | Local idempotency store | Salesforce SOQL query |
| **Speed** | Fast | Slower |
| **API Calls** | None for duplicates | One per transaction |
| **Use Case** | Regular scheduled syncs | One-time backfills |
| **Reprocessing** | Never | If not in Salesforce |
| **Idempotency Store** | Check + Update | Update only |

## Related Documentation

- [STRIPE_TRUE_UP_DEPLOYMENT_GUIDE.md](./STRIPE_TRUE_UP_DEPLOYMENT_GUIDE.md) - Complete deployment guide
- [stripe-true-up-quick-reference.md](./stripe-true-up-quick-reference.md) - Quick reference
- [CUSTOMER_SYNC_IMPLEMENTATION.md](./CUSTOMER_SYNC_IMPLEMENTATION.md) - Customer sync feature
- [ENVIRONMENT_VARIABLES.md](./ENVIRONMENT_VARIABLES.md) - Configuration

## Code Reference

**Implementation File**: `src/handlers/stripeTrueUp.ts`

**Key Functions**:
- `processPayments()` - Lines ~426-550
- `processRefunds()` - Lines ~576-725
- `processPayouts()` - Lines ~755-870

**Parameter Parsing**: Lines ~918-920

## Support

If you encounter issues with resubmit mode:

1. Check Salesforce API limits and permissions
2. Review application logs for specific error messages
3. Verify external ID fields exist in Salesforce:
   - `stripe_charge_id__c`
   - `stripe_refund_id__c`
   - `stripe_payout_id__c`
4. Test with a small date range first
5. Use `dryRun=true` to preview behavior
