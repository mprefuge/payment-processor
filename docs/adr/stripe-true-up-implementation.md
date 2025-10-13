# Implementation Summary: Stripe True-Up Endpoint

## Overview

This document summarizes the implementation of the manual Stripe true-up endpoint for the payment-processor repository.

## Problem Statement

The requirement was to:
> Add a manual true up endpoint that when triggered, it queries Stripe and syncs the payments, payouts, etc. accordingly through the stripeWebhook. It needs to use proper pagination and incorporate best practices when working with Stripe's api to ensure rate limiting, etc. is taken into consideration.

## Solution

Created a new Azure Function endpoint (`POST /api/sync/stripe/true-up`) that allows manual synchronization of Stripe data for backfilling, migration, and reconciliation purposes.

## Implementation Details

### Files Created

1. **`stripeTrueUp/function.json`** - Azure Function HTTP trigger configuration
2. **`stripeTrueUp/index.js`** - Main endpoint handler with RateLimiter class
3. **`stripeWebhook/payoutProcessor.js`** - Extracted reusable payout processing logic
4. **`tests/stripeTrueUp.test.js`** - Test suite (7 tests, all passing)
5. **`STRIPE_TRUE_UP.md`** - Complete API documentation
6. **`examples/stripe-true-up-example.js`** - Usage examples

### Files Modified

1. **`package.json`** - Added new test to test suite
2. **`README.md`** - Added feature description and quick reference

## Key Features

### 1. Proper Pagination
- Uses existing `fetchStripePayoutsSince`, `fetchStripeChargesSince`, etc.
- Implements cursor-based pagination with `starting_after`
- Guardrail: max 1000 pages per resource (configurable via `MAX_AUTOPAGE`)
- Automatically handles `has_more` flag from Stripe API

### 2. Rate Limiting Best Practices
- **Exponential backoff**: Base delay 1s, multiplied by 2^attempt (1s → 2s → 4s → ...)
- **Jitter**: Random delay 0-1000ms added to prevent thundering herd
- **Max delay cap**: 30 seconds maximum
- **Max retries**: 3 attempts for rate limit errors
- **Inter-request delay**: 100ms pause between processing payouts
- **Error detection**: Catches `StripeRateLimitError` specifically

### 3. Stripe API Best Practices
- Reuses existing Stripe client initialization
- Respects `DEFAULT_LIMIT=100` for efficient pagination
- Proper error handling and logging
- Uses webhook processing flow for consistency
- Creates synthetic webhook events for tracking

### 4. Idempotency
- Checks sync ledger before processing each payout
- Skips payouts with `status='posted'`
- Prevents duplicate accounting entries
- Safe to run multiple times on same data

### 5. Dry Run Mode
- `dryRun: true` fetches data without processing
- Preview what would be synced
- Useful for planning and verification

### 6. Multi-Account Support
- `account` parameter for Stripe Connect accounts
- Default account ID: "default"
- Tracks account ID in sync ledger

### 7. Selective Resource Syncing
- `resources` array parameter
- Options: `payouts`, `charges`, `refunds`, `disputes`
- Default: `["payouts"]`
- Currently only payouts are fully processed (others fetched for reporting)

## API Usage

### Request
```json
POST /api/sync/stripe/true-up
{
  "since": "2024-01-01T00:00:00Z",
  "account": "acct_123",
  "dryRun": false,
  "resources": ["payouts"]
}
```

### Response
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

## Technical Architecture

### Flow Diagram
```
Client Request
    ↓
stripeTrueUp/index.js
    ↓
[Validate request body]
    ↓
[Initialize Stripe client]
    ↓
[For each resource type]
    ↓
fetchStripePayoutsSince() ← Uses pagination
    ↓                          with rate limiting
[Filter: status='paid']
    ↓
[Check sync ledger] → Skip if already synced
    ↓
[Create synthetic event]
    ↓
processPayoutPaid() ← Reuses webhook logic
    ↓
[Post to accounting]
    ↓
[Record in sync ledger]
    ↓
[Return summary]
```

### Code Reuse
- **Pagination**: Reuses `services/accounting/stripe-qbo/fetchStripe.js`
  - `fetchStripePayoutsSince()`
  - `fetchStripeChargesSince()`
  - `fetchStripeRefundsSince()`
  - `fetchStripeDisputesSince()`
  - All implement `fetchAll()` with proper pagination

- **Processing**: Extracted from `stripeWebhook/index.js` into `stripeWebhook/payoutProcessor.js`
  - `processPayoutPaid()` - Main payout processing
  - `processPayoutJob()` - Async job processor
  - `createContextLogger()` - Logger wrapper
  - `getCrmServiceInstance()` - CRM initialization

## Rate Limiting Implementation

### RateLimiter Class
```javascript
class RateLimiter {
    constructor(maxRetries = 3, baseDelay = 1000) { ... }
    
    async executeWithRetry(fn, context) {
        for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
            try {
                return await fn();
            } catch (error) {
                if (error.type === 'StripeRateLimitError' && attempt < maxRetries) {
                    const delay = this.calculateDelay(attempt);
                    await this.sleep(delay);
                    continue;
                }
                throw error;
            }
        }
    }
    
    calculateDelay(attempt) {
        // Exponential: 2^attempt * baseDelay
        const exponentialDelay = this.baseDelay * Math.pow(2, attempt);
        // Jitter: random 0-1000ms
        const jitter = Math.random() * 1000;
        // Cap at 30s
        return Math.min(exponentialDelay + jitter, 30000);
    }
}
```

### Usage in Code
```javascript
const rateLimiter = new RateLimiter();

const payouts = await rateLimiter.executeWithRetry(
    () => fetchStripePayoutsSince(stripe, since, { logger }),
    context
);
```

## Testing

### Test Coverage
1. ✅ Request body validation
2. ✅ Since parameter format handling (ISO string, Unix timestamp, Date)
3. ✅ Rate limiter exponential backoff calculation
4. ✅ Dry run mode
5. ✅ Resources parameter
6. ✅ Stripe account ID support
7. ✅ Response structure validation

### Running Tests
```bash
npm test                           # All tests
node tests/stripeTrueUp.test.js   # Just true-up tests
```

## Configuration

### Environment Variables
- `STRIPE_TRUE_UP_MODE` - Set to "live" for live mode (default: test)
- `STRIPE_LIVE_SECRET_KEY` - Live Stripe API key
- `STRIPE_TEST_SECRET_KEY` - Test Stripe API key
- Plus all accounting sync variables (see PAYOUT_SYNC_SETUP.md)

## Use Cases

### 1. Initial Migration
```bash
# Backfill all payouts from 2024
POST /api/sync/stripe/true-up
{
  "since": "2024-01-01T00:00:00Z"
}
```

### 2. Webhook Recovery
```bash
# Sync payouts from last week (webhook failures)
POST /api/sync/stripe/true-up
{
  "since": "2024-12-15T00:00:00Z"
}
```

### 3. Periodic Reconciliation
```bash
# Monthly reconciliation with dry run first
POST /api/sync/stripe/true-up
{
  "since": "2024-12-01T00:00:00Z",
  "dryRun": true
}
```

### 4. Connected Account Sync
```bash
# Sync specific Connect account
POST /api/sync/stripe/true-up
{
  "since": "2024-01-01T00:00:00Z",
  "account": "acct_123456789"
}
```

## Limitations

1. **Payout Processing Only**: Currently only payouts are fully processed through accounting sync. Other resources (charges, refunds, disputes) are fetched but not individually synced since they're included in payout processing.

2. **Execution Time**: Azure Functions have timeout limits (5-10 min consumption, 30+ min premium). For large datasets, use smaller time windows.

3. **Stripe Rate Limits**: Standard plan = 25 req/sec, peak = 100 req/sec burst. Large syncs may take time.

## Best Practices

1. **Always start with dry run**: Preview data before processing
2. **Sync in smaller windows**: Monthly chunks instead of years
3. **Monitor the response**: Check `totalErrors` and investigate
4. **Use for recovery, not regular sync**: Webhooks are the primary sync mechanism

## Documentation

- **API Reference**: `STRIPE_TRUE_UP.md`
- **Usage Examples**: `examples/stripe-true-up-example.js`
- **Payout Sync**: `PAYOUT_SYNC_SETUP.md`
- **Webhook Setup**: `WEBHOOK_PAYOUT_SETUP.md`

## Future Enhancements

Potential improvements for future iterations:

1. **Async Processing**: Use Azure Durable Functions for long-running syncs
2. **Queue-based**: Process payouts via Azure Queue for better scalability
3. **Progress Tracking**: Return job ID for status polling
4. **Parallel Processing**: Process multiple payouts concurrently
5. **Charge/Refund Processing**: Individual sync for non-payout resources
6. **Resume Support**: Resume failed syncs from last successful item

## Conclusion

The implementation successfully meets all requirements:

✅ Manual true-up endpoint created
✅ Queries Stripe for payouts and other resources
✅ Syncs through existing webhook processing flow
✅ Proper cursor-based pagination implemented
✅ Rate limiting with exponential backoff and jitter
✅ Follows Stripe API best practices
✅ Comprehensive tests and documentation
✅ All existing tests continue to pass

The solution is production-ready, well-documented, and follows the existing codebase patterns.
