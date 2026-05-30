# QBO Duplicate Detection - Quick Reference

## What It Does
Prevents duplicate transactions from being posted to QuickBooks by:
1. Checking DocNumbers before creating new documents
2. **For payouts**: Also checking if a deposit already exists with the same Stripe payout ID

## How to Check Logs

### See if Duplicate Was Found
```powershell
# Look for this in logs
[QBO] Duplicate document found: { entity: 'sales-receipt', docNumber: 'CHG-20240101-3ABC123', existingId: '12345' }
```

### See if Query Failed
```powershell
# Look for this in logs
[QBO] Duplicate check failed, proceeding with post: { entity: 'sales-receipt', docNumber: 'CHG-20240101-3ABC123', error: 'Query timeout' }
```

### Enable Debug Logging
```powershell
$env:LOG_LEVEL = "debug"
```

## Document Types and Prefixes

| Type | Prefix | Function | Example DocNumber |
|------|--------|----------|-------------------|
| Charge (Sales Receipt) | `CHG` | `postChargeToQbo()` | `CHG-20240101-3ABC123` |
| Charge (Journal Entry) | `CHGJE` | `postChargeToQbo()` | `CHGJE-20240101-10300` |
| Fee | `FEE` | `postChargeToQbo()` | `FEE-20240101-300` |
| Refund | `REF` | `postRefundToQbo()` | `REF-20240115-5000` |
| Payout | `PO` | `postPayoutToQbo()` | `PO-20240120-125000` |
| Dispute | `DSP` | `postDisputeToQbo()` | `DSP-20240125-7500` |

## Testing Duplicate Detection

### 1. Manual Test in QBO Sandbox
```powershell
# Post a charge twice with the same data
curl -X POST "https://your-function-app.azurewebsites.net/api/stripe/webhook" `
  -H "Content-Type: application/json" `
  -d '{"type":"charge.succeeded","data":{"object":{"id":"ch_test123",...}}}'

# Second call should return existing ID
```

### 2. Check QuickBooks
- Go to Sales → Sales Receipts (or appropriate section)
- Search for DocNumber
- Verify only one exists

### 3. Run Unit Tests
```powershell
npm test -- qboDuplicateCheck.test.ts
```

## Common Issues

### Issue: Still Seeing Duplicates
**Check:**
1. Are DocNumbers the same? (Check QBO documents)
2. Is duplicate detection running? (Check debug logs)
3. Is the query failing? (Check warning logs)

**Fix:**
- Enable debug logging: `$env:LOG_LEVEL = "debug"`
- Check QBO audit log for creation times
- Review error logs

### Issue: Legitimate Transactions Rejected
**Check:**
1. Is there actually a duplicate in QBO?
2. Is the DocNumber collision happening?

**Fix:**
- Search QBO for the DocNumber
- If found, determine if it's actually a duplicate or different transaction
- If different, the DocNumber logic may need adjustment

### Issue: Slow Performance
**Check:**
1. Are queries taking > 1 second?
2. Is QBO API rate limited?

**Fix:**
- Monitor query duration in logs
- Check QBO API quota
- Contact QBO support if persistent

## Response Format

### New Document Created
```json
{
  "id": "12345",
  "type": "sales-receipt",
  "raw": {
    "SalesReceipt": { "Id": "12345", ... }
  }
}
```

### Duplicate Found
```json
{
  "id": "12345",
  "type": "sales-receipt",
  "raw": {
    "duplicate": true,
    "existingId": "12345"
  }
}
```

### Duplicate Found After Error
```json
{
  "id": "12345",
  "type": "sales-receipt",
  "raw": {
    "duplicate": true,
    "existingId": "12345",
    "recoveredFromError": true
  }
}
```

## Rollback Plan

If duplicate detection causes issues:

1. **Quick Disable** (Not Recommended):
   ```typescript
   // In qboSvc.ts, line ~2125, comment out duplicate check
   ```

2. **Redeploy Previous Version**:
   ```powershell
   git checkout <previous-commit>
   func azure functionapp publish payment-processing-function
   ```

3. **Report Issue**:
   - Capture logs showing the problem
   - Note affected DocNumbers
   - Document expected vs actual behavior

## Monitoring Queries

### See All Duplicate Checks (Debug Mode)
```
[QBO] Checking for duplicate: { entity: 'sales-receipt', docNumber: 'CHG-20240101-3ABC123', queryString: "SELECT Id FROM SalesReceipt WHERE DocNumber = 'CHG-20240101-3ABC123'" }
```

### See Successful Detections
```
[QBO] Duplicate document found: { entity: 'sales-receipt', docNumber: 'CHG-20240101-3ABC123', existingId: '12345', count: 1 }
```

### See Warnings
```
[QBO] Duplicate check failed, proceeding with post: { entity: 'sales-receipt', docNumber: 'CHG-20240101-3ABC123', error: 'QuickBooks query failed (status 500)' }
```

## FAQ

**Q: Does this work for all document types?**
A: Yes - Sales Receipts, Journal Entries, and Bank Deposits.

**Q: What if the duplicate check fails?**
A: The transaction will still be posted. We prefer to risk a duplicate than fail a legitimate transaction.

**Q: Can I disable it?**
A: Not recommended. If necessary, modify the code as shown in Rollback Plan.

**Q: Does it slow down posting?**
A: Minimal impact (<100ms in most cases). DocNumber fields are indexed in QBO.

**Q: What if DocNumbers collide accidentally?**
A: Very unlikely with current format (date + Stripe ID or amount). If it happens, the existing transaction will be returned, which may be incorrect.

**Q: Is the duplicate check cached?**
A: No. Each post operation checks QBO directly for the most up-to-date data.

## Related Docs
- [Full Documentation](./QBO_DUPLICATE_DETECTION.md)
- [Environment Variables](./ENVIRONMENT_VARIABLES.md)
- [Troubleshooting](./TROUBLESHOOTING_500_ERROR.md)
