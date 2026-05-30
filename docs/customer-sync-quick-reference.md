# Stripe True-Up Customer Sync - Quick Reference

## What Changed

The Stripe True-Up feature now automatically syncs customer information from Stripe to **both Salesforce and QuickBooks** when processing payments and refunds.

## Customer Name Logic

Customers are created/updated in both systems with the name set in this priority:

1. **Transaction Category** from charge metadata (`metadata.category`)
2. **Transaction Category** from checkout session metadata
3. **Customer Name** from Stripe Customer object
4. **Customer Email** from Stripe Customer object (Salesforce only)
5. **Fallback**: System-specific default

**Note**: `metadata.transactionType` is used for QuickBooks item/product classification, not customer categorization.

## Example

### Stripe Checkout Session with Category
```javascript
{
  metadata: {
    category: "General Donation",
    transactionType: "One-Time Gift"  // Used for QB item, not customer name
  }
}
```

**Result in Salesforce:**
- Contact with `Stripe_Customer_Id__c = "cus_xxx"`
- `LastName = "General Donation"`

**Result in QuickBooks:**
- Customer with `DisplayName = "General Donation"`
- Notes: `"Stripe Customer ID: cus_xxx"`

### Stripe Customer without Metadata
```javascript
{
  id: "cus_abc123",
  name: "John Smith",
  email: "john@example.com"
}
```

**Result in Salesforce:**
- Contact with `Stripe_Customer_Id__c = "cus_abc123"`
- `LastName = "John Smith"`

**Result in QuickBooks:**
- Customer with `DisplayName = "John Smith"`
- Email: `"john@example.com"`
- Notes: `"Stripe Customer ID: cus_abc123"`

## Salesforce Setup Required

Add this custom field to the Contact object:

| Field          | Value                           |
|----------------|----------------------------------|
| Field Label    | Stripe Customer ID               |
| API Name       | Stripe_Customer_Id__c           |
| Data Type      | Text (255)                      |
| External ID    | ✓ Yes                           |
| Unique         | ✓ Yes                           |
| Required       | ✗ No                            |

## Testing

### Dry Run (Preview Only)
```bash
curl -X GET "https://your-function.azurewebsites.net/api/stripe/true-up?from=2024-01-01&to=2024-01-31&type=payments&dryRun=true&code=YOUR_CODE"
```

### Actual Sync
```bash
curl -X GET "https://your-function.azurewebsites.net/api/stripe/true-up?from=2024-01-01&to=2024-01-31&type=payments&code=YOUR_CODE"
```

## Logs to Monitor

✅ Success:
```
[StripeTrueUp] Upserted customer to Salesforce { customerId: 'cus_xxx', customerName: 'General Donation' }
```

⚠️ Error (non-blocking):
```
[StripeTrueUp] Failed to upsert customer to Salesforce { customerId: 'cus_xxx', error: '...' }
```

## Important Notes

- Customer sync errors in Salesforce **do not** prevent transaction processing
- Salesforce: Existing contacts are updated using `Stripe_Customer_Id__c`
- QuickBooks: Customers are matched by email or display name, then updated
- Works for both payments and refunds in both systems
- No changes to existing transaction processing logic
- **Both systems use the same customer name** when transaction category/type is provided
