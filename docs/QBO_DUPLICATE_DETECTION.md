# QuickBooks Duplicate Detection

## Overview

The payment processor now includes comprehensive duplicate detection when pushing transactions, payouts, and other documents to QuickBooks Online (QBO). This prevents duplicate entries in the accounting system and ensures data integrity.

## How It Works

### 1. Pre-Post Duplicate Check

Before creating any new document in QuickBooks, the system performs a duplicate check:

```typescript
// Example: Posting a charge to QBO
const result = await postChargeToQbo({
  gross: 10000,
  fee: 300,
  memo: 'Payment for service',
  date: new Date(),
  stripe: { charge: { id: 'ch_123abc' } }
});

// If duplicate is found, result will contain:
// { id: 'existing-qbo-id', type: 'sales-receipt', raw: { duplicate: true, existingId: 'existing-qbo-id' } }
```

The duplicate check:
1. Extracts the `DocNumber` from the document being posted
2. Queries QuickBooks for any existing document with the same `DocNumber`
3. **For payouts**: Also searches for existing deposits containing the Stripe payout ID
4. If found, returns the existing document ID instead of creating a new one
5. If not found, proceeds with creating the new document

### 2. DocNumber-Based Detection

The `DocNumber` field serves as the unique identifier for duplicate detection. DocNumbers are generated using:
- **Prefix**: Indicates document type (CHG, REF, PO, DSP, etc.)
- **Date**: Transaction date in YYYYMMDD format
- **Identifier**: Either the Stripe charge ID or transaction amount

**Examples:**
- `CHG-20240101-3ABC123` - Charge on 2024-01-01 with Stripe charge ID
- `REF-20240115-5000` - Refund on 2024-01-15 for $50.00
- `PO-20240120-125000` - Payout on 2024-01-20 for $1,250.00
- `DSP-20240125-7500` - Dispute on 2024-01-25 for $75.00

### 3. Error Recovery

If QuickBooks rejects a document due to duplicate DocNumber, the system:
1. Catches the duplicate error (HTTP 400 with "Duplicate Document Number" message)
2. Queries QuickBooks to find the existing document
3. Returns the existing document ID
4. Logs the recovery action for audit purposes

```typescript
// Example error recovery log
[QBO] QuickBooks rejected duplicate DocNumber: { entity: 'sales-receipt', docNumber: 'CHG-20240101-3ABC123' }
[QBO] Found existing document after duplicate error: { existingId: '12345' }
```

### 4. Payout-Specific Duplicate Detection

Bank deposits for Stripe payouts have **dual duplicate detection** for extra safety:

#### Primary Check: Date and Amount Search
Searches QuickBooks for deposits with the same transaction date and total amount, but only considers deposits with DocNumber starting with 'PO' (indicating payout deposits). This prevents creating duplicate deposits for the same payout while avoiding false positives from deposits created for other purposes.

#### Secondary Check: General DocNumber
Same as other document types - checks for existing deposits with matching `DocNumber`.

**Why both checks?**
- **Date and amount check** catches duplicates by business logic - identical amounts on the same date are likely the same payout, but only for actual payout deposits (DocNumber starts with 'PO')
- **DocNumber check** provides additional safety for webhook-created deposits with standard DocNumber formats

This prevents duplicates even if:
- The same payout is processed multiple times during true-up
- The payout amount and date are identical to existing payout deposits
- Manual deposits or deposits for other transaction types exist with the same amount on the same date

**Query used:**
```sql
SELECT Id, DocNumber, TxnDate, TotalAmt FROM Deposit 
WHERE TxnDate = '{formattedDate}' 
MAXRESULTS 10
```

**Note:** Amount comparison is done in application code due to QuickBooks query limitations with decimal values.

**Example:**
- Payout date: `2024-10-27`
- Payout amount: `$1,250.00`
- Query: `SELECT Id, DocNumber, TxnDate, TotalAmt FROM Deposit WHERE TxnDate = '2024-10-27' AND TotalAmt = 1250.00 MAXRESULTS 5`

**Example log:**
```
[QBO] Checking for existing payout deposit by date and amount { 
  payoutId: 'po_1SKTfrBS5xFjv3JBMmyUqmWj',
  date: '2024-10-27',
  amount: 1250.00
}
[QBO] Found existing deposit for payout by date and amount check { 
  payoutId: 'po_1SKTfrBS5xFjv3JBMmyUqmWj', 
  existingId: '67890',
  docNumber: 'PO-20241027-125000',
  date: '2024-10-27',
  amount: 1250.00
}
```

## Supported Document Types

Duplicate detection is implemented for all QuickBooks document types:

### Sales Receipts
- **Prefix**: `CHG`
- **Function**: `postChargeToQbo()` with `postingStrategy: 'sales-receipt'`
- **Query**: `SELECT Id FROM SalesReceipt WHERE DocNumber = '{docNumber}'`

### Journal Entries
- **Prefixes**: `CHGJE` (charges), `FEE` (fees), `REF` (refunds), `DSP` (disputes)
- **Functions**: `postChargeToQbo()`, `postRefundToQbo()`, `postDisputeToQbo()`
- **Query**: `SELECT Id FROM JournalEntry WHERE DocNumber = '{docNumber}'`

### Bank Deposits
- **Prefix**: `PO`
- **Function**: `postPayoutToQbo()`
- **Query**: 
  - By DocNumber with payout ID: `SELECT Id, DocNumber FROM Deposit WHERE DocNumber LIKE '%{last10chars of payoutId}%'`
  - By DocNumber: `SELECT Id FROM Deposit WHERE DocNumber = '{docNumber}'`

**Note**: Bank deposits (payouts) have dual duplicate detection:
1. **Primary check** for deposits containing the payout ID embedded in the `DocNumber` field
2. Standard DocNumber check (like all other document types)

This prevents duplicates even if:
- The same payout is processed multiple times
- The payout amount or date differs slightly
- Manual deposits were created with the payout ID in the memo

## Configuration

Duplicate detection is **enabled by default** and requires no configuration. However, you can monitor its behavior through logging.

### Logging Levels

**Debug Level:**
```
[QBO] Checking for duplicate: { entity: 'sales-receipt', docNumber: 'CHG-20240101-3ABC123' }
[QBO] No duplicate found: { entity: 'sales-receipt', docNumber: 'CHG-20240101-3ABC123' }
```

**Info Level:**
```
[QBO] Duplicate document found: { entity: 'sales-receipt', docNumber: 'CHG-20240101-3ABC123', existingId: '12345' }
[QBO] Returning existing document instead of creating duplicate
```

**Warning Level:**
```
[QBO] Duplicate check failed, proceeding with post: { entity: 'sales-receipt', docNumber: 'CHG-20240101-3ABC123', error: 'Query timeout' }
[QBO] No DocNumber in payload, skipping duplicate check: { entity: 'sales-receipt' }
```

## Error Handling

### Query Failures

If the duplicate check query fails (e.g., QBO API timeout), the system:
- Logs a warning
- Proceeds with the POST operation
- **Rationale**: Better to risk a duplicate than to fail a legitimate transaction

### QuickBooks Duplicate Rejection

If QuickBooks rejects the POST with a duplicate error:
- Attempts to find the existing document
- Returns the existing ID if found
- Throws an informative error if not found

### SQL Injection Prevention

DocNumbers are sanitized before being used in SQL queries:
```typescript
// Single quotes are escaped
const docNumber = "CHG-20240101-12'345";
const query = `SELECT Id FROM SalesReceipt WHERE DocNumber = 'CHG-20240101-12\\'345'`;
```

## Performance Considerations

### Query Efficiency

Duplicate checks use targeted SQL queries:
```sql
SELECT Id FROM SalesReceipt WHERE DocNumber = 'CHG-20240101-3ABC123'
```

- QuickBooks indexes DocNumber fields
- Queries typically return in < 100ms
- No impact on posting performance for unique documents

### Caching

The system does NOT cache duplicate check results because:
- DocNumbers are transaction-specific and unlikely to repeat in a single session
- QuickBooks data may change between checks
- Memory overhead would be significant for long-running processes

## Testing

### Unit Tests

Run the duplicate detection tests:
```powershell
npm test -- qboDuplicateCheck.test.ts
```

### Integration Tests

Test with actual QuickBooks sandbox:
```powershell
# Set sandbox credentials
$env:QB_REALM_ID = "your-sandbox-realm-id"
$env:QB_ACCESS_TOKEN = "your-access-token"

# Run integration tests
npm test -- integrationFlow.test.ts
```

### Manual Testing

1. Create a test transaction in QuickBooks
2. Note the DocNumber
3. Attempt to post the same transaction again
4. Verify the system returns the existing ID

## Troubleshooting

### Issue: Duplicates Still Being Created

**Possible Causes:**
1. DocNumber generation is inconsistent
2. Query is failing silently
3. QuickBooks sandbox vs production mismatch

**Solution:**
```powershell
# Enable debug logging
$env:LOG_LEVEL = "debug"

# Check logs for duplicate check execution
# Look for: "[QBO] Checking for duplicate"
```

### Issue: Legitimate Transactions Rejected

**Possible Causes:**
1. DocNumber collision (extremely rare)
2. Cached QuickBooks data

**Solution:**
- Review DocNumber generation logic
- Verify Stripe charge IDs are unique
- Check QuickBooks audit log

### Issue: Performance Degradation

**Possible Causes:**
1. QuickBooks API rate limiting
2. Large result sets (shouldn't happen with DocNumber queries)

**Solution:**
```typescript
// Monitor query performance
const start = Date.now();
const result = await checkForDuplicate(entity, docNumber, options);
const duration = Date.now() - start;
console.log(`Duplicate check took ${duration}ms`);
```

## Migration Notes

### Existing Deployments

The duplicate detection feature is **backward compatible**:
- No database migrations required
- No configuration changes needed
- Existing DocNumbers will work with the new system

### Rollback

If you need to disable duplicate detection temporarily:

```typescript
// In qboSvc.ts, comment out the duplicate check:
/*
if (docNumber) {
  const existingId = await checkForDuplicate(entity, docNumber, options);
  if (existingId) {
    return { id: existingId, type: entity, raw: { duplicate: true, existingId } };
  }
}
*/
```

**Note**: This is not recommended as it may lead to duplicate entries in QuickBooks.

## Best Practices

1. **Always Include Stripe Charge IDs**: Use charge IDs in DocNumbers when available for better uniqueness
2. **Monitor Logs**: Review duplicate detection logs regularly to identify patterns
3. **Test in Sandbox**: Always test new posting logic in QuickBooks sandbox first
4. **Handle Existing IDs**: When a duplicate is detected, verify it's acceptable to use the existing transaction

## API Reference

### checkForDuplicate()

Internal function that queries QuickBooks for existing documents.

```typescript
const checkForDuplicate = async (
  entity: QuickBooksDocType,
  docNumber: string,
  options?: PostOptions
): Promise<string | null>
```

**Parameters:**
- `entity`: 'sales-receipt' | 'journal-entry' | 'bank-deposit'
- `docNumber`: The document number to search for
- `options`: Optional request options (OAuth tokens, etc.)

**Returns:**
- Existing document ID if found
- `null` if no duplicate exists or query fails

### PostResult with Duplicate Flag

When a duplicate is detected, the result includes a duplicate flag:

```typescript
interface PostResult {
  id: string;                    // QBO document ID
  type: QuickBooksDocType;       // Document type
  raw: {
    duplicate?: boolean;         // True if this is a duplicate
    existingId?: string;         // ID of the existing document
    recoveredFromError?: boolean; // True if found after QBO rejection
  };
}
```

## Related Documentation

- [QBO Integration Guide](./DEPLOYMENT_SUMMARY.md)
- [Environment Variables](./ENVIRONMENT_VARIABLES.md)
- [Troubleshooting](./TROUBLESHOOTING_500_ERROR.md)
