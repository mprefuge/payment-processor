# Salesforce Payout Object Setup Guide

This guide provides step-by-step instructions for creating the custom `Payout__c` object in Salesforce to support the CRM payout storage feature.

## Prerequisites

- Salesforce org with admin access
- Ability to create custom objects and fields

## Create the Custom Object

1. Navigate to: **Setup → Object Manager → Create → Custom Object**

2. Configure the custom object:
   - **Label**: Payout
   - **Plural Label**: Payouts
   - **Object Name**: Payout__c
   - **Record Name**: Payout Name
   - **Data Type**: Text
   - **Allow Reports**: ✓ (checked)
   - **Allow Activities**: ✓ (checked)
   - **Track Field History**: ✓ (recommended)

3. Click **Save**

## Create Custom Fields

Create the following custom fields on the `Payout__c` object:

### Stripe Identifiers

**1. Payout ID**
- **Field Label**: Payout ID
- **API Name**: Payout_ID__c
- **Data Type**: Text
- **Length**: 255
- **Required**: ✓
- **Unique**: ✓
- **External ID**: ✓
- **Description**: Stripe payout ID (e.g., po_xxx)

**2. Stripe Account ID**
- **Field Label**: Stripe Account ID
- **API Name**: Stripe_Account_ID__c
- **Data Type**: Text
- **Length**: 255
- **Description**: Stripe account ID or 'default'

### Financial Details

**3. Amount**
- **Field Label**: Amount
- **API Name**: Amount__c
- **Data Type**: Currency(16, 2)
- **Required**: ✓
- **Description**: Net payout amount

**4. Currency**
- **Field Label**: Currency
- **API Name**: Currency__c
- **Data Type**: Text
- **Length**: 3
- **Default Value**: USD
- **Description**: ISO currency code (USD, EUR, etc.)

**5. Arrival Date**
- **Field Label**: Arrival Date
- **API Name**: Arrival_Date__c
- **Data Type**: Date
- **Description**: When funds arrived in bank account

**6. Created Date**
- **Field Label**: Created Date
- **API Name**: Created_Date__c
- **Data Type**: Date/Time
- **Description**: When payout was created in Stripe

**7. Status**
- **Field Label**: Status
- **API Name**: Status__c
- **Data Type**: Picklist
- **Values**: 
  - Paid
  - Pending
  - Failed
  - Canceled
- **Default Value**: Paid
- **Description**: Current status of the payout

**8. Description**
- **Field Label**: Description
- **API Name**: Description__c
- **Data Type**: Long Text Area
- **Length**: 32,768
- **Visible Lines**: 3
- **Description**: Description of the payout

### Transaction Summary Fields

**9. Charge Count**
- **Field Label**: Charge Count
- **API Name**: Charge_Count__c
- **Data Type**: Number(10, 0)
- **Default Value**: 0
- **Description**: Number of charges in this payout

**10. Charge Amount**
- **Field Label**: Charge Amount
- **API Name**: Charge_Amount__c
- **Data Type**: Currency(16, 2)
- **Default Value**: 0
- **Description**: Gross charge amount

**11. Refund Count**
- **Field Label**: Refund Count
- **API Name**: Refund_Count__c
- **Data Type**: Number(10, 0)
- **Default Value**: 0
- **Description**: Number of refunds in this payout

**12. Refund Amount**
- **Field Label**: Refund Amount
- **API Name**: Refund_Amount__c
- **Data Type**: Currency(16, 2)
- **Default Value**: 0
- **Description**: Total refund amount

**13. Fee Amount**
- **Field Label**: Fee Amount
- **API Name**: Fee_Amount__c
- **Data Type**: Currency(16, 2)
- **Default Value**: 0
- **Description**: Total Stripe fees

**14. Dispute Count**
- **Field Label**: Dispute Count
- **API Name**: Dispute_Count__c
- **Data Type**: Number(10, 0)
- **Default Value**: 0
- **Description**: Number of disputes in this payout

**15. Dispute Amount**
- **Field Label**: Dispute Amount
- **API Name**: Dispute_Amount__c
- **Data Type**: Currency(16, 2)
- **Default Value**: 0
- **Description**: Total dispute amount

### Accounting Integration References

**16. Accounting Journal Entry ID**
- **Field Label**: Accounting Journal Entry ID
- **API Name**: Accounting_Journal_Entry_ID__c
- **Data Type**: Text
- **Length**: 255
- **Description**: Journal entry ID in accounting system (e.g., QuickBooks)

**17. Accounting Transfer ID**
- **Field Label**: Accounting Transfer ID
- **API Name**: Accounting_Transfer_ID__c
- **Data Type**: Text
- **Length**: 255
- **Description**: Transfer transaction ID in accounting system

**18. Accounting Deposit ID**
- **Field Label**: Accounting Deposit ID
- **API Name**: Accounting_Deposit_ID__c
- **Data Type**: Text
- **Length**: 255
- **Description**: Deposit transaction ID in accounting system

### Metadata

**19. Metadata**
- **Field Label**: Metadata
- **API Name**: Metadata__c
- **Data Type**: Long Text Area
- **Length**: 32,768
- **Visible Lines**: 5
- **Description**: JSON metadata from Stripe payout

## Page Layout Configuration

After creating all fields, configure the page layout:

1. Go to: **Setup → Object Manager → Payout → Page Layouts → Payout Layout**

2. Organize fields into sections:

   **Payout Information**
   - Payout Name (auto-generated)
   - Payout ID
   - Stripe Account ID
   - Status
   - Description

   **Financial Details**
   - Amount
   - Currency
   - Arrival Date
   - Created Date

   **Transaction Summary**
   - Charge Count | Charge Amount
   - Refund Count | Refund Amount
   - Fee Amount
   - Dispute Count | Dispute Amount

   **Accounting Integration**
   - Accounting Journal Entry ID
   - Accounting Transfer ID
   - Accounting Deposit ID

   **System Information**
   - Metadata
   - Created By, Last Modified By (standard fields)

3. Save the layout

## Optional: Create List Views

Create useful list views for payout management:

**Recent Payouts**
- Filter: Created Date = LAST 30 DAYS
- Columns: Payout Name, Amount, Arrival Date, Status, Charge Count

**Failed Payouts**
- Filter: Status = Failed
- Columns: Payout Name, Amount, Arrival Date, Description

**Large Payouts**
- Filter: Amount > 10000
- Columns: Payout Name, Amount, Currency, Arrival Date, Charge Count

## Optional: Create Reports and Dashboards

### Sample Report: Monthly Payout Summary
- Report Type: Payouts
- Group By: Arrival Date (Month)
- Show: Sum of Amount, Count of Records
- Chart Type: Line Chart

### Sample Dashboard: Payout Overview
- Total Payouts This Month (Metric)
- Total Amount This Month (Metric)
- Payout Trend (Line Chart)
- Top 10 Payouts (Table)

## Validation Rules (Optional)

Add validation rules for data quality:

**1. Valid Currency Code**
```
NOT(OR(
  ISBLANK(Currency__c),
  LEN(Currency__c) = 3
))
```
Error Message: "Currency must be a 3-letter ISO code (e.g., USD, EUR)"

**2. Valid Status Transition**
```
AND(
  ISCHANGED(Status__c),
  PRIORVALUE(Status__c) = "Paid",
  OR(Status__c = "Pending", Status__c = "Failed")
)
```
Error Message: "Cannot change status from Paid to Pending/Failed"

## Field-Level Security

Configure field-level security as needed:
- Standard Users: Read-only access to all fields
- Administrators: Read/Write access to all fields

## Record Types (Optional)

If you have multiple Stripe accounts or want to separate test vs. production:

1. Create Record Types:
   - Production Payouts
   - Test Payouts

2. Add criteria or processes to auto-assign record types based on Stripe Account ID

## Integration Testing

After setup, test the integration:

1. Ensure `CRM_PROVIDER=salesforce` is configured in your Azure Function
2. Trigger a test payout in Stripe
3. Verify a `Payout__c` record is created in Salesforce
4. Check that all fields are populated correctly
5. Verify accounting document IDs are linked

## Troubleshooting

**Issue**: Records not being created
- **Solution**: Check Azure Function logs for CRM connection errors
- Verify Salesforce credentials are correct
- Ensure API access is enabled for the integration user

**Issue**: Missing fields error
- **Solution**: Verify all custom fields are created with exact API names
- Check field-level security settings
- Review the SalesforceCrmService implementation logs

**Issue**: Duplicate records
- **Solution**: Verify `Payout_ID__c` is marked as External ID and Unique
- Check for existing records with same Payout ID

## Maintenance

- Review and archive old payout records periodically
- Monitor field usage to identify unused fields
- Update picklist values as needed
- Review and update reports and dashboards quarterly

## Support

For issues with:
- Salesforce setup: Contact your Salesforce administrator
- Integration code: Review logs in Azure Function App
- Feature requests: Create an issue in the GitHub repository
