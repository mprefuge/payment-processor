# QuickBooks Journal Entry Upsert Error Fix

## Issue Summary

When processing a Stripe `payout.paid` webhook, the QuickBooks Online integration failed with the error:

```
[QBO] Error upserting journal entry: TypeError: this.qbo.query is not a function
```

This prevented journal entries from being created in QuickBooks Online, even though the webhook completed successfully.

## Root Cause

The code was calling `this.qbo.query()` with raw SQL query strings, but **the `node-quickbooks` library does not provide a `.query()` method**. 

The library only exposes entity-specific query methods like:
- `findAccounts(criteria, callback)`
- `findJournalEntries(criteria, callback)`
- `findTransfers(criteria, callback)`
- `findDeposits(criteria, callback)`

These methods accept criteria objects or arrays, not raw SQL strings.

### Why Tests Passed But Production Failed

The unit tests passed because the mock QuickBooks client implemented a `.query()` method that accepted raw SQL strings. However, the real `node-quickbooks` library does not have this method, causing production failures.

## Solution

Replaced all calls to `this.qbo.query(sqlString, callback)` with the appropriate entity-specific `find*` methods using criteria objects.

### Changes Made

#### 1. `ensureChartOfAccounts` Method
**Before:**
```javascript
const query = `SELECT * FROM Account WHERE Name = '${account.name.replace(/'/g, "\\'")}'`;
const existingAccounts = await this._executeWithTokenRefresh(() => 
    new Promise((resolve, reject) => {
        this.qbo.query(query, (err, data) => {
            if (err) reject(err);
            else resolve(data.QueryResponse.Account || []);
        });
    })
);
```

**After:**
```javascript
const existingAccounts = await this._executeWithTokenRefresh(() => 
    new Promise((resolve, reject) => {
        this.qbo.findAccounts({ Name: account.name }, (err, data) => {
            if (err) reject(err);
            else resolve(data.QueryResponse.Account || []);
        });
    })
);
```

#### 2. `upsertJournalEntry` Method
**Before:**
```javascript
const query = `SELECT * FROM JournalEntry WHERE DocNumber = '${journalEntry.docNumber.replace(/'/g, "\\'")}'`;
const existingEntries = await this._executeWithTokenRefresh(() =>
    new Promise((resolve, reject) => {
        this.qbo.query(query, (err, data) => {
            if (err) reject(err);
            else resolve(data.QueryResponse.JournalEntry || []);
        });
    })
);
```

**After:**
```javascript
const existingEntries = await this._executeWithTokenRefresh(() =>
    new Promise((resolve, reject) => {
        this.qbo.findJournalEntries({ DocNumber: journalEntry.docNumber }, (err, data) => {
            if (err) reject(err);
            else resolve(data.QueryResponse.JournalEntry || []);
        });
    })
);
```

#### 3. `upsertTransfer` Method
**Before:**
```javascript
const query = `SELECT * FROM Transfer WHERE PrivateNote LIKE '%${transfer.docNumber.replace(/'/g, "\\'")}%'`;
const existingTransfers = await this._executeWithTokenRefresh(() =>
    new Promise((resolve, reject) => {
        this.qbo.query(query, (err, data) => {
            if (err) reject(err);
            else resolve(data.QueryResponse.Transfer || []);
        });
    })
);
```

**After:**
```javascript
const existingTransfers = await this._executeWithTokenRefresh(() =>
    new Promise((resolve, reject) => {
        this.qbo.findTransfers([
            { field: 'PrivateNote', value: `%${transfer.docNumber}%`, operator: 'LIKE' }
        ], (err, data) => {
            if (err) reject(err);
            else resolve(data.QueryResponse.Transfer || []);
        });
    })
);
```

#### 4. `upsertDeposit` Method
**Before:**
```javascript
const query = `SELECT * FROM Deposit WHERE PrivateNote LIKE '%${deposit.docNumber.replace(/'/g, "\\'")}%'`;
const existingDeposits = await this._executeWithTokenRefresh(() =>
    new Promise((resolve, reject) => {
        this.qbo.query(query, (err, data) => {
            if (err) reject(err);
            else resolve(data.QueryResponse.Deposit || []);
        });
    })
);
```

**After:**
```javascript
const existingDeposits = await this._executeWithTokenRefresh(() =>
    new Promise((resolve, reject) => {
        this.qbo.findDeposits([
            { field: 'PrivateNote', value: `%${deposit.docNumber}%`, operator: 'LIKE' }
        ], (err, data) => {
            if (err) reject(err);
            else resolve(data.QueryResponse.Deposit || []);
        });
    })
);
```

#### 5. `findAccounts` Method
**Before:**
```javascript
const conditions = [];
if (criteria.name) {
    conditions.push(`Name = '${criteria.name.replace(/'/g, "\\'")}'`);
}
if (criteria.type) {
    conditions.push(`AccountType = '${criteria.type}'`);
}
if (criteria.subType) {
    conditions.push(`AccountSubType = '${criteria.subType}'`);
}

const whereClause = conditions.length > 0 ? ` WHERE ${conditions.join(' AND ')}` : '';
const query = `SELECT * FROM Account${whereClause}`;

const accounts = await this._executeWithTokenRefresh(() =>
    new Promise((resolve, reject) => {
        this.qbo.query(query, (err, data) => {
            if (err) reject(err);
            else resolve(data.QueryResponse.Account || []);
        });
    })
);
```

**After:**
```javascript
const queryCriteria = [];

if (criteria.name) {
    queryCriteria.push({ field: 'Name', value: criteria.name });
}
if (criteria.type) {
    queryCriteria.push({ field: 'AccountType', value: criteria.type });
}
if (criteria.subType) {
    queryCriteria.push({ field: 'AccountSubType', value: criteria.subType });
}

const findCriteria = queryCriteria.length > 0 ? queryCriteria : {};

const accounts = await this._executeWithTokenRefresh(() =>
    new Promise((resolve, reject) => {
        this.qbo.findAccounts(findCriteria, (err, data) => {
            if (err) reject(err);
            else resolve(data.QueryResponse.Account || []);
        });
    })
);
```

### Test Updates

Updated the mock QuickBooks client to implement the `find*` methods instead of relying solely on the `.query()` method:

```javascript
// Added to MockQBOClient class
findAccounts(criteria, callback) { /* ... */ }
findJournalEntries(criteria, callback) { /* ... */ }
findTransfers(criteria, callback) { /* ... */ }
findDeposits(criteria, callback) { /* ... */ }
```

## Criteria Formats

The `node-quickbooks` library supports two formats for query criteria:

### 1. Object Criteria (for simple equality checks)
```javascript
qbo.findAccounts({ Name: 'Revenue' }, callback);
qbo.findJournalEntries({ DocNumber: 'JE-001' }, callback);
```

### 2. Array Criteria (for complex queries with operators)
```javascript
qbo.findTransfers([
    { field: 'PrivateNote', value: '%XFER-001%', operator: 'LIKE' }
], callback);

qbo.findAccounts([
    { field: 'AccountType', value: 'Bank' },
    { field: 'Active', value: 'true' }
], callback);
```

Supported operators: `=`, `IN`, `<`, `>`, `<=`, `>=`, `LIKE`

## Verification

All tests now pass:
- ✅ 15/15 QuickBooks Provider tests
- ✅ All other integration tests

Verified with actual `node-quickbooks` library:
- ✅ No `.query()` method exists (as expected)
- ✅ All `find*` methods are available
- ✅ Methods accept criteria objects/arrays (not raw SQL)

## Impact

This fix ensures:
1. **Payout webhooks successfully create journal entries** in QuickBooks Online
2. **Idempotency works correctly** - duplicate journal entries are prevented by finding existing entries
3. **No more "this.qbo.query is not a function" errors**
4. **Consistent behavior** between tests and production

## References

- QuickBooks API Documentation: https://developer.intuit.com/app/developer/qbo/docs/api/accounting/most-commonly-used/journalentry
- node-quickbooks GitHub: https://github.com/mcohen01/node-quickbooks
- QuickBooks OAuth 2.0 Guide: https://developer.intuit.com/app/developer/qbo/docs/develop/authentication-and-authorization/oauth-2.0
