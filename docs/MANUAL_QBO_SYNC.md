# Manual QuickBooks Sync Endpoint

## Overview

The manual QuickBooks sync endpoint allows you to manually sync individual records to QuickBooks Online. This endpoint supports multiple QuickBooks document types through a centralized schema, providing a single endpoint for all manual sync operations.

**Automatic Reference Resolution** 🎉
This endpoint now automatically resolves all reference types (Items, Customers, Accounts) by name. You can simply provide names instead of QuickBooks IDs, and the system will:
- Search for existing records by name
- Create new records automatically if they don't exist
- Resolve to the appropriate QuickBooks ID before posting

## How Automatic Resolution Works

### What Gets Resolved Automatically

All of the following reference types are resolved automatically:

1. **ItemRef** - Product/Service items
   - Searches for existing items by name
   - Creates as "Service" type if not found
   - Uses configured income account

2. **CustomerRef** - Customer records
   - Searches by display name and email (if provided)
   - **Email lookup**: Include `BillEmail.Address` in your data to search by email first
   - Creates new customer if not found
   - Updates existing customer details if needed

3. **AccountRef** - Chart of Accounts entries
   - Searches for existing accounts by name  
   - Creates new account if not found (with appropriate type)
   - Infers account type from context (Bank, Income, Expense, etc.)

### Reference Format

You can use either format for any reference:

**Option 1: Name only (recommended for manual sync)**
```json
{
  "DepositToAccountRef": { "name": "Checking Account" },
  "CustomerRef": { "name": "John Doe" },
  "ItemRef": { "name": "Consulting Services" }
}
```

**Option 2: ID with optional name**
```json
{
  "DepositToAccountRef": { "value": "123", "name": "Checking Account" },
  "CustomerRef": { "value": "456", "name": "John Doe" },
  "ItemRef": { "value": "789", "name": "Consulting Services" }
}
```

If you provide only a `name`, the system will automatically find or create the record and populate the `value` field before posting to QuickBooks.

## Important: Reference Resolution

You no longer need to find QuickBooks IDs manually! The endpoint automatically resolves references by name.

### What You Can Do
- **Provide names only**: Just use `{ "name": "Account Name" }` for any reference
- **System handles the rest**: Automatically finds existing records or creates new ones
- **IDs resolved automatically**: All references are converted to proper QuickBooks IDs before posting

### What Gets Created Automatically
- **Items**: Created as "Service" type items with your default income account
- **Customers**: Created with the provided name and optional email/address
- **Accounts**: Created with appropriate type based on context (Bank, Income, Expense, etc.)

### Example
Instead of finding IDs like this (old way):
```json
{
  "DepositToAccountRef": { "value": "123" },
  "CustomerRef": { "value": "456" }
}
```

You can now simply use names (new way):
```json
{
  "DepositToAccountRef": { "name": "Checking Account" },
  "CustomerRef": { "name": "John Doe" }
}
```

The system will automatically find or create these records and use their QuickBooks IDs.

## Endpoint

```
POST /qbo/manual-sync
```

## Authentication

This endpoint requires function-level authentication. Include the appropriate authentication headers as configured for your Azure Function App.

## Request Format

### Headers
```
Content-Type: application/json
```

### Body Schema
```json
{
  "type": "sales-receipt" | "journal-entry" | "bank-deposit",
  "data": {
    // Document-specific data (see examples below)
  }
}
```

## Supported Document Types

### 1. Sales Receipt (`sales-receipt`)

Used for recording sales transactions, typically for charges, payments, or revenue entries.

**Required Fields:**
- `DepositToAccountRef`: Account to deposit to (reference object)
- `Line`: Array of line items (at least one)

**Optional Fields:**
- `DocNumber`: Unique document number (auto-generated if not provided)
- `TxnDate`: Transaction date in YYYY-MM-DD format (defaults to today)
- `PrivateNote`: Internal note (not visible to customer)
- `CustomerMemo`: Message visible to customer (`{ value: "message" }`)
- `CustomerRef`: Customer reference
- `BillEmail`: Customer email (`{ Address: "email@example.com" }`)
- `BillAddr`: Billing address object
- `ShipAddr`: Shipping address object
- `ShipDate`: Shipping date (YYYY-MM-DD)
- `ShipMethodRef`: Shipping method reference
- `ClassRef`: QuickBooks class reference (for tracking)
- `SalesTermRef`: Sales terms reference
- `DepartmentRef`: Department reference
- `PaymentMethodRef`: Payment method reference (Cash, Credit Card, etc.)
- `PaymentRefNum`: Payment reference number
- `CurrencyRef`: Currency reference (for multi-currency)
- `ExchangeRate`: Exchange rate for foreign currencies
- `GlobalTaxCalculation`: Tax calculation method (`TaxExcluded`, `TaxInclusive`, `NotApplicable`)
- `TxnTaxDetail`: Transaction tax details object
- `CustomField`: Array of custom field values

**Line Item Fields:**
Each line item in the `Line` array supports:
- `Amount`: Line amount (required)
- `DetailType`: Must be `"SalesItemLineDetail"`
- `Description`: Line description
- `SalesItemLineDetail`: Object containing:
  - `ItemRef`: Item/service reference (required)
  - `ItemAccountRef`: Override income account for this line
  - `TaxCodeRef`: Tax code reference
  - `Qty`: Quantity
  - `UnitPrice`: Unit price
  - `ServiceDate`: Service date
  - `ClassRef`: Class for this line
  - `TaxInclusiveAmt`: Tax-inclusive amount
  - `DiscountRate`: Discount percentage
  - `DiscountAmt`: Discount amount

**Address Object Fields:**
Both `BillAddr` and `ShipAddr` support:
- `Line1`: Address line 1
- `Line2`: Address line 2
- `Line3`: Address line 3
- `Line4`: Address line 4
- `City`: City
- `CountrySubDivisionCode`: State/Province code
- `PostalCode`: ZIP/Postal code
- `Country`: Country

**Example Request:**
```json
{
  "type": "sales-receipt",
  "data": {
    "DocNumber": "SR-2024-001",
    "TxnDate": "2024-01-15",
    "PrivateNote": "Manual sync of customer payment",
    "CustomerMemo": {
      "value": "Thank you for your business!"
    },
    "DepositToAccountRef": {
      "name": "Checking Account"
    },
    "CustomerRef": {
      "name": "John Doe"
    },
    "BillEmail": {
      "Address": "john.doe@example.com"
    },
    "BillAddr": {
      "Line1": "123 Main St",
      "City": "Seattle",
      "CountrySubDivisionCode": "WA",
      "PostalCode": "98101",
      "Country": "USA"
    },
    "PaymentMethodRef": {
      "name": "Credit Card"
    },
    "PaymentRefNum": "ch_1234567890",
    "Line": [
      {
        "Amount": 150.00,
        "DetailType": "SalesItemLineDetail",
        "Description": "Monthly consulting services",
        "SalesItemLineDetail": {
          "ItemRef": {
            "name": "Consulting"
          },
          "Qty": 3,
          "UnitPrice": 50.00,
          "ServiceDate": "2024-01-15"
        }
      }
    ]
  }
}
```

> **✨ Key Features:**
> - **All references use names only** - No need to find QuickBooks IDs!
> - **Automatic resolution** - Items, Customers, and Accounts are found or created automatically
> - **Flexible addressing** - Include as much or as little address info as needed
> - **Customer communication** - Use `CustomerMemo` for messages visible on receipts

### 2. Journal Entry (`journal-entry`)

Used for recording accounting journal entries, such as fee adjustments, transfers, or corrections.

**Required Fields:**
- `Line`: Array of journal lines (must balance to zero - total debits = total credits)

**Optional Fields:**
- `DocNumber`: Unique document number (auto-generated if not provided)
- `TxnDate`: Transaction date in YYYY-MM-DD format (defaults to today)
- `PrivateNote`: Internal note
- `Adjustment`: Boolean flag for adjustment entries
- `CurrencyRef`: Currency reference (for multi-currency)
- `ExchangeRate`: Exchange rate for foreign currencies
- `TxnTaxDetail`: Transaction tax details object

**Line Item Fields:**
Each line item in the `Line` array supports:
- `Amount`: Line amount (required, must be positive)
- `DetailType`: Must be `"JournalEntryLineDetail"`
- `Description`: Line description
- `JournalEntryLineDetail`: Object containing:
  - `PostingType`: `"Debit"` or `"Credit"` (required)
  - `AccountRef`: Account reference (required)
  - `Entity`: Entity reference object (optional):
    - `EntityRef`: Reference to customer, vendor, employee
    - `Type`: `"Customer"`, `"Vendor"`, `"Employee"`, or `"Other"`
  - `ClassRef`: Class reference
  - `DepartmentRef`: Department reference
  - `TaxCodeRef`: Tax code reference
  - `TaxApplicableOn`: `"Sales"` or `"Purchase"`
  - `TaxAmount`: Tax amount
  - `BillableStatus`: `"Billable"`, `"NotBillable"`, or `"HasBeenBilled"`

**Example Request:**
```json
{
  "type": "journal-entry",
  "data": {
    "DocNumber": "JE-2024-001",
    "TxnDate": "2024-01-15",
    "PrivateNote": "Fee adjustment for transaction",
    "Adjustment": false,
    "Line": [
      {
        "Amount": 5.00,
        "DetailType": "JournalEntryLineDetail",
        "Description": "Stripe processing fee",
        "JournalEntryLineDetail": {
          "PostingType": "Debit",
          "AccountRef": {
            "name": "Bank Fees"
          },
          "ClassRef": {
            "name": "Operating Expenses"
          }
        }
      },
      {
        "Amount": 5.00,
        "DetailType": "JournalEntryLineDetail",
        "Description": "Stripe processing fee",
        "JournalEntryLineDetail": {
          "PostingType": "Credit",
          "AccountRef": {
            "name": "Checking Account"
          },
          "Entity": {
            "EntityRef": {
              "name": "Stripe, Inc."
            },
            "Type": "Vendor"
          }
        }
      }
    ]
  }
}
```

> **⚠️ Important:** 
> - Journal entries must balance (total debits = total credits)
> - All `Amount` values must be positive (use `PostingType` to indicate debit/credit)
> - Account references are resolved automatically by name

### 3. Bank Deposit (`bank-deposit`)

Used for recording bank deposits, typically for payout reconciliations or bulk deposits.

**Required Fields:**
- `DepositToAccountRef`: Account to deposit to (reference object)
- `Line`: Array of deposit lines (or use `SalesReceiptIds` for simplified creation)

**Optional Fields:**
- `DocNumber`: Unique document number (auto-generated if not provided)
- `TxnDate`: Transaction date in YYYY-MM-DD format (defaults to today)
- `PrivateNote`: Internal note
- `CashBack`: Cash back object:
  - `AccountRef`: Account reference for cash back
  - `Amount`: Cash back amount
  - `Memo`: Cash back memo
- `CurrencyRef`: Currency reference (for multi-currency)
- `ExchangeRate`: Exchange rate for foreign currencies
- `DepartmentRef`: Department reference
- `TxnTaxDetail`: Transaction tax details object
- `SalesReceiptIds`: Array of sales receipt IDs (simplified mode - see below)

**Line Item Fields:**
Each line item in the `Line` array supports:
- `Amount`: Line amount (required)
- `DetailType`: Must be `"DepositLineDetail"`
- `Description`: Line description
- `DepositLineDetail`: Object containing:
  - `AccountRef`: Source account reference (e.g., "Undeposited Funds")
  - `Entity`: Entity reference object (optional):
    - `EntityRef`: Reference to customer, vendor, employee
    - `Type`: `"Customer"`, `"Vendor"`, `"Employee"`, or `"Other"`
  - `ClassRef`: Class reference
  - `CheckNum`: Check number (required when PaymentMethodRef.name is "Check")
  - `PaymentMethodRef`: Payment method reference
  - `TaxCodeRef`: Tax code reference
  - `TaxApplicableOn`: `"Sales"` or `"Purchase"`
  - `LinkedTxn`: Array of linked transactions (for linking to sales receipts):
    - `TxnId`: Transaction ID
    - `TxnType`: Transaction type (e.g., `"SalesReceipt"`)
    - `TxnLineId`: Transaction line ID (optional)

**Example Request (Manual Lines):**
```json
{
  "type": "bank-deposit",
  "data": {
    "DocNumber": "BD-2024-001",
    "TxnDate": "2024-01-15",
    "PrivateNote": "Stripe payout deposit",
    "DepositToAccountRef": {
      "name": "Checking Account"
    },
    "Line": [
      {
        "Amount": 1000.00,
        "DetailType": "DepositLineDetail",
        "Description": "Stripe payout #po_123456",
        "DepositLineDetail": {
          "AccountRef": {
            "name": "Undeposited Funds"
          },
          "PaymentMethodRef": {
            "name": "Credit Card"
          }
        }
      }
    ]
  }
}
```

**Example Request (Simplified with SalesReceiptIds):**
```json
{
  "type": "bank-deposit",
  "data": {
    "TxnDate": "2024-01-15",
    "DepositToAccountRef": {
      "name": "Operating Bank"
    },
    "SalesReceiptIds": ["123", "456", "789"]
  }
}
```

> **✨ Simplified Mode:** 
> - Use `SalesReceiptIds` to automatically create a deposit from existing sales receipts
> - The system will fetch each sales receipt and create deposit lines automatically
> - DocNumber is auto-generated
> - All account references are resolved automatically by name

> **📝 Manual Mode:**
> - Use `Line` array to specify deposit lines manually
> - Link to existing transactions using `LinkedTxn` in each line
> - Full control over deposit structure and amounts

## Automatic Reference Resolution

The endpoint automatically handles all reference types (Items, Customers, Accounts) through an intelligent resolution process:

### Resolution Process
1. **Name-Based References**: When you provide only a `name` field, the system:
   - Searches for existing records by name in QuickBooks
   - Uses the existing record's ID if found
   - Creates a new record if not found
   - Updates the reference with the resolved QuickBooks ID

2. **ID-Based References**: When you provide a `value` field:
   - The system uses the provided ID directly
   - No lookup or creation is performed

### Account Creation Details
When accounts are created automatically, the system infers the account type from context:
- **DepositToAccountRef**: Created as "Bank" type accounts
- **ItemAccountRef**: Created as "Income" type accounts  
- **JournalEntry AccountRef**: Created as "Other Current Asset" type (can be customized)

### Customer Creation Details
When customers are created automatically:
- **Display Name**: Uses the provided name
- **Email Lookup**: If `BillEmail.Address` is included in the document, the system searches for existing customers by email first, then falls back to name matching
- **Email**: Stores BillEmail.Address if provided in the document  
- **Contact Info**: Can include billing address, shipping address, and phone if provided

**Example with Email Lookup:**
```json
{
  "CustomerRef": { "name": "John Doe" },
  "BillEmail": { "Address": "john.doe@example.com" }
}
```
The system will search for a customer with email `john.doe@example.com` first. If found, it uses that customer's ID. If not found, it searches by name "John Doe". If still not found, it creates a new customer with both the name and email.

### Item Creation Details
When items are created automatically:
- **Type**: Created as "Service" items
- **Name**: Uses the name specified in the ItemRef
- **Income Account**: Uses your default income account from QuickBooks settings

### Logging
All reference resolutions are logged for transparency:
```
Resolved CustomerRef for "John Doe" to ID: 123
Resolved AccountRef for "Checking Account" to ID: 456
Resolved ItemRef for "Consulting Services" to ID: 789
```

## Response Format

### Success Response (200)
```json
{
  "success": true,
  "id": "123",
  "type": "sales-receipt"
}
```

### Error Response (400/500)
```json
{
  "success": false,
  "error": "Error message describing what went wrong"
}
```

For validation errors (400), additional `details` field may be included with specific validation issues.

## Error Handling

- **400 Bad Request**: Invalid request body or missing required fields
- **500 Internal Server Error**: QuickBooks API errors or unexpected server issues

## QuickBooks Reference IDs

When specifying references (AccountRef, CustomerRef, ItemRef, etc.), you can use either:

1. **Name-based references** (recommended): `{ "name": "Account Name" }`
   - System automatically finds or creates the record
   - No need to look up QuickBooks IDs manually
   
2. **ID-based references**: `{ "value": "123", "name": "Account Name" }`
   - Uses the specific QuickBooks ID provided
   - Bypasses automatic lookup/creation

For manual ID lookup (if needed), these can be found in QuickBooks Online:
- **Accounts**: Gear icon → Account and Settings → Expenses/Advanced → Automation → Enable account numbers
- **Customers**: Gear icon → All Lists → Customers
- **Items**: Gear icon → All Lists → Items

## Complete Field Reference

### Sales Receipt Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `DocNumber` | string | No | Unique document number (auto-generated if omitted) |
| `TxnDate` | string | No | Transaction date (YYYY-MM-DD, defaults to today) |
| `PrivateNote` | string | No | Internal note, not visible to customer |
| `CustomerMemo` | object | No | Message visible to customer: `{ value: "text" }` |
| `DepositToAccountRef` | reference | Yes | Account to deposit funds to |
| `CustomerRef` | reference | No | Customer reference |
| `BillEmail` | object | No | Customer email: `{ Address: "email" }` |
| `BillAddr` | address | No | Billing address object |
| `ShipAddr` | address | No | Shipping address object |
| `ShipDate` | string | No | Shipping date (YYYY-MM-DD) |
| `ShipMethodRef` | reference | No | Shipping method |
| `ClassRef` | reference | No | QuickBooks class for tracking |
| `SalesTermRef` | reference | No | Sales terms (e.g., "Net 30") |
| `DepartmentRef` | reference | No | Department |
| `PaymentMethodRef` | reference | No | Payment method (Cash, Credit Card, etc.) |
| `PaymentRefNum` | string | No | Payment reference number |
| `CurrencyRef` | reference | No | Currency (for multi-currency) |
| `ExchangeRate` | number | No | Exchange rate for foreign currencies |
| `GlobalTaxCalculation` | enum | No | `TaxExcluded`, `TaxInclusive`, or `NotApplicable` |
| `TxnTaxDetail` | object | No | Transaction tax details |
| `CustomField` | array | No | Custom field values |
| `Line` | array | Yes | Array of line items (min 1) |

### Sales Receipt Line Item Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `Amount` | number | Yes | Line item amount |
| `DetailType` | string | Yes | Must be `"SalesItemLineDetail"` |
| `Description` | string | No | Line item description |
| `SalesItemLineDetail` | object | Yes | Line detail object (see below) |

### Sales Receipt Line Detail Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `ItemRef` | reference | Yes | Item/service reference |
| `ItemAccountRef` | reference | No | Override income account for this line |
| `TaxCodeRef` | reference | No | Tax code |
| `Qty` | number | No | Quantity |
| `UnitPrice` | number | No | Unit price |
| `ServiceDate` | string | No | Service date (YYYY-MM-DD) |
| `ClassRef` | reference | No | Class for this line |
| `TaxInclusiveAmt` | number | No | Tax-inclusive amount |
| `DiscountRate` | number | No | Discount percentage |
| `DiscountAmt` | number | No | Discount amount |

### Journal Entry Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `DocNumber` | string | No | Unique document number (auto-generated if omitted) |
| `TxnDate` | string | No | Transaction date (YYYY-MM-DD, defaults to today) |
| `PrivateNote` | string | No | Internal note |
| `Adjustment` | boolean | No | Flag for adjustment entries |
| `CurrencyRef` | reference | No | Currency (for multi-currency) |
| `ExchangeRate` | number | No | Exchange rate for foreign currencies |
| `TxnTaxDetail` | object | No | Transaction tax details |
| `Line` | array | Yes | Array of journal lines (must balance) |

### Journal Entry Line Item Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `Amount` | number | Yes | Line amount (always positive) |
| `DetailType` | string | Yes | Must be `"JournalEntryLineDetail"` |
| `Description` | string | No | Line description |
| `JournalEntryLineDetail` | object | Yes | Line detail object (see below) |

### Journal Entry Line Detail Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `PostingType` | enum | Yes | `"Debit"` or `"Credit"` |
| `AccountRef` | reference | Yes | Account reference |
| `Entity` | object | No | Entity reference: `{ EntityRef, Type }` |
| `ClassRef` | reference | No | Class reference |
| `DepartmentRef` | reference | No | Department reference |
| `TaxCodeRef` | reference | No | Tax code reference |
| `TaxApplicableOn` | enum | No | `"Sales"` or `"Purchase"` |
| `TaxAmount` | number | No | Tax amount |
| `BillableStatus` | enum | No | `"Billable"`, `"NotBillable"`, or `"HasBeenBilled"` |

### Bank Deposit Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `DocNumber` | string | No | Unique document number (auto-generated if omitted) |
| `TxnDate` | string | No | Transaction date (YYYY-MM-DD, defaults to today) |
| `PrivateNote` | string | No | Internal note |
| `DepositToAccountRef` | reference | Yes | Account to deposit to |
| `CashBack` | object | No | Cash back details: `{ AccountRef, Amount, Memo }` |
| `CurrencyRef` | reference | No | Currency (for multi-currency) |
| `ExchangeRate` | number | No | Exchange rate for foreign currencies |
| `DepartmentRef` | reference | No | Department reference |
| `TxnTaxDetail` | object | No | Transaction tax details |
| `Line` | array | Conditional* | Array of deposit lines |
| `SalesReceiptIds` | array | Conditional* | Array of sales receipt IDs (simplified mode) |

*Either `Line` or `SalesReceiptIds` is required, but not both.

### Bank Deposit Line Item Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `Amount` | number | Yes | Line amount |
| `DetailType` | string | Yes | Must be `"DepositLineDetail"` |
| `Description` | string | No | Line description |
| `DepositLineDetail` | object | Yes | Line detail object (see below) |

### Bank Deposit Line Detail Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `AccountRef` | reference | No | Source account (e.g., "Undeposited Funds") |
| `Entity` | object | No | Entity reference: `{ EntityRef, Type }` |
| `ClassRef` | reference | No | Class reference |
| `CheckNum` | string | No | Check number |
| `PaymentMethodRef` | reference | No | Payment method |
| `TaxCodeRef` | reference | No | Tax code reference |
| `TaxApplicableOn` | enum | No | `"Sales"` or `"Purchase"` |
| `LinkedTxn` | array | No | Linked transactions: `[{ TxnId, TxnType, TxnLineId? }]` |

### Address Object Fields

Used for `BillAddr` and `ShipAddr`:

| Field | Type | Description |
|-------|------|-------------|
| `Line1` | string | Address line 1 |
| `Line2` | string | Address line 2 |
| `Line3` | string | Address line 3 |
| `Line4` | string | Address line 4 |
| `City` | string | City |
| `CountrySubDivisionCode` | string | State/Province code (e.g., "CA", "WA") |
| `PostalCode` | string | ZIP/Postal code |
| `Country` | string | Country |

### Reference Object Fields

Used for all `*Ref` fields (AccountRef, CustomerRef, ItemRef, etc.):

| Field | Type | Description |
|-------|------|-------------|
| `name` | string | Name of the record (used for lookup/creation) |
| `value` | string | QuickBooks ID (if known) |

**Either `name` or `value` must be provided.** Using only `name` triggers automatic lookup/creation.

### Entity Object Fields

Used in journal entries and deposits to link to customers, vendors, etc.:

| Field | Type | Description |
|-------|------|-------------|
| `EntityRef` | reference | Reference to the entity |
| `Type` | enum | `"Customer"`, `"Vendor"`, `"Employee"`, or `"Other"` |

## Example Files

Comprehensive examples showing all available fields are available in the `docs/examples/` directory:

- **[manual-sync-sales-receipt-comprehensive.json](examples/manual-sync-sales-receipt-comprehensive.json)** - Full sales receipt example with customer details, multiple line items, addresses, shipping info, payment details, and class/department tracking
- **[manual-sync-journal-entry-comprehensive.json](examples/manual-sync-journal-entry-comprehensive.json)** - Journal entry with entity references, class and department tracking
- **[manual-sync-bank-deposit-comprehensive.json](examples/manual-sync-bank-deposit-comprehensive.json)** - Bank deposit with multiple lines, entity references, and payment methods
- **[manual-sync-bank-deposit-simplified.json](examples/manual-sync-bank-deposit-simplified.json)** - Simplified bank deposit using `SalesReceiptIds` array for automatic deposit creation

These examples demonstrate the full range of fields available for each document type. You can use them as templates and customize based on your needs.
- **Items**: Gear icon → All Lists → Items

## Usage Examples

### cURL Example
```bash
curl -X POST "https://your-function-app.azurewebsites.net/qbo/manual-sync" \
  -H "Content-Type: application/json" \
  -H "x-functions-key: your-function-key" \
  -d '{
    "type": "sales-receipt",
    "data": {
      "DocNumber": "SR-2024-001",
      "TxnDate": "2024-01-15",
      "DepositToAccountRef": {"value": "1"},
      "Line": [{
        "Amount": 100.00,
        "DetailType": "SalesItemLineDetail",
        "SalesItemLineDetail": {
          "ItemRef": {"name": "Consulting Services"}
        }
      }]
    }
  }'
```

### PowerShell Example
```powershell
$body = @{
  type = "sales-receipt"
  data = @{
    DocNumber = "SR-2024-001"
    TxnDate = "2024-01-15"
    DepositToAccountRef = @{ value = "1" }
    Line = @(
      @{
        Amount = 100.00
        DetailType = "SalesItemLineDetail"
        SalesItemLineDetail = @{
          ItemRef = @{ name = "Consulting Services" }
        }
      }
    )
  }
} | ConvertTo-Json -Depth 10

Invoke-RestMethod -Uri "https://your-function-app.azurewebsites.net/qbo/manual-sync" `
  -Method POST `
  -Body $body `
  -ContentType "application/json" `
  -Headers @{ "x-functions-key" = "your-function-key" }
```

## Troubleshooting

### Common Errors

#### "NumberFormatException: null" - Missing DocNumber
**Error:** `"System Failure Error: java.lang.NumberFormatException: null"`

**Cause:** The `DocNumber` field is missing from the sales receipt or other document type.

**Solution:**
- **Always include `DocNumber`** in your request - it is a required field for all QuickBooks documents
- DocNumber must be a unique string identifier for the document
- Example: `"DocNumber": "SR-2024-001"`

**Example of INCORRECT request (missing DocNumber):**
```json
{
  "type": "sales-receipt",
  "data": {
    "TxnDate": "2024-01-01",
    "DepositToAccountRef": { "name": "Checking Account" },
    "Line": [...]
  }
}
```

**Example of CORRECT request (with DocNumber):**
```json
{
  "type": "sales-receipt",
  "data": {
    "DocNumber": "SR-2024-001",
    "TxnDate": "2024-01-01",
    "DepositToAccountRef": { "value": "123" },
    "Line": [...]
  }
}
```

#### "Invalid Reference Id" (for any Reference type) - Now Automatically Resolved
**Note:** Reference errors are now handled automatically. If an Item, Customer, or Account doesn't exist, it will be created automatically. This error should rarely occur.

**If you still see this error**, it means:
- The reference has a `value` field with an invalid ID
- **Solution**: Remove the `value` field and provide only `name` - the system will resolve it automatically

**Example - Change from:**
```json
{
  "CustomerRef": { "value": "999999", "name": "John Doe" }
}
```

**To:**
```json
{
  "CustomerRef": { "name": "John Doe" }
}
```

#### "Invalid Line TaxCode in the request"
**Error:** `"Invalid Line TaxCode in the request"`

**Cause:** Invalid TaxCodeRef value provided.

**Solution:**
- For US companies, use `TAX` (taxable) or `NON` (non-taxable)
- Query your QuickBooks company for available tax codes: `SELECT Id, Name FROM TaxCode`

#### "Business Validation Error"
**Error:** Various business rule violations.

**Common Causes:**
- Journal entries don't balance (debits ≠ credits)
- Invalid account types for specific transactions
- Missing required fields

#### Authentication Errors
**Error:** `"Failed to refresh QuickBooks access token"`

**Cause:** Invalid or expired QuickBooks credentials.

**Solution:**
- Verify QBO_CLIENT_ID, QBO_CLIENT_SECRET, QBO_REALM_ID, and QBO_REFRESH_TOKEN environment variables
- Re-authorize the QuickBooks connection if tokens are expired

## Testing

The endpoint includes comprehensive unit tests covering:
- Successful sync for all document types
- Request validation
- Error handling for API failures
- Invalid request format handling

Run tests with:
```bash
npm test -- manualQboSync
```

## Notes

- All monetary amounts should be in the currency's base unit (e.g., cents for USD)
- Document numbers must be unique within QuickBooks
- Ensure proper QuickBooks authentication is configured before using this endpoint
- This endpoint is intended for manual operations and administrative use
- **Items are created automatically** when referenced by name, eliminating the need for manual item setup
- Item creation is logged for transparency and troubleshooting