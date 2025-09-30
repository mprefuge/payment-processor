# Salesforce Pledge Objects Setup Guide

This guide provides instructions for setting up the custom Salesforce objects required for the Pledges feature.

## Overview

The Pledges feature requires three new custom objects in Salesforce:
1. **Pledge__c** - Master pledge records
2. **PledgeInstallment__c** - Individual installment schedules
3. **PledgePaymentAllocation__c** - Junction object linking transactions to installments

Additionally, the existing **Transaction__c** object needs new optional fields for pledge tracking.

## Prerequisites

- Salesforce Administrator access
- Transaction__c custom object already created (if not, see main README)
- API user with permissions to create/read/update these objects

## Object Definitions

### 1. Pledge__c

**Label**: Pledge  
**Plural Label**: Pledges  
**Object Name**: Pledge__c

#### Fields

| API Name | Label | Type | Length/Options | Required | Notes |
|----------|-------|------|----------------|----------|-------|
| Name | Pledge Name | Auto Number | Format: PLG-{0000} | Yes | Auto-generated |
| Contact__c | Contact | Lookup(Contact) | - | Yes | The donor making the pledge |
| Fund_Category__c | Fund/Category | Text or Picklist | 100 | Yes | Align with transaction categories |
| Total_Amount__c | Total Amount | Currency | 16,2 | Yes | Total pledge amount |
| Currency__c | Currency | Text/Picklist | 3 | Yes | ISO currency code (USD, EUR, etc.) |
| Balance_Remaining__c | Balance Remaining | Currency | 16,2 | No | Rollup or calculated field |
| Start_Date__c | Start Date | Date | - | Yes | First installment date |
| End_Date__c | End Date | Date | - | No | Calculated from schedule |
| Schedule_Type__c | Schedule Type | Picklist | - | Yes | Monthly, Quarterly, Custom |
| Number_of_Installments__c | Number of Installments | Number | 18,0 | Yes | Total installment count |
| Status__c | Status | Picklist | - | Yes | Active, Fulfilled, Canceled, Written-Off, Paused |
| Notes__c | Notes | Long Text Area | 32768 | No | Internal notes |
| Write_Off_Reason__c | Write-Off Reason | Text Area | 1000 | No | Reason for write-off |
| Write_Off_Date__c | Write-Off Date | Date | - | No | When written off |

#### Additional Setup
- **Record Ownership**: Set to Contact's owner by default
- **Page Layouts**: Create layouts showing installments as related list
- **Validation Rules**: 
  - Total_Amount__c must be > 0
  - Number_of_Installments__c must be > 0
  - Start_Date__c cannot be in the past (for new pledges)
- **Workflow/Process Builder**: 
  - Update Status__c to "Fulfilled" when Balance_Remaining__c = 0
  - Update Status__c to "Paused" based on user action
- **Rollup Summary** (if using managed package):
  - Balance_Remaining__c = Total_Amount__c - SUM(PledgePaymentAllocation__c.Amount_Applied__c WHERE Pledge__c = THIS)

### 2. PledgeInstallment__c

**Label**: Pledge Installment  
**Plural Label**: Pledge Installments  
**Object Name**: PledgeInstallment__c

#### Fields

| API Name | Label | Type | Length/Options | Required | Notes |
|----------|-------|------|----------------|----------|-------|
| Name | Installment Name | Auto Number | Format: INST-{00000} | Yes | Auto-generated |
| Pledge__c | Pledge | Master-Detail(Pledge__c) | - | Yes | Parent pledge |
| Sequence_Number__c | Sequence | Number | 18,0 | Yes | 1, 2, 3, etc. |
| Due_Date__c | Due Date | Date | - | Yes | When payment is due |
| Amount_Due__c | Amount Due | Currency | 16,2 | Yes | Expected payment amount |
| Amount_Paid__c | Amount Paid | Currency | 16,2 | No | Rollup from allocations |
| Balance_Remaining__c | Balance Remaining | Formula(Currency) | - | No | Amount_Due__c - Amount_Paid__c |
| Status__c | Status | Formula(Text) | - | No | See formula below |
| Notes__c | Notes | Text Area | 1000 | No | Optional notes |

#### Formula Fields

**Balance_Remaining__c**:
```
Amount_Due__c - BLANKVALUE(Amount_Paid__c, 0)
```

**Status__c**:
```
IF(
  BLANKVALUE(Amount_Paid__c, 0) >= Amount_Due__c,
  "Paid",
  IF(
    BLANKVALUE(Amount_Paid__c, 0) > 0,
    "Partial",
    IF(
      Due_Date__c < TODAY(),
      "Overdue",
      "Unpaid"
    )
  )
)
```

#### Additional Setup
- **Master-Detail Relationship**: Cascade delete from Pledge__c
- **Rollup Summary** (on Pledge__c):
  - COUNT of installments
  - SUM of Amount_Due__c to verify against Total_Amount__c
- **Validation Rules**:
  - Amount_Due__c must be > 0
  - Sequence_Number__c must be > 0
  - Due_Date__c must be >= Pledge__c.Start_Date__c

### 3. PledgePaymentAllocation__c

**Label**: Pledge Payment Allocation  
**Plural Label**: Pledge Payment Allocations  
**Object Name**: PledgePaymentAllocation__c

#### Fields

| API Name | Label | Type | Length/Options | Required | Notes |
|----------|-------|------|----------------|----------|-------|
| Name | Allocation Name | Auto Number | Format: ALLOC-{000000} | Yes | Auto-generated |
| Transaction__c | Transaction | Lookup(Transaction__c) | - | Yes | Payment transaction |
| Pledge__c | Pledge | Lookup(Pledge__c) | - | Yes | Related pledge |
| PledgeInstallment__c | Installment | Lookup(PledgeInstallment__c) | - | Yes | Specific installment |
| Amount_Applied__c | Amount Applied | Currency | 16,2 | Yes | Amount allocated |
| Allocation_Date__c | Allocation Date | Date/Time | - | Yes | When allocated |
| Applied_By__c | Applied By | Lookup(User) | - | No | User who applied (for manual) |
| Is_Automatic__c | Automatic Allocation | Checkbox | - | No | True if auto-matched |
| Confidence_Score__c | Confidence Score | Percent | 5,2 | No | Matching confidence |

#### Additional Setup
- **Unique Constraint**: Create a unique external ID field or use validation rules
  - Combination of Transaction__c + PledgeInstallment__c must be unique
- **Rollup Summaries**:
  - On PledgeInstallment__c: Amount_Paid__c = SUM(Amount_Applied__c WHERE PledgeInstallment__c = THIS)
  - On Pledge__c: Total_Paid__c = SUM(Amount_Applied__c WHERE Pledge__c = THIS)
- **Validation Rules**:
  - Amount_Applied__c must be > 0
  - Amount_Applied__c cannot exceed PledgeInstallment__c.Balance_Remaining__c (at time of allocation)
  - Transaction__c.Contact__c must match Pledge__c.Contact__c

### 4. Extend Transaction__c

Add the following fields to the existing Transaction__c object:

| API Name | Label | Type | Length/Options | Required | Notes |
|----------|-------|------|----------------|----------|-------|
| Pledge__c | Related Pledge | Lookup(Pledge__c) | - | No | Optional pledge reference |
| Is_Pledge_Payment__c | Is Pledge Payment | Formula(Checkbox) | - | No | `NOT(ISBLANK(Pledge__c))` |

## Security and Sharing

### Object Permissions
Grant the following permissions to the API user and relevant profiles:

**For all four objects** (Pledge__c, PledgeInstallment__c, PledgePaymentAllocation__c, Transaction__c):
- Read
- Create
- Edit
- Delete (for system cleanup, optional)

### Field-Level Security
- Ensure all required fields are visible and editable
- Sensitive fields (Write_Off_Reason__c, Notes__c) can be restricted to admin profiles

### Sharing Rules
- Pledges should inherit sharing from Contact (private/public read/write)
- PledgeInstallment__c inherits from Pledge__c via master-detail
- PledgePaymentAllocation__c should be visible to anyone who can see the Transaction or Pledge

## Page Layouts

### Pledge__c Layout
**Sections**:
1. Pledge Information
   - Contact__c, Fund_Category__c, Total_Amount__c, Currency__c
   - Start_Date__c, End_Date__c, Schedule_Type__c, Number_of_Installments__c
2. Status
   - Status__c, Balance_Remaining__c
3. Write-Off Information (conditional visibility)
   - Write_Off_Date__c, Write_Off_Reason__c
4. System Information
   - CreatedBy, LastModifiedBy, etc.

**Related Lists**:
- Pledge Installments
- Pledge Payment Allocations
- Transactions (via Pledge lookup)

### PledgeInstallment__c Layout
**Sections**:
1. Installment Details
   - Pledge__c, Sequence_Number__c, Due_Date__c
   - Amount_Due__c, Amount_Paid__c, Balance_Remaining__c, Status__c
2. Notes
   - Notes__c

**Related Lists**:
- Pledge Payment Allocations

### PledgePaymentAllocation__c Layout
**Sections**:
1. Allocation Details
   - Transaction__c, Pledge__c, PledgeInstallment__c
   - Amount_Applied__c, Allocation_Date__c
   - Applied_By__c, Is_Automatic__c, Confidence_Score__c

## Reports and Dashboards (Optional)

### Useful Reports
1. **Active Pledges by Contact** - List all active pledges with balances
2. **Overdue Installments** - Installments past due date with unpaid balance
3. **Pledge Fulfillment Rate** - Percentage of pledges fully paid vs total
4. **Monthly Pledge Payment Summary** - Total payments by month
5. **Uncertain Allocations** - Allocations with low confidence scores

### Sample SOQL Queries

**Get all active pledges with installments**:
```sql
SELECT Id, Name, Contact__c, Total_Amount__c, Balance_Remaining__c, Status__c,
       (SELECT Id, Sequence_Number__c, Due_Date__c, Amount_Due__c, Amount_Paid__c, Status__c 
        FROM PledgeInstallments__r 
        ORDER BY Due_Date__c ASC)
FROM Pledge__c
WHERE Status__c = 'Active'
ORDER BY Contact__c, Start_Date__c
```

**Get all allocations for a transaction**:
```sql
SELECT Id, Pledge__c, PledgeInstallment__c, Amount_Applied__c, Allocation_Date__c
FROM PledgePaymentAllocation__c
WHERE Transaction__c = '{transactionId}'
ORDER BY Allocation_Date__c DESC
```

## Deployment

### Option 1: Manual Setup
Follow the steps above to create each object and field manually in Salesforce Setup.

### Option 2: Metadata API (Advanced)
Use Salesforce CLI or Metadata API to deploy the objects. Sample package.xml structure:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<Package xmlns="http://soap.sforce.com/2006/04/metadata">
    <types>
        <members>Pledge__c</members>
        <members>PledgeInstallment__c</members>
        <members>PledgePaymentAllocation__c</members>
        <name>CustomObject</name>
    </types>
    <version>58.0</version>
</Package>
```

### Option 3: Unmanaged Package (Future)
Create an unmanaged package containing all objects and fields for easy installation.

## Testing

After setup, verify:
1. Can create a Pledge__c record
2. Can create PledgeInstallment__c records related to Pledge
3. Can create PledgePaymentAllocation__c records linking Transaction__c to PledgeInstallment__c
4. Formula fields (Balance_Remaining__c, Status__c) calculate correctly
5. Rollup summaries update properly
6. Validation rules prevent invalid data

## Troubleshooting

**Common Issues**:
1. **"Insufficient privileges"**: Check object and field-level security for API user
2. **"Required field missing"**: Ensure all required fields are populated in API calls
3. **"Duplicate external ID"**: Transaction+Installment combination already allocated
4. **Rollups not updating**: Check if master-detail relationship is correctly configured

## Next Steps

After Salesforce setup is complete:
1. Update environment variables with Salesforce credentials
2. Test pledge creation via API endpoints
3. Test transaction allocation workflow
4. Verify CRM sync is working
5. Train users on new Pledge functionality

## Support

For questions or issues with Salesforce setup, consult:
- Salesforce Administrator Guide
- Salesforce API Documentation
- Project documentation in `/docs/adr/`
