# Stripe True-Up Quick Reference

## Endpoint
```
GET/POST https://payment-processing-function.azurewebsites.net/api/stripe/true-up
```

## Authentication
- **Method**: Azure Function Key (automatically handled by Azure)
- **Parameter**: `code` (function key passed as query parameter)
- **No manual token needed**: Azure handles authentication

## Query Parameters

| Parameter | Required | Type | Default | Description |
|-----------|----------|------|---------|-------------|
| `from` | ✅ Yes | Date string | - | Start date (ISO 8601 or YYYY-MM-DD) |
| `to` | ❌ No | Date string | null | End date (ISO 8601 or YYYY-MM-DD) |
| `type` | ❌ No | String | `payments` | Type: `payments`, `refunds`, or `payouts` |
| `dryRun` | ❌ No | Boolean | `false` | If `true`, preview without persisting |
| `resubmit` | ❌ No | Boolean | `false` | If `true`, reprocess transactions not in Salesforce (bypasses idempotency check) |
| `limit` | ❌ No | Integer | `null` | Max number of records to process for this run (must be positive) |
| `bypassQbo` | ❌ No | Boolean | `false` | If `true`, skips QBO posting and only performs Salesforce/idempotency updates |
| `skipQbo` | ❌ No | Boolean | `false` | Alias for `bypassQbo` |

### Optional Headers

| Header | Type | Description |
|--------|------|-------------|
| `x-bypass-qbo` | Boolean | Header-based QBO bypass override |
| `x-skip-qbo` | Boolean | Header-based alias for QBO bypass |

> **New!** See [RESUBMIT_FEATURE.md](./RESUBMIT_FEATURE.md) for details on the `resubmit` parameter for backfilling data.

### Quick Start

### 1. Get Your Function Key
```powershell
# Get the function key from Azure Portal:
# Azure Portal → Function App → Functions → stripeTrueUp → Function Keys → default
$functionKey = "your-function-key-here"
```

### 2. Run the Script
```powershell
# Dry run to test (recommended first)
.\scripts\test-true-up.ps1 -From "2024-01-01" -To "2024-01-31" -Type payments -DryRun $true -FunctionKey $functionKey

# Actual sync
.\scripts\test-true-up.ps1 -From "2024-01-01" -To "2024-01-31" -Type payments -DryRun $false -FunctionKey $functionKey
```

## Response Format

### Success Response (200)
```json
{
  "type": "payments",
  "dryRun": true,
  "resubmit": false,
  "bypassQbo": false,
  "limit": null,
  "liveMode": false,
  "range": {
    "from": "2024-01-01T00:00:00.000Z",
    "to": "2024-01-31T23:59:59.999Z"
  },
  "counts": {
    "fetched": 150,
    "processed": 145,
    "skipped": 3,
    "salesforceUpdates": 145,
    "qboPosts": 145,
    "errors": 2
  }
}
```

### Error Responses

**401 Unauthorized** - Missing or invalid function key:
```json
{
  "error": "unauthorized",
  "message": "Function key is required."
}
```

**400 Bad Request** - Missing required parameters:
```json
{
  "error": "bad_request",
  "message": "Query parameter 'from' is required."
}
```

**500 Internal Server Error** - Processing error:
```json
{
  "error": "internal_error",
  "message": "Failed to complete Stripe true-up operation."
}
```

## Common Use Cases

### Sync Historic Payments
```powershell
.\scripts\test-true-up.ps1 -From "2024-01-01" -To "2024-12-31" -Type payments -FunctionKey $functionKey
```

### Process Only First 5 Records
```powershell
curl -X GET `
  "https://payment-processing-function.azurewebsites.net/api/stripe/true-up?from=2024-01-01&to=2024-01-31&type=payments&limit=5&code=$functionKey"
```

### Salesforce-Only Backfill (Skip QBO)
```powershell
curl -X GET `
  "https://payment-processing-function.azurewebsites.net/api/stripe/true-up?from=2024-01-01&to=2024-01-31&type=payments&resubmit=true&bypassQbo=true&limit=25&code=$functionKey"
```

### Sync Recent Refunds
```powershell
.\scripts\test-true-up.ps1 -From "2024-10-01" -Type refunds -FunctionKey $functionKey
```

### Sync Payouts for Q3
```powershell
.\scripts\test-true-up.ps1 -From "2024-07-01" -To "2024-09-30" -Type payouts -FunctionKey $functionKey
```

### Preview Before Syncing (Dry Run)
```powershell
# Always test with dry run first
.\scripts\test-true-up.ps1 -From "2024-01-01" -DryRun $true -FunctionKey $functionKey

# Review the output, then run for real
.\scripts\test-true-up.ps1 -From "2024-01-01" -DryRun $false -FunctionKey $functionKey
```

## What Gets Synced?

### Payments (type=payments)
- ✅ Charges with `status = 'succeeded'`
- ❌ Skips: pending, failed, or cancelled charges
- Creates: Salesforce Transaction + QBO Sales Receipt/Journal Entry

### Refunds (type=refunds)
- ✅ Refunds with `status = 'succeeded'`
- ❌ Skips: pending or failed refunds
- Creates: Salesforce Transaction + QBO Journal Entry (refund)

### Payouts (type=payouts)
- ✅ Payouts with `status = 'paid'`
- ❌ Skips: pending, in_transit, cancelled, or failed payouts
- Creates: Salesforce payout linkage + QBO Bank Deposit

## Safety Features

1. **Idempotency**: Safe to re-run on same date ranges - won't create duplicates
2. **Status Filtering**: Only successful transactions are synced to QBO
3. **Historic Dates**: Preserves original transaction dates from Stripe
4. **Dry Run Mode**: Preview results without making any changes
5. **Error Handling**: Continues processing even if individual transactions fail

## Troubleshooting

### 404 Not Found
- ✅ **Solution**: Include the `code` parameter with your function key
- Use: `?code=your-function-key` in the URL query string

### 401 Unauthorized
- Check that the function key is valid and from the correct function
- Ensure the `code` parameter is included in the URL with the correct key
- Verify the function key hasn't expired or been regenerated

### No Data Synced (0 processed)
- Check date range includes actual Stripe data
- Verify `STRIPE_TRUE_UP_MODE` environment variable (`test` vs `live`)
- Review logs for skipped transactions (may be due to status filtering)

### Some Transactions Skipped
- **Expected**: Failed/pending transactions are intentionally skipped
- Review response `counts.skipped` vs `counts.errors`
- Check Azure logs for detailed skip reasons

### Invalid `limit` Error
- `limit` must be a positive integer (`1`, `5`, `100`, etc.)
- Invalid values return `400 bad_request`

## Best Practices

1. **Always test with dry run first**: `dryRun=true`
2. **Start with small date ranges**: Test 1 month before doing full year
3. **Use `limit` for controlled backfills**: Start with `limit=5` or `limit=25`
4. **Check QBO after sync**: Verify entries look correct
5. **Use `bypassQbo=true` for Salesforce-only correction runs**
6. **Use type-specific syncs**: Sync payments, refunds, and payouts separately
7. **Schedule during off-hours**: Large syncs can take time

## Monitoring

Check Azure Application Insights for:
- Request duration
- Success/failure rates
- Skipped transaction reasons
- Error details

Search for log entries:
- `[StripeTrueUp]` - Main processing logs
- `Skipping charge with non-successful status` - Status filtering
- `Skipping refund with non-successful status` - Refund filtering
- `Skipping payout with non-paid status` - Payout filtering
