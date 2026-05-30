# Resubmit Feature - Quick Reference

## What is Resubmit?

**Resubmit mode** allows you to reprocess Stripe transactions while automatically skipping those already in Salesforce. Perfect for backfilling data or recovering from failures.

## Quick Start

### Basic Resubmit Command
```bash
curl -X POST "https://your-function.azurewebsites.net/api/stripeTrueUp?from=2024-01-01&type=payments&resubmit=true"
```

### With Date Range
```bash
curl -X POST "https://your-function.azurewebsites.net/api/stripeTrueUp?from=2024-01-01&to=2024-01-31&type=payments&resubmit=true"
```

### Dry Run (Preview Only)
```bash
curl -X POST "https://your-function.azurewebsites.net/api/stripeTrueUp?from=2024-01-01&type=payments&resubmit=true&dryRun=true"
```

## Key Differences

### Normal Mode (resubmit=false)
✅ Fast - checks local store  
✅ No API calls to Salesforce  
❌ Never reprocesses once done  

### Resubmit Mode (resubmit=true)
✅ Reprocesses if not in Salesforce  
✅ Safe - checks before creating duplicates  
❌ Slower - queries Salesforce each time  

## Common Scenarios

### Backfill Last 30 Days of Payments
```http
POST /api/stripeTrueUp?from=-30d&type=payments&resubmit=true
```

### Recover Failed Refunds from Yesterday
```http
POST /api/stripeTrueUp?from=-1d&type=refunds&resubmit=true
```

### Reprocess January 2024 Payouts
```http
POST /api/stripeTrueUp?from=2024-01-01&to=2024-01-31&type=payouts&resubmit=true
```

### Preview Before Processing
```http
POST /api/stripeTrueUp?from=2024-01-01&resubmit=true&dryRun=true
```

## Parameters

| Parameter | Values | Default | Required |
|-----------|--------|---------|----------|
| `from` | ISO date or `-7d` | - | ✅ Yes |
| `to` | ISO date or `-1d` | now | ❌ No |
| `type` | `payments`, `refunds`, `payouts` | `payments` | ❌ No |
| `resubmit` | `true`, `false` | `false` | ❌ No |
| `dryRun` | `true`, `false` | `false` | ❌ No |

## How It Works

### For Payments
1. ✅ Fetch from Stripe
2. 🔍 Query Salesforce by `stripe_charge_id__c`
3. ⏭️ Skip if found, ✨ Process if not found

### For Refunds
1. ✅ Fetch from Stripe
2. 🔍 Query Salesforce by `stripe_refund_id__c`
3. ⏭️ Skip if found, ✨ Process if not found

### For Payouts
1. ✅ Fetch from Stripe
2. 🔍 Query Salesforce by `stripe_payout_id__c`
3. ⏭️ Skip if found, ✨ Link if not found

## Response Example

```json
{
  "type": "payments",
  "resubmit": true,
  "dryRun": false,
  "counts": {
    "fetched": 100,      // Total from Stripe
    "skipped": 60,       // Already in Salesforce
    "processed": 38,     // Successfully processed
    "errors": 2          // Failed to process
  }
}
```

## Best Practices

1. **Always dry run first**: `&dryRun=true`
2. **Use date ranges**: Don't process all history at once
3. **Check response counts**: Verify expected behavior
4. **Monitor logs**: Watch for errors or unexpected skips
5. **Run off-peak**: For large batches (>1000 transactions)

## When to Use Resubmit

✅ **DO use** for:
- Initial data migration
- Recovering from partial failures
- Backfilling after config changes
- One-time historical imports

❌ **DON'T use** for:
- Regular scheduled syncs (use normal mode)
- Real-time webhook processing
- Small incremental updates

## Troubleshooting

### Nothing is being processed
- Check if records already exist in Salesforce
- Use `dryRun=true` to see what would happen
- Verify date range captures the right transactions

### Everything is being reprocessed
- Confirm transactions don't exist in Salesforce
- Check external ID fields are properly configured
- Verify you're using the right `type` parameter

### Slow performance
- Reduce date range
- Process in smaller batches
- Run during off-peak hours
- Consider Salesforce API limits

## Examples by Date Format

### Absolute Dates
```http
# Specific date
from=2024-01-15

# Date range
from=2024-01-01&to=2024-01-31

# ISO 8601 with time
from=2024-01-01T00:00:00Z
```

### Relative Dates
```http
# Last 7 days
from=-7d

# Last 30 days
from=-30d

# Last 24 hours
from=-1d

# Last hour
from=-1h
```

## Quick Commands

### PowerShell
```powershell
# Dry run
Invoke-RestMethod -Method Post -Uri "https://your-function.azurewebsites.net/api/stripeTrueUp?from=2024-01-01&resubmit=true&dryRun=true"

# Actual run
Invoke-RestMethod -Method Post -Uri "https://your-function.azurewebsites.net/api/stripeTrueUp?from=2024-01-01&resubmit=true"
```

### Bash/cURL
```bash
# Dry run
curl -X POST "https://your-function.azurewebsites.net/api/stripeTrueUp?from=2024-01-01&resubmit=true&dryRun=true"

# Actual run
curl -X POST "https://your-function.azurewebsites.net/api/stripeTrueUp?from=2024-01-01&resubmit=true"
```

## Log Messages

### Success
```
[StripeTrueUp] Skipping charge already in Salesforce
  chargeId: ch_xxx
  salesforceId: a01xxx
```

### Processing
```
[StripeTrueUp] Processing charge
  chargeId: ch_xxx
```

### Error
```
[StripeTrueUp] Failed to process payment
  chargeId: ch_xxx
  error: <error message>
```

## Need More Details?

See the full documentation: [RESUBMIT_FEATURE.md](./RESUBMIT_FEATURE.md)
