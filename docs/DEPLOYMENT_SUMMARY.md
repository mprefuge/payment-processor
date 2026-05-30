# Customer Sync Implementation Summary

## Overview
Enhanced the Stripe True-Up functionality to automatically sync customer information from Stripe to both **Salesforce** and **QuickBooks**, using transaction category/type as the customer name.

## Key Changes

### 1. Salesforce Integration
- **File**: `src/services/salesforceSvc.ts`
- **New Method**: `upsertCustomerByStripeId()`
- **Behavior**: Creates/updates Contacts using `Stripe_Customer_Id__c` as external ID
- **Implementation**: True-up handler calls this after processing each transaction

### 2. QuickBooks Integration  
- **File**: `src/services/qboSvc.ts`
- **Updated Function**: `deriveSalesReceiptCustomer()`
- **Behavior**: Prioritizes transaction category/type for customer DisplayName
- **Implementation**: Existing QBO customer creation flow, now with enhanced name logic

### 3. True-Up Handler
- **File**: `src/handlers/stripeTrueUp.ts`
- **New Functions**: 
  - `getTransactionNameFromMetadata()` - Extracts category/type from metadata
  - `upsertStripeCustomerToSalesforce()` - Syncs to Salesforce
- **Enhanced**: Payment and refund processing to include customer sync

## Customer Name Priority

Both systems use the same priority:

```
1. charge.metadata.category
2. charge.metadata.transactionType  
3. checkoutSession.metadata.category
4. checkoutSession.metadata.transactionType
5. customer.name (Stripe Customer object)
6. customer.email
7. System-specific fallback
```

## Example Workflow

```
1. Stripe Charge received with metadata:
   { category: "General Donation" }

2. True-Up processes the charge:
   → Creates/updates Salesforce Contact: "General Donation"
   → Creates/updates QuickBooks Customer: "General Donation"

3. Result:
   ✓ Unified customer name across platforms
   ✓ Category-based organization
   ✓ Automatic data consistency
```

## Testing Checklist

- [ ] Deploy to Azure Function
- [ ] Run dry-run true-up for a date range
- [ ] Verify Salesforce Contact creation with correct name
- [ ] Verify QuickBooks Customer creation with correct name
- [ ] Test with charge containing `category` metadata
- [ ] Test with charge containing `transactionType` metadata
- [ ] Test with charge containing no metadata (fallback to customer name)
- [ ] Verify refund processing includes customer sync
- [ ] Check logs for successful customer upserts

## Configuration Required

### Salesforce
Custom field on Contact object:
- **API Name**: `Stripe_Customer_Id__c`
- **Type**: Text (255)
- **External ID**: Yes
- **Unique**: Yes

### QuickBooks
No additional configuration required. Uses existing customer management.

## Error Handling

- **Salesforce**: Errors logged but don't halt transaction processing
- **QuickBooks**: Existing error handling maintained (throws on critical failures)
- All customer sync operations include detailed logging

## Deployment Notes

1. Build passes successfully
2. No breaking changes to existing functionality
3. Backwards compatible - works with or without metadata
4. Documentation updated in `/docs` folder

## Files Modified

1. `src/services/salesforceSvc.ts` - Added customer upsert capability
2. `src/handlers/stripeTrueUp.ts` - Added customer sync logic
3. `src/services/qboSvc.ts` - Enhanced customer name derivation
4. `src/handlers/stripeWebhook.ts` - Updated mock service
5. `docs/CUSTOMER_SYNC_IMPLEMENTATION.md` - Comprehensive guide
6. `docs/customer-sync-quick-reference.md` - Quick reference

## Next Steps

1. Deploy to production
2. Monitor logs for customer sync activity
3. Verify customer names in both Salesforce and QuickBooks
4. Consider adding custom field for category in both systems (future enhancement)
