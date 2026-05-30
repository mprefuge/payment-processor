# Customer Sync Implementation for Stripe True-Up

## Overview

The Stripe True-Up functionality has been enhanced to automatically create/update customers in Salesforce when processing payments and refunds. This ensures that customer data from Stripe is synchronized with Salesforce, using the transaction category/type as the customer name.

## Changes Made

### 1. Salesforce Service Enhancement (`src/services/salesforceSvc.ts`)

#### New Interface: `CustomerUpsertDTO`
```typescript
export interface CustomerUpsertDTO {
  stripe_customer_id__c: string;  // Required: Stripe Customer ID (external ID)
  Name: string;                   // Required: Customer name/category
  Email?: string | null;          // Optional: Customer email
  FirstName?: string | null;      // Optional: First name
  LastName?: string | null;       // Optional: Last name
}
```

#### New Method: `upsertCustomerByStripeId`
- Creates or updates a Salesforce Contact using the Stripe Customer ID as the external ID
- Automatically handles the LastName requirement for Salesforce Contacts
- Uses `Stripe_Customer_Id__c` field for upsert operations
- Non-blocking: errors are logged but don't halt transaction processing

### 2. True-Up Handler Enhancement (`src/handlers/stripeTrueUp.ts`)

#### New Function: `getTransactionNameFromMetadata`
Extracts the transaction name from charge metadata with fallback logic:
1. Looks for `category` or `Category` field (from checkout sessions)
2. Falls back to `transactionType` or `TransactionType` field
3. Returns `null` if neither is found

#### New Function: `upsertStripeCustomerToSalesforce`
- Retrieves customer information from Stripe
- Uses transaction name (category/type) as the customer name in Salesforce
- Falls back to customer name, email, or ID if transaction name is unavailable
- Logs success/failure but doesn't interrupt transaction processing

#### Updated Logic for Payment Processing
- After creating/updating the transaction in Salesforce
- Retrieves the Stripe customer associated with the charge
- Extracts the transaction name from charge metadata
- Upserts the customer to Salesforce with the transaction name as the category

#### Updated Logic for Refund Processing
- Retrieves the full charge object to get customer information
- Extracts transaction name from the original charge metadata
- Upserts the customer to Salesforce if customer info is available

### 3. QuickBooks Service Enhancement (`src/services/qboSvc.ts`)

#### Updated Function: `deriveSalesReceiptCustomer`
Enhanced customer name derivation logic to prioritize transaction category/type:

**New Priority Order:**
1. **Transaction Name** from charge metadata (`category` or `transactionType`)
2. **Transaction Name** from checkout session metadata
3. Customer name from Stripe Customer object
4. Customer name from checkout details
5. Customer name from shipping/billing details
6. Email address
7. Fallback to Stripe Customer ID or Charge ID

**Impact:**
- QuickBooks customers are now named by transaction category/type when available
- Consistent customer naming between Salesforce and QuickBooks
- Automatic customer categorization in both systems

## Customer Name Priority

The customer name in both Salesforce and QuickBooks is set using the following priority:

1. **Transaction Category** from charge metadata (`category`)
2. **Transaction Category** from checkout session metadata
3. **Customer Name** from Stripe Customer object
4. **Customer Email** from Stripe Customer object (Salesforce only)
5. **Fallback**: `"Customer {stripe_customer_id}"` (Salesforce) or `"Stripe Customer {id}"` (QuickBooks)

**Important**: The `transactionType` metadata field is used exclusively for QuickBooks item/product type classification and is NOT used for customer categorization.

### QuickBooks Specific Behavior
- Uses `DisplayName` field for customer identification
- Searches by email first, then by display name
- Updates existing customers with transaction category name when found
- Adds Stripe Customer ID to customer notes for reference

## Salesforce Requirements

### Contact Object Fields
Ensure the following custom fields exist on the Contact object:

- **Stripe_Customer_Id__c** (Text, External ID, Unique)
  - Used to match and update existing contacts
  - Should be marked as External ID in Salesforce

### Example Salesforce Field Setup
```
Field Label: Stripe Customer ID
Field Name: Stripe_Customer_Id__c
Data Type: Text (255)
External ID: Yes
Unique: Yes
Required: No
```

## Usage

The customer sync happens automatically during true-up operations:

```bash
# Dry run to see what would be processed
curl -X GET "https://your-function.azurewebsites.net/api/stripe/true-up?from=2024-01-01&to=2024-01-31&type=payments&dryRun=true&code=YOUR_CODE"

# Actual run - will sync customers
curl -X GET "https://your-function.azurewebsites.net/api/stripe/true-up?from=2024-01-01&to=2024-01-31&type=payments&code=YOUR_CODE"
```

## Transaction Types Supported

- **Payments**: Syncs customer from charge object
- **Refunds**: Syncs customer from the original charge object

## Error Handling

- Customer sync errors are logged but don't prevent transaction processing
- If customer retrieval fails, processing continues without customer sync
- Salesforce upsert failures are logged with full error details

## Logging

Look for these log entries:
- `[StripeTrueUp] Upserted customer to Salesforce` - Success
- `[StripeTrueUp] Failed to upsert customer to Salesforce` - Error
- `[StripeTrueUp] Failed to retrieve Stripe customer` - Customer retrieval failed

## Example Metadata

To ensure proper customer categorization, include these fields in Stripe metadata:

```javascript
// On Checkout Session or Payment Intent
{
  metadata: {
    category: "Donation",           // Preferred: becomes customer name
    transactionType: "Membership",  // Alternative: used if category absent
    // ... other metadata
  }
}
```

## Benefits

1. **Automatic Customer Sync**: No manual data entry required in Salesforce or QuickBooks
2. **Category-Based Organization**: Customers are named by transaction category in both systems
3. **Data Consistency**: Single source of truth (Stripe) flows to both Salesforce and QuickBooks
4. **Unified Naming**: Transaction categories create consistent customer names across platforms
5. **Non-Disruptive**: Errors don't block payment processing
6. **Flexible Fallbacks**: Works even without metadata

## System Integration Flow

```
Stripe Charge Metadata
        ↓
    category / transactionType
        ↓
    ┌───────────────────┐
    │  True-Up Handler  │
    └───────────────────┘
         ↓         ↓
    Salesforce   QuickBooks
    (Contact)    (Customer)
         ↓         ↓
    Same Name    Same Name
```

## Future Enhancements

Potential improvements:
- Support for updating Account object in addition to Contact
- Custom field mapping configuration
- Batch customer sync for better performance
- Customer deduplication by email
- Support for Address and Phone fields
