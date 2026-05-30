# Bank Deposit with SalesReceiptIds Feature

## Overview

The Manual QBO Sync handler now supports creating bank deposits by specifying an array of sales receipt IDs. This feature simplifies the process of moving transactions from the "Undeposited Funds" account to a bank account (e.g., "Operating Bank") by automatically retrieving the sales receipt details from QuickBooks and constructing the appropriate deposit lines.

## How It Works

### Traditional Bank Deposit
Previously, you had to manually construct the deposit lines:

```json
{
  "type": "bank-deposit",
  "data": {
    "DepositToAccountRef": { "name": "Operating Bank" },
    "TxnDate": "2025-10-30",
    "Line": [
      {
        "Amount": 150.00,
        "DetailType": "DepositLineDetail",
        "DepositLineDetail": {
          "AccountRef": { "name": "Undeposited Funds" }
        }
      }
    ]
  }
}
```

### New SalesReceiptIds Approach
Now you can simply provide the IDs of the sales receipts:

```json
{
  "type": "bank-deposit",
  "data": {
    "DepositToAccountRef": { "name": "Operating Bank" },
    "TxnDate": "2025-10-30",
    "SalesReceiptIds": [
      "1820",
      "1819",
      "1818"
    ]
  }
}
```

## Process Flow

1. **Request Received**: The handler receives a bank-deposit request with a `SalesReceiptIds` array
2. **Sales Receipt Retrieval**: For each ID:
   - Queries QuickBooks to retrieve the full sales receipt details by ID
   - Validates that the sales receipt exists
   - Extracts the amount, customer reference, and deposit account
3. **Deposit Line Construction**: Creates deposit lines that:
   - Reference the original sales receipt transaction via `LinkedTxn`
   - Include the correct amount from the sales receipt
   - Link to the Undeposited Funds account (the source)
   - Include a description with customer name and DocNumber
4. **Account Resolution**: Resolves the `DepositToAccountRef` (e.g., "Operating Bank")
5. **Deposit Creation**: Posts the bank deposit to QuickBooks
6. **Result**: The transactions are moved from Undeposited Funds to the specified bank account

## Schema

### Request Schema
```typescript
{
  "type": "bank-deposit",
  "data": {
    "DepositToAccountRef": { "name": string },  // Required: Target bank account
    "TxnDate": string,                          // Required: Transaction date (YYYY-MM-DD)
    "SalesReceiptIds": string[],                // Required: Array of sales receipt IDs
    "PrivateNote"?: string                      // Optional: Private note for the deposit
  }
}
```

### Example Sales Receipt
```json
{
  "type": "sales-receipt",
  "data": {
    "TxnDate": "2025-10-29",
    "PrivateNote": "Manual sync of customer payment",
    "DepositToAccountRef": {
      "name": "Undeposited Funds"
    },
    "CustomerRef": {
      "name": "John Doe"
    },
    "BillEmail": {
      "Address": "john.doe@example.com"
    },
    "Line": [
      {
        "Amount": 150.00,
        "DetailType": "SalesItemLineDetail",
        "Description": "Consulting Services",
        "SalesItemLineDetail": {
          "ItemRef": {
            "name": "Consulting"
          }
        }
      }
    ]
  }
}
```

## Generated Deposit Lines

For each sales receipt ID, the system generates a deposit line with:

```typescript
{
  "Amount": 150.00,                              // From SalesReceipt.TotalAmt
  "DetailType": "DepositLineDetail",
  "DepositLineDetail": {
    "AccountRef": {                              // Always "Undeposited Funds"
      "name": "Undeposited Funds",
      "value": "35"
    }
  },
  "LinkedTxn": [
    {
      "TxnId": "1820",                           // SalesReceipt.Id
      "TxnType": "SalesReceipt"
    }
  ],
  "Description": "John Doe - MAN-20251029-15000" // CustomerRef.name - DocNumber
}
```

## Validation

The handler validates:
- ✅ SalesReceiptIds array is not empty
- ✅ Each sales receipt exists in QuickBooks
- ✅ DepositToAccountRef is provided and can be resolved
- ⚠️ Warns if sales receipts are not in "Undeposited Funds" account

## Error Handling

Common errors:
- **"Sales receipt with ID {id} not found in QuickBooks"**: The specified ID doesn't exist
- **"SalesReceiptIds array cannot be empty for bank deposits"**: Must provide at least one ID
- **"DepositToAccountRef is required and must be resolved to a valid account ID"**: Invalid or missing target account

## Benefits

1. **Simplified API**: No need to manually construct deposit lines
2. **Direct ID Lookup**: More efficient than DocNumber lookups
3. **Automatic Linking**: Proper transaction linking via `LinkedTxn`
4. **Accurate Amounts**: Amounts automatically pulled from source transactions
5. **Audit Trail**: Description includes customer name and DocNumber for easy tracking
6. **Validation**: Ensures sales receipts exist before attempting deposit

## Usage Example

### Step 1: Create Sales Receipts
```bash
# Create sales receipt 1
POST /api/manualQboSync
{
  "type": "sales-receipt",
  "data": {
    "TxnDate": "2025-10-29",
    "DepositToAccountRef": { "name": "Undeposited Funds" },
    "CustomerRef": { "name": "John Doe" },
    "Line": [{ "Amount": 150.00, ... }]
  }
}
# Response: { "id": "1820", ... }

# Create sales receipt 2
POST /api/manualQboSync
{
  "type": "sales-receipt",
  "data": {
    "TxnDate": "2025-10-28",
    "DepositToAccountRef": { "name": "Undeposited Funds" },
    "CustomerRef": { "name": "Jane Smith" },
    "Line": [{ "Amount": 1.50, ... }]
  }
}
# Response: { "id": "1819", ... }
```

### Step 2: Create Bank Deposit
```bash
POST /api/manualQboSync
{
  "type": "bank-deposit",
  "data": {
    "DepositToAccountRef": { "name": "Operating Bank" },
    "TxnDate": "2025-10-30",
    "SalesReceiptIds": [
      "1820",
      "1819"
    ]
  }
}
```

### Result
The two sales receipts are now moved from "Undeposited Funds" to "Operating Bank" with a total deposit of $151.50.

## Implementation Details

### Key Functions

- **`getSalesReceiptById(salesReceiptId: string)`**: Queries QBO for a sales receipt by ID
- **`buildBankDepositFromSalesReceipts(salesReceiptIds: string[], context)`**: Constructs deposit lines from sales receipts
- **`validateAndPost(type, data, context)`**: Handles SalesReceiptIds if provided, then validates and posts

### Transaction Linking

The `LinkedTxn` property is crucial for QuickBooks to properly track the movement of funds from Undeposited Funds to the bank account. This creates a proper audit trail in QuickBooks.

## Notes

- Sales receipt IDs are numeric values returned by QuickBooks (e.g., "1820", "1819")
- The system logs warnings if sales receipts aren't in Undeposited Funds, but continues processing
- All account references are automatically resolved (no need to provide account IDs)
- The description on each deposit line includes the customer name and DocNumber for reference
