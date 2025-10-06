# Stripe True-Up Endpoint

## Overview

The Stripe True-Up endpoint allows you to manually query Stripe for payouts, payments, refunds, and disputes since a specific date and sync them to your accounting system. This is useful for:

- Initial data migration
- Recovering from webhook failures
- Periodic reconciliation
- Backfilling historical data

## Endpoint

```
POST /api/sync/stripe/true-up
```

## Features

- ✅ **Automatic pagination** - Handles large datasets using Stripe's cursor-based pagination
- ✅ **Rate limiting** - Implements exponential backoff with jitter to respect Stripe API limits
- ✅ **Idempotency** - Skips already synced payouts to prevent duplicates
- ✅ **Dry run mode** - Preview what would be synced without actually processing
- ✅ **Selective resources** - Choose which resources to sync (payouts, charges, refunds, disputes)
- ✅ **Multi-account support** - Works with Stripe Connect accounts

## Request

### Headers

```
Content-Type: application/json
```

### Body Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `since` | string/number | Yes | ISO 8601 date, Unix timestamp, or Date object |
| `account` | string | No | Stripe Connect account ID (default: "default") |
| `dryRun` | boolean | No | If true, only fetch and report, don't process (default: false) |
| `resources` | array | No | Resources to sync: "payouts", "charges", "refunds", "disputes" (default: ["payouts"]) |

### Example Request

```json
{
  "since": "2024-01-01T00:00:00Z",
  "account": "acct_123",
  "dryRun": false,
  "resources": ["payouts"]
}
```

### Alternative Date Formats

```json
// ISO 8601 string
{
  "since": "2024-01-01T00:00:00Z"
}

// Unix timestamp (seconds)
{
  "since": 1704067200
}

// Milliseconds timestamp (will be converted)
{
  "since": 1704067200000
}
```

## Response

### Success Response (200 OK)

```json
{
  "message": "True-up completed",
  "since": "2024-01-01T00:00:00Z",
  "stripeAccountId": "default",
  "dryRun": false,
  "liveMode": false,
  "results": {
    "payouts": {
      "fetched": 15,
      "processed": 12,
      "skipped": 3,
      "errors": []
    },
    "charges": {
      "fetched": 0,
      "processed": 0,
      "skipped": 0,
      "errors": []
    },
    "refunds": {
      "fetched": 0,
      "processed": 0,
      "skipped": 0,
      "errors": []
    },
    "disputes": {
      "fetched": 0,
      "processed": 0,
      "skipped": 0,
      "errors": []
    }
  },
  "summary": {
    "totalFetched": 15,
    "totalProcessed": 12,
    "totalSkipped": 3,
    "totalErrors": 0
  }
}
```

### Partial Success (207 Multi-Status)

If some resources failed but others succeeded:

```json
{
  "message": "True-up completed",
  "since": "2024-01-01T00:00:00Z",
  "stripeAccountId": "default",
  "dryRun": false,
  "liveMode": false,
  "results": {
    "payouts": {
      "fetched": 15,
      "processed": 10,
      "skipped": 3,
      "errors": [
        {
          "payoutId": "po_123",
          "error": "Totals mismatch"
        }
      ]
    }
  },
  "summary": {
    "totalFetched": 15,
    "totalProcessed": 10,
    "totalSkipped": 3,
    "totalErrors": 2
  }
}
```

### Error Response (400 Bad Request)

```json
{
  "error": "Bad Request",
  "message": "Request body must include \"since\" field (ISO 8601 date or Unix timestamp)"
}
```

### Error Response (500 Internal Server Error)

```json
{
  "error": "Internal Server Error",
  "message": "Error details here"
}
```

## Usage Examples

### Example 1: Backfill All Payouts Since January 1, 2024

```bash
curl -X POST https://your-function-app.azurewebsites.net/api/sync/stripe/true-up \
  -H "Content-Type: application/json" \
  -d '{
    "since": "2024-01-01T00:00:00Z",
    "resources": ["payouts"]
  }'
```

### Example 2: Dry Run to See What Would Be Synced

```bash
curl -X POST https://your-function-app.azurewebsites.net/api/sync/stripe/true-up \
  -H "Content-Type: application/json" \
  -d '{
    "since": "2024-01-01T00:00:00Z",
    "dryRun": true,
    "resources": ["payouts", "charges", "refunds"]
  }'
```

### Example 3: Sync Connected Account

```bash
curl -X POST https://your-function-app.azurewebsites.net/api/sync/stripe/true-up \
  -H "Content-Type: application/json" \
  -d '{
    "since": "2024-01-01T00:00:00Z",
    "account": "acct_123456789",
    "resources": ["payouts"]
  }'
```

### Example 4: Sync Last 30 Days

```javascript
const thirtyDaysAgo = new Date();
thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

fetch('https://your-function-app.azurewebsites.net/api/sync/stripe/true-up', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    since: thirtyDaysAgo.toISOString(),
    resources: ['payouts']
  })
})
.then(response => response.json())
.then(data => console.log('Sync complete:', data.summary));
```

## Configuration

### Environment Variables

The endpoint uses the following environment variables:

| Variable | Description | Example |
|----------|-------------|---------|
| `STRIPE_TRUE_UP_MODE` | Set to "live" to use live mode, otherwise test mode | `live` |
| `STRIPE_LIVE_SECRET_KEY` | Stripe live secret key | `sk_live_...` |
| `STRIPE_TEST_SECRET_KEY` | Stripe test secret key | `sk_test_...` |
| `ACCOUNTING_SYNC_ENABLED` | Enable/disable accounting sync | `true` |
| `ACCOUNTING_PROVIDER` | Accounting provider (e.g., "quickbooks") | `quickbooks` |

Plus all the accounting provider configuration variables (see PAYOUT_SYNC_SETUP.md).

## Rate Limiting

The endpoint implements automatic rate limiting with:

- **Exponential backoff**: Retries with increasing delays (1s, 2s, 4s, ...)
- **Jitter**: Random delay added to prevent thundering herd
- **Max delay cap**: Delays capped at 30 seconds
- **Max retries**: 3 retries for rate limit errors
- **Inter-payout delay**: 100ms delay between processing payouts

### Rate Limit Handling

If Stripe rate limits are encountered:

1. The endpoint will automatically retry with exponential backoff
2. Logs will show: `Rate limited by Stripe. Retrying in Xms (attempt Y/3)`
3. After 3 failed retries, the error is reported in the response

## Best Practices

### 1. Start with a Dry Run

Always start with a dry run to see what would be synced:

```json
{
  "since": "2024-01-01T00:00:00Z",
  "dryRun": true
}
```

### 2. Sync in Smaller Time Windows

For large datasets, sync in smaller windows to avoid timeouts:

```javascript
// Sync one month at a time
const months = [
  "2024-01-01T00:00:00Z",
  "2024-02-01T00:00:00Z",
  "2024-03-01T00:00:00Z"
];

for (const month of months) {
  await syncTrueUp({ since: month });
  await sleep(5000); // Wait 5 seconds between months
}
```

### 3. Monitor the Response

Check the `summary` in the response:

- `totalSkipped`: Payouts already synced (expected)
- `totalErrors`: Payouts that failed (investigate these)
- `totalProcessed`: New payouts successfully synced

### 4. Handle Errors

Review errors in the `results.payouts.errors` array and manually investigate:

```javascript
const response = await syncTrueUp({ since: "2024-01-01" });

if (response.summary.totalErrors > 0) {
  console.log('Errors to investigate:', response.results.payouts.errors);
}
```

### 5. Use for Recovery, Not Regular Sync

This endpoint is designed for:

- ✅ Initial setup / migration
- ✅ Recovering from webhook failures
- ✅ Periodic reconciliation (monthly/quarterly)

**Not** for:

- ❌ Real-time sync (use webhooks instead)
- ❌ Frequent polling (expensive on API limits)

## Idempotency

The endpoint is idempotent:

- Payouts already synced (status = "posted") are skipped
- Synthetic webhook events are created for tracking
- Same request can be safely run multiple times

## Limitations

### 1. Payout Processing Only

Currently, only payouts are fully processed through the accounting sync flow. Other resources (charges, refunds, disputes) are fetched but not individually processed because they are included in the payout sync.

### 2. Timeout Considerations

Azure Functions have execution time limits:

- **Consumption plan**: 5 minutes (default), 10 minutes (max)
- **Premium plan**: 30 minutes (default), unlimited (if configured)

For large datasets, consider:

- Syncing in smaller time windows
- Using Azure Durable Functions for long-running workflows
- Processing asynchronously via queues

### 3. API Rate Limits

Stripe has rate limits:

- **Standard**: 25 requests/second
- **Peak**: Up to 100 requests/second (burst)

The endpoint respects these limits but may take time for large datasets.

## Troubleshooting

### Issue: Configuration Error

```json
{
  "error": "Configuration Error",
  "message": "Stripe API key not configured"
}
```

**Solution**: Set `STRIPE_LIVE_SECRET_KEY` or `STRIPE_TEST_SECRET_KEY` in environment variables.

### Issue: Accounting Sync Disabled

If accounting sync is disabled, payouts won't be processed even if fetched.

**Solution**: Set `ACCOUNTING_SYNC_ENABLED=true` and configure your accounting provider.

### Issue: Payouts Skipped

```json
{
  "results": {
    "payouts": {
      "fetched": 15,
      "processed": 0,
      "skipped": 15
    }
  }
}
```

**Possible reasons**:

1. Payouts already synced (check sync ledger)
2. Payouts not in "paid" status
3. Accounting configuration invalid

**Solution**: Check logs for specific skip reasons.

### Issue: Validation Errors

```json
{
  "errors": [
    {
      "payoutId": "po_123",
      "error": "Totals mismatch"
    }
  ]
}
```

**Solution**: These payouts are recorded with `status: 'needs_review'` in the sync ledger. Manually investigate using the payout sync status endpoint:

```bash
GET /api/sync/stripe/payouts/po_123
```

## Related Documentation

- [PAYOUT_SYNC_SETUP.md](./PAYOUT_SYNC_SETUP.md) - Payout sync configuration
- [WEBHOOK_PAYOUT_SETUP.md](./WEBHOOK_PAYOUT_SETUP.md) - Webhook-based payout sync
- [TESTING_GUIDE.md](./TESTING_GUIDE.md) - Testing strategies

## Support

For issues or questions:

1. Check the Azure Function logs for detailed error messages
2. Review the sync ledger for payout status
3. Verify Stripe webhook configuration for ongoing sync
4. Check accounting provider connection and credentials
