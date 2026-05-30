# Salesforce Setup Guide for Payout Feature

## Overview

This guide walks you through setting up the required Salesforce custom fields to support the Stripe Payout integration.

## Prerequisites

- Salesforce Administrator access
- Existing `Transaction__c` custom object (or similar transaction tracking object)
- Understanding of custom field creation in Salesforce

## Step-by-Step Setup

### Step 1: Add "payout" to Transaction_Type__c Picklist

1. Navigate to **Setup** → **Object Manager** → **Transaction__c**
2. Click on **Fields & Relationships**
3. Find and click on **Transaction_Type__c**
4. Scroll to **Values** section
5. Click **New** to add a new picklist value
6. Enter `payout` as the value
7. Click **Save**

**Verification:** The picklist should now include:
- charge
- refund
- dispute
- payout ✓

### Step 2: Verify Required Fields Exist

Check that the following fields already exist. If not, create them:

#### Stripe_Payout_Id__c
- **Field Label:** Stripe Payout ID
- **Field Name:** Stripe_Payout_Id__c
- **Data Type:** Text
- **Length:** 255
- **Required:** No
- **Unique:** No
- **External ID:** Yes ✓

**To Create:**
```
Setup → Object Manager → Transaction__c → Fields & Relationships → New
→ Text → Next
→ Field Label: "Stripe Payout ID"
→ Length: 255
→ Field Name: "Stripe_Payout_Id__c"
→ External ID: ✓ (checked)
→ Next → Next → Save
```

#### Stripe_Balance_Transaction_Id__c (Should Already Exist)
- **Field Label:** Stripe Balance Transaction ID
- **Field Name:** Stripe_Balance_Transaction_Id__c
- **Data Type:** Text
- **Length:** 255
- **External ID:** Yes ✓ (REQUIRED for upserts)

**If Missing or Not External ID:**
```
Setup → Object Manager → Transaction__c → Fields & Relationships
→ Find "Stripe_Balance_Transaction_Id__c" → Edit
→ External ID: ✓ (checked)
→ Save
```

### Step 3: Create/Verify Financial Fields

#### Amount_Gross__c
```
Field Label: Amount Gross
Field Name: Amount_Gross__c
Data Type: Currency
Decimal Places: 2
Required: No
Default Value: (blank)
```

#### Amount_Fee__c
```
Field Label: Amount Fee
Field Name: Amount_Fee__c
Data Type: Currency
Decimal Places: 2
Required: No
Default Value: (blank)
```

#### Amount_Net__c
```
Field Label: Amount Net
Field Name: Amount_Net__c
Data Type: Currency
Decimal Places: 2
Required: No
Default Value: (blank)
```

#### Currency_ISO_Code__c
```
Field Label: Currency ISO Code
Field Name: Currency_ISO_Code__c
Data Type: Text
Length: 3
Required: No
Default Value: USD (optional)
```

### Step 4: Create/Verify QuickBooks Integration Fields

#### Posted_to_QBO__c
```
Field Label: Posted to QBO
Field Name: Posted_to_QBO__c
Data Type: Checkbox
Default Value: Unchecked
```

#### QBO_Doc_Type__c
```
Field Label: QBO Document Type
Field Name: QBO_Doc_Type__c
Data Type: Text
Length: 50
Required: No
```

#### QBO_Doc_Id__c
```
Field Label: QBO Document ID
Field Name: QBO_Doc_Id__c
Data Type: Text
Length: 50
Required: No
```

#### QBO_Posted_At__c
```
Field Label: QBO Posted At
Field Name: QBO_Posted_At__c
Data Type: Date/Time
Required: No
```

#### Posting_Error__c
```
Field Label: Posting Error
Field Name: Posting_Error__c
Data Type: Text Area
Length: 255 (or Long Text Area)
Required: No
```

### Step 5: Create/Verify Additional Required Fields

#### Memo__c
```
Field Label: Memo
Field Name: Memo__c
Data Type: Text Area (Long)
Length: 32,768 characters
Visible Lines: 3
Required: No
```

#### Received_At__c
```
Field Label: Received At
Field Name: Received_At__c
Data Type: Date/Time
Required: No
```

#### Status__c (Verify Picklist Values)
Ensure the following values exist:
- pending
- processing
- paid ✓
- refunded
- disputed
- failed ✓

### Step 6: Update Page Layouts

1. Navigate to **Setup** → **Object Manager** → **Transaction__c**
2. Click **Page Layouts**
3. Edit your default layout (or create a payout-specific layout)

**Suggested Section: "Payout Details"**
```
┌─────────────────────────────────────┐
│ Payout Details                      │
├─────────────────────────────────────┤
│ Stripe Payout ID                    │
│ Amount Gross    │ Amount Fee        │
│ Amount Net      │ Currency ISO Code │
│ Received At     │                   │
└─────────────────────────────────────┘
```

**Suggested Section: "QuickBooks Sync"**
```
┌─────────────────────────────────────┐
│ QuickBooks Sync                     │
├─────────────────────────────────────┤
│ Posted to QBO   │                   │
│ QBO Doc Type    │ QBO Doc ID        │
│ QBO Posted At   │                   │
│ Posting Error                       │
└─────────────────────────────────────┘
```

### Step 7: Create List Views

**Create a "Recent Payouts" List View:**
1. Navigate to **Transaction__c** tab
2. Click gear icon → **New List View**
3. Name: "Recent Payouts"
4. Filter Criteria:
   - Transaction Type equals "payout"
5. Select visible fields:
   - Transaction Name
   - Status
   - Stripe Payout ID
   - Amount Net
   - Currency ISO Code
   - Received At
   - Posted to QBO
   - QBO Posted At
6. Save

**Create a "Failed Payouts" List View:**
1. Name: "Failed Payouts"
2. Filter Criteria:
   - Transaction Type equals "payout"
   - Status equals "failed"
3. Same visible fields as above
4. Save

### Step 8: Set Field-Level Security

For each created/modified field:
1. Navigate to the field detail page
2. Click **Set Field-Level Security**
3. Grant access to relevant profiles:
   - System Administrator: Read/Edit ✓
   - Standard User: Read ✓ (Edit optional)
   - Integration User: Read/Edit ✓
4. Click **Save**

### Step 9: Create Validation Rules (Optional)

**Ensure Payout ID is Present for Payout Type:**
```
Rule Name: Payout_Requires_Stripe_Payout_ID
Error Condition Formula:
AND(
  ISPICKVAL(Transaction_Type__c, "payout"),
  ISBLANK(Stripe_Payout_Id__c)
)
Error Message: "Stripe Payout ID is required for payout transactions."
Error Location: Stripe_Payout_Id__c
```

**Ensure Amounts Make Sense:**
```
Rule Name: Payout_Amount_Validation
Error Condition Formula:
AND(
  ISPICKVAL(Transaction_Type__c, "payout"),
  Amount_Net__c != (Amount_Gross__c - Amount_Fee__c)
)
Error Message: "Net amount must equal Gross minus Fees."
Error Location: Amount_Net__c
```

### Step 10: Create Reports (Optional)

**Daily Payout Summary Report:**
1. Navigate to **Reports** → **New Report**
2. Report Type: Custom Report Type based on Transaction__c
3. Filters:
   - Transaction Type = "payout"
   - Received At = THIS_MONTH
4. Group By: Received At (by Day)
5. Columns:
   - Stripe Payout ID
   - Status
   - Amount Gross
   - Amount Fee
   - Amount Net
   - Posted to QBO
6. Summary:
   - SUM(Amount_Gross__c)
   - SUM(Amount_Fee__c)
   - SUM(Amount_Net__c)
7. Save as "Monthly Payout Summary"

## Verification Checklist

Use this checklist to verify your setup is complete:

- [ ] Transaction_Type__c picklist includes "payout"
- [ ] Status__c picklist includes "paid" and "failed"
- [ ] Stripe_Payout_Id__c exists and is an External ID
- [ ] Stripe_Balance_Transaction_Id__c is marked as External ID
- [ ] All currency fields exist (Amount_Gross__c, Amount_Fee__c, Amount_Net__c)
- [ ] Currency_ISO_Code__c exists
- [ ] Memo__c exists as Text Area (Long)
- [ ] Received_At__c exists as Date/Time
- [ ] All QBO fields exist (Posted_to_QBO__c, QBO_Doc_Type__c, etc.)
- [ ] Page layout updated with payout-related fields
- [ ] List views created for viewing payouts
- [ ] Field-level security configured for integration user
- [ ] Validation rules created (optional)
- [ ] Reports created (optional)

## Testing the Setup

After completing the setup, test by creating a manual transaction:

1. Navigate to **Transaction__c** → **New**
2. Set:
   - Transaction Type: payout
   - Status: paid
   - Stripe Payout ID: po_test123
   - Amount Gross: 1000.00
   - Amount Fee: 30.00
   - Amount Net: 970.00
   - Currency ISO Code: USD
3. Save

If save succeeds and all fields are visible, your setup is complete!

## Common Issues

### "Field does not exist" error in webhook logs
**Solution:** Verify the field API name matches exactly (including `__c` suffix)

### Upsert fails with "Cannot reference External ID field"
**Solution:** Ensure Stripe_Balance_Transaction_Id__c has "External ID" checked

### Cannot see fields on page layout
**Solution:** 
1. Check field-level security for your user profile
2. Verify fields are added to the page layout

### Validation rule prevents creation
**Solution:** Temporarily disable validation rules or ensure test data meets criteria

## Next Steps

After completing Salesforce setup:
1. Configure QuickBooks accounts (see main documentation)
2. Set environment variables for integration
3. Test with Stripe webhook events
4. Monitor logs for successful payout processing

## Support

For issues with:
- **Salesforce setup:** Contact your Salesforce Administrator
- **Integration code:** Check the application logs
- **Webhook processing:** Review the payout-feature-guide.md

## Appendix: Field Summary Table

| Field API Name | Label | Type | Length | External ID | Required |
|----------------|-------|------|--------|-------------|----------|
| Transaction_Type__c | Transaction Type | Picklist | - | No | Yes |
| Status__c | Status | Picklist | - | No | Yes |
| Stripe_Payout_Id__c | Stripe Payout ID | Text | 255 | Yes | No |
| Stripe_Balance_Transaction_Id__c | Stripe Balance Transaction ID | Text | 255 | Yes | No |
| Amount_Gross__c | Amount Gross | Currency | - | No | No |
| Amount_Fee__c | Amount Fee | Currency | - | No | No |
| Amount_Net__c | Amount Net | Currency | - | No | No |
| Currency_ISO_Code__c | Currency ISO Code | Text | 3 | No | No |
| Memo__c | Memo | Text Area (Long) | 32,768 | No | No |
| Received_At__c | Received At | Date/Time | - | No | No |
| Posted_to_QBO__c | Posted to QBO | Checkbox | - | No | No |
| QBO_Doc_Type__c | QBO Document Type | Text | 50 | No | No |
| QBO_Doc_Id__c | QBO Document ID | Text | 50 | No | No |
| QBO_Posted_At__c | QBO Posted At | Date/Time | - | No | No |
| Posting_Error__c | Posting Error | Text Area | 255+ | No | No |
