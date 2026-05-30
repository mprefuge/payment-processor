# Salesforce Manual QBO Sync Setup Guide

## Overview

This guide provides step-by-step instructions for configuring Salesforce to integrate with the Manual QBO Sync endpoint, enabling **automatic and manual** sync of Transaction records to QuickBooks Online directly from Salesforce.

### Key Capabilities

🔄 **Automatic Sync** - Transactions automatically sync to QuickBooks when created  
👤 **Smart Contact Matching** - Finds or creates Salesforce contacts from transaction data  
📊 **Complete Field Mapping** - All QuickBooks fields supported (addresses, payment info, classes)  
⚡ **Async Processing** - Non-blocking sync using queueable jobs  
🔍 **Error Tracking** - Comprehensive retry logic and error reporting  
📈 **Rich Reporting** - Dashboards and list views for monitoring  

### Integration Flow

```
┌─────────────────────────────────────────────────────────────────┐
│                     TRANSACTION CREATION                         │
│                 (Stripe webhook, manual entry, etc.)             │
└────────────────────────────┬────────────────────────────────────┘
                             │
                             ▼
┌─────────────────────────────────────────────────────────────────┐
│                    TRANSACTION TRIGGER                           │
│              (TransactionTrigger - After Insert/Update)          │
│                                                                  │
│  Checks:                                                         │
│  • Status = 'paid'                                              │
│  • Posted_to_QBO__c = false                                     │
│  • Manual_Sync_Required__c = false                              │
│  • QBO_Target_Account__c populated                              │
│  • QBO_Item_Name__c populated                                   │
└────────────────────────────┬────────────────────────────────────┘
                             │
                             ▼
┌─────────────────────────────────────────────────────────────────┐
│                  QUEUEABLE JOB ENQUEUED                          │
│                    (QBOSyncQueueable)                            │
│                                                                  │
│  Async processing to avoid blocking transaction creation        │
└────────────────────────────┬────────────────────────────────────┘
                             │
                             ▼
┌─────────────────────────────────────────────────────────────────┐
│               CONTACT MATCHING (if no contact linked)            │
│                                                                  │
│  1. Search by Email ──────────┐                                │
│  2. Search by Name ───────────┼─► Found? ──► Link to Transaction│
│  3. Create New Contact ───────┘     │                           │
│                                      │                           │
│                                      ▼                           │
│                                   Not Found                      │
│                                      │                           │
│                                      ▼                           │
│                            Create New Contact                    │
│                                      │                           │
│                                      ▼                           │
│                            Link to Transaction                   │
└────────────────────────────┬────────────────────────────────────┘
                             │
                             ▼
┌─────────────────────────────────────────────────────────────────┐
│                  BUILD QBO PAYLOAD                               │
│                                                                  │
│  Data from Transaction:                                          │
│  • Amount, Date, Memo                                           │
│  • Customer Info (from Contact formulas)                         │
│  • Payment Details                                               │
│  • Billing Address (from Contact)                               │
│  • QBO Account, Item, Class, Department                         │
└────────────────────────────┬────────────────────────────────────┘
                             │
                             ▼
┌─────────────────────────────────────────────────────────────────┐
│              HTTP CALLOUT TO AZURE FUNCTION                      │
│                                                                  │
│  POST /qbo/manual-sync                                          │
│  {                                                               │
│    "type": "sales-receipt",                                     │
│    "data": { ... transaction data ... }                         │
│  }                                                               │
└────────────────────────────┬────────────────────────────────────┘
                             │
                             ▼
┌─────────────────────────────────────────────────────────────────┐
│                  AZURE FUNCTION PROCESSES                        │
│                                                                  │
│  • Validates payload                                             │
│  • Resolves QBO references by name                              │
│  • Creates/updates QBO record                                    │
│  • Returns QBO Doc ID and Type                                   │
└────────────────────────────┬────────────────────────────────────┘
                             │
                             ▼
┌─────────────────────────────────────────────────────────────────┐
│              UPDATE TRANSACTION RECORD                           │
│                                                                  │
│  SUCCESS:                        FAILURE:                        │
│  • Posted_to_QBO__c = true      • Posting_Error__c = error     │
│  • QBO_Doc_Id__c = doc ID       • Sync_Attempt_Count__c += 1   │
│  • QBO_Doc_Type__c = type       • Sync_Attempted_Date__c = now │
│  • QBO_Posted_At__c = now       • Posted_to_QBO__c = false     │
│  • Posting_Error__c = null                                      │
└─────────────────────────────────────────────────────────────────┘
```

### Quick Start Checklist

Use this checklist to track your implementation progress:

- [ ] **Prerequisites**
  - [ ] Azure Function URL and key obtained
  - [ ] Salesforce sandbox environment ready
  - [ ] Admin access to Salesforce

- [ ] **Custom Fields** (Step 1)
  - [ ] Created QBO configuration fields
  - [ ] Created sync tracking fields
  - [ ] Set field-level security

- [ ] **Page Layouts** (Step 2)
  - [ ] Updated Transaction layout
  - [ ] Added QBO Sync Configuration section
  - [ ] Configured field visibility

- [ ] **Quick Actions** (Step 3)
  - [ ] Created "Sync to QuickBooks" action
  - [ ] Created "Mark for Manual Review" action
  - [ ] Created "Clear QBO Sync Status" action

- [ ] **List Views** (Step 4)
  - [ ] Created "Pending QBO Sync" view
  - [ ] Created "Failed QBO Sync" view
  - [ ] Created "Manual Review Required" view
  - [ ] Created "Successfully Synced" view

- [ ] **Reports** (Step 5)
  - [ ] Created QBO Sync Status Dashboard
  - [ ] Created Daily Sync Summary
  - [ ] Created QBO Sync Errors report
  - [ ] Created Monthly Revenue report

- [ ] **Apex Code** (Step 6)
  - [ ] Created Named Credential
  - [ ] Deployed QBOManualSyncService class
  - [ ] Deployed TransactionTrigger
  - [ ] Deployed TransactionTriggerHandler
  - [ ] Deployed QBOSyncQueueable class
  - [ ] Deployed QBOManualSyncController
  - [ ] Deployed test classes
  - [ ] Created Custom Setting
  - [ ] Ran all tests (>75% coverage)

- [ ] **Permission Sets** (Step 7)
  - [ ] Created QBO Sync User permission set
  - [ ] Created QBO Sync Administrator permission set
  - [ ] Assigned to appropriate users

- [ ] **Testing** (Step 8)
  - [ ] Created test transaction
  - [ ] Verified automatic sync
  - [ ] Tested contact matching
  - [ ] Tested manual sync
  - [ ] Tested error handling
  - [ ] Verified list views
  - [ ] Validated reports

- [ ] **Automation** (Step 9)
  - [ ] Configured Custom Settings
  - [ ] Scheduled retry job (optional)
  - [ ] Set up email alerts (optional)

- [ ] **Production Deployment**
  - [ ] Deployed to production org
  - [ ] Updated Named Credential with prod URL
  - [ ] Configured production Custom Settings
  - [ ] Trained users
  - [ ] Documented custom configurations

---

1. [Prerequisites](#prerequisites)
2. [Custom Fields Setup](#custom-fields-setup)
3. [Page Layout Configuration](#page-layout-configuration)
4. [Quick Action Creation](#quick-action-creation)
5. [List View Configuration](#list-view-configuration)
6. [Report Configuration](#report-configuration)
7. [Apex Integration Code](#apex-integration-code)
8. [Permission Sets](#permission-sets)
9. [Testing Guide](#testing-guide)

---

## Prerequisites

### Required Information

- **Azure Function URL**: The endpoint for the manual QBO sync (e.g., `https://your-function-app.azurewebsites.net/qbo/manual-sync`)
- **Function Key**: Authentication key for the Azure Function
- **Salesforce API Access**: Ability to create Apex classes, custom fields, and page layouts

### Existing Transaction Object Fields

The following fields are already available on the Transaction object:

| Field API Name | Label | Type | Purpose |
|----------------|-------|------|---------|
| `Amount_Net__c` | Amount Net | Currency | Net transaction amount |
| `Amount_Gross__c` | Amount Gross | Currency | Gross transaction amount |
| `Amount_Fee__c` | Amount Fee | Currency | Processing fees |
| `Contact__c` | Contact | Lookup | Customer reference |
| `Received_At__c` | Date Received | DateTime | Transaction date |
| `Payment_Method__c` | Payment Method | Text | Payment method type |
| `Memo__c` | Memo | Text Area | Transaction notes |
| `Posted_to_QBO__c` | Posted to QBO | Checkbox | Sync status flag |
| `QBO_Doc_Id__c` | QBO Doc ID | Text | QuickBooks document ID |
| `QBO_Doc_Type__c` | QBO Doc Type | Text | QuickBooks document type |
| `QBO_Posted_At__c` | QBO Posted At | DateTime | Timestamp of QBO sync |
| `Posting_Error__c` | Posting Error | Text Area | Error messages from sync |

---

## Custom Fields Setup

### Step 1: Create Additional Custom Fields

Navigate to: **Setup → Object Manager → Transaction__c → Fields & Relationships**

Create the following fields if they don't already exist:

#### 1.1 QBO Sync Configuration Fields

**Field 1: QBO Target Account**
```
Label: QBO Target Account
API Name: QBO_Target_Account__c
Data Type: Text
Length: 255
Description: Name of the QuickBooks account to deposit to (e.g., "Checking Account")
Help Text: Enter the name of the QuickBooks account. The system will find or create it automatically.
```

**Field 2: QBO Item Name**
```
Label: QBO Item Name
API Name: QBO_Item_Name__c
Data Type: Text
Length: 255
Description: Name of the QuickBooks item/service for this transaction
Help Text: Enter the name of the QuickBooks item (e.g., "Donation", "Consulting Services")
Default Value: "General Giving"
```

**Field 3: QBO Customer Name**
```
Label: QBO Customer Name
API Name: QBO_Customer_Name__c
Data Type: Formula (Text)
Formula: IF(ISBLANK(Contact__r.Name), "Anonymous Donor", Contact__r.Name)
Description: Customer name to use in QuickBooks (derived from Contact)
```

**Field 4: QBO Customer Email**
```
Label: QBO Customer Email
API Name: QBO_Customer_Email__c
Data Type: Formula (Text)
Formula: Contact__r.Email
Description: Customer email for QuickBooks record matching
```

**Field 5: QBO Billing Address Line 1**
```
Label: QBO Billing Address Line 1
API Name: QBO_Bill_Addr_Line1__c
Data Type: Formula (Text)
Formula: Contact__r.MailingStreet
Description: Billing address line 1 from Contact
```

**Field 6: QBO Billing City**
```
Label: QBO Billing City
API Name: QBO_Bill_Addr_City__c
Data Type: Formula (Text)
Formula: Contact__r.MailingCity
Description: Billing city from Contact
```

**Field 7: QBO Billing State**
```
Label: QBO Billing State
API Name: QBO_Bill_Addr_State__c
Data Type: Formula (Text)
Formula: Contact__r.MailingState
Description: Billing state/province from Contact
```

**Field 8: QBO Billing Postal Code**
```
Label: QBO Billing Postal Code
API Name: QBO_Bill_Addr_PostalCode__c
Data Type: Formula (Text)
Formula: Contact__r.MailingPostalCode
Description: Billing postal code from Contact
```

**Field 9: QBO Billing Country**
```
Label: QBO Billing Country
API Name: QBO_Bill_Addr_Country__c
Data Type: Formula (Text)
Formula: Contact__r.MailingCountry
Description: Billing country from Contact
```

**Field 10: QBO Class**
```
Label: QBO Class
API Name: QBO_Class__c
Data Type: Text
Length: 255
Description: QuickBooks class for tracking (optional)
Help Text: Enter a QuickBooks class name for expense/revenue tracking
```

**Field 11: QBO Department**
```
Label: QBO Department
API Name: QBO_Department__c
Data Type: Text
Length: 255
Description: QuickBooks department for tracking (optional)
Help Text: Enter a QuickBooks department name
```

**Field 12: Manual Sync Required**
```
Label: Manual Sync Required
API Name: Manual_Sync_Required__c
Data Type: Checkbox
Default: Unchecked
Description: Flag indicating this transaction requires manual review before QBO sync
```

**Field 13: Sync Attempted Date**
```
Label: Sync Attempted Date
API Name: Sync_Attempted_Date__c
Data Type: DateTime
Description: Last date/time a sync to QBO was attempted
```

**Field 14: Sync Attempt Count**
```
Label: Sync Attempt Count
API Name: Sync_Attempt_Count__c
Data Type: Number (3, 0)
Default: 0
Description: Number of times sync to QBO has been attempted
```

#### 1.2 Create Dependent Picklists (Optional but Recommended)

**QBO Document Type Picklist**
```
Label: QBO Document Type Override
API Name: QBO_Doc_Type_Override__c
Data Type: Picklist
Values:
  - sales-receipt (Default)
  - journal-entry
  - bank-deposit
Description: Override the automatic document type selection
Help Text: Leave blank to use automatic selection. Override only if needed.
```

---

## Page Layout Configuration

### Step 2: Configure Transaction Page Layout

Navigate to: **Setup → Object Manager → Transaction__c → Page Layouts**

#### 2.1 Create/Edit Standard Layout

1. Edit the "Transaction Layout" (or create a new one)
2. Organize fields into the following sections:

**Section: Transaction Details** (Existing)
- Transaction Name
- Transaction Type
- Status
- Date Received
- Amount Net
- Amount Gross
- Amount Fee
- Payment Method
- Payment Brand
- Payment Last 4

**Section: Customer Information**
- Contact (Lookup)
- Campaign (Lookup)
- QBO Customer Name (Formula - Read Only)
- QBO Customer Email (Formula - Read Only)

**Section: QuickBooks Sync Configuration** (NEW)
Layout: 2 columns

*Left Column:*
- Posted to QBO (Checkbox)
- QBO Doc Type (Read Only)
- QBO Doc ID (Read Only)
- QBO Posted At (Read Only)
- QBO Target Account
- QBO Item Name
- QBO Class
- QBO Document Type Override

*Right Column:*
- Manual Sync Required
- Sync Attempted Date (Read Only)
- Sync Attempt Count (Read Only)
- Posting Error (Read Only - Expanded to full width)

**Section: Billing Address** (NEW - Optional)
Layout: 1 column
- QBO Billing Address Line 1 (Formula - Read Only)
- QBO Billing City (Formula - Read Only)
- QBO Billing State (Formula - Read Only)
- QBO Billing Postal Code (Formula - Read Only)
- QBO Billing Country (Formula - Read Only)

**Section: Stripe Details** (Existing)
- Stripe Charge ID
- Stripe Customer ID
- Stripe Balance Transaction ID
- Stripe Payout ID
- Stripe Checkout Session ID
- Stripe Invoice ID
- Stripe Subscription ID
- Stripe Refund ID
- Stripe Dispute ID

**Section: Additional Information**
- Memo
- Attribution
- Designation
- Fund
- Restriction
- Frequency
- Currency ISO Code
- Fiscal Month Year
- Month

#### 2.2 Field-Level Security

Ensure the following field-level security settings:

| Field | Read | Edit |
|-------|------|------|
| QBO_Target_Account__c | All Users | Finance, Admin |
| QBO_Item_Name__c | All Users | Finance, Admin |
| QBO_Class__c | All Users | Finance, Admin |
| QBO_Department__c | All Users | Finance, Admin |
| Manual_Sync_Required__c | All Users | Finance, Admin |
| QBO_Doc_Type_Override__c | All Users | Finance, Admin |
| Posted_to_QBO__c | All Users | System Only (via Apex) |
| QBO_Doc_Id__c | All Users | System Only (via Apex) |
| QBO_Doc_Type__c | All Users | System Only (via Apex) |
| QBO_Posted_At__c | All Users | System Only (via Apex) |
| Posting_Error__c | All Users | System Only (via Apex) |
| Sync_Attempted_Date__c | All Users | System Only (via Apex) |
| Sync_Attempt_Count__c | All Users | System Only (via Apex) |

---

## Quick Action Creation

### Step 3: Create Quick Actions for QBO Sync

Navigate to: **Setup → Object Manager → Transaction__c → Buttons, Links, and Actions**

#### 3.1 Quick Action: Sync to QuickBooks

**Action Type:** Lightning Component Action (or Custom Button)

1. Click **New Action**
2. Configure:
   ```
   Action Type: Update a Record
   Label: Sync to QuickBooks
   Name: Sync_to_QuickBooks
   Description: Manually sync this transaction to QuickBooks Online
   ```

3. Select Fields to Display:
   - Posted_to_QBO__c (Read Only)
   - QBO_Doc_Type__c (Read Only)
   - QBO_Doc_ID__c (Read Only)
   - Posting_Error__c (Read Only)

4. Add Pre-defined Field Values:
   - Manual_Sync_Required__c = `FALSE`

5. Save the Action

6. Add to Page Layout:
   - Go to **Transaction Layout → Mobile & Lightning Actions**
   - Drag "Sync to QuickBooks" to the layout

#### 3.2 Quick Action: Mark for Manual Review

1. Click **New Action**
2. Configure:
   ```
   Action Type: Update a Record
   Label: Mark for Manual Review
   Name: Mark_for_Manual_Review
   Description: Flag this transaction for manual review before QBO sync
   ```

3. Add Pre-defined Field Values:
   - Manual_Sync_Required__c = `TRUE`

4. Save and add to Page Layout

#### 3.3 Quick Action: Clear QBO Sync Status

1. Click **New Action**
2. Configure:
   ```
   Action Type: Update a Record
   Label: Clear QBO Sync Status
   Name: Clear_QBO_Sync_Status
   Description: Reset QBO sync status to allow re-sync
   ```

3. Add Pre-defined Field Values:
   - Posted_to_QBO__c = `FALSE`
   - QBO_Doc_Id__c = `(blank)`
   - QBO_Doc_Type__c = `(blank)`
   - QBO_Posted_At__c = `(blank)`
   - Posting_Error__c = `(blank)`

4. Save and add to Page Layout

---

## List View Configuration

### Step 4: Create List Views

Navigate to: **Transaction Object → List Views**

#### 4.1 List View: Pending QBO Sync

**Purpose:** Show transactions that need to be synced to QuickBooks

```
View Name: Pending QBO Sync
API Name: Pending_QBO_Sync
Who sees this list view: All users

Filters:
  Posted to QBO equals FALSE
  AND
  Status equals paid
  AND
  Manual Sync Required equals FALSE

Columns:
  1. Transaction Name (Link)
  2. Contact
  3. Date Received
  4. Amount Net
  5. Payment Method
  6. QBO Target Account
  7. QBO Item Name
  8. Sync Attempt Count
  9. Last Modified Date

Sort By: Date Received (Ascending)
```

#### 4.2 List View: Failed QBO Sync

**Purpose:** Show transactions that failed to sync to QuickBooks

```
View Name: Failed QBO Sync
API Name: Failed_QBO_Sync
Who sees this list view: All users

Filters:
  Posted to QBO equals FALSE
  AND
  Posting Error not equal to (blank)

Columns:
  1. Transaction Name (Link)
  2. Contact
  3. Date Received
  4. Amount Net
  5. Posting Error
  6. Sync Attempted Date
  7. Sync Attempt Count

Sort By: Sync Attempted Date (Descending)

Chart: 
  Type: Donut Chart
  Aggregate: Record Count
  Group By: Status
```

#### 4.3 List View: Manual Review Required

**Purpose:** Show transactions flagged for manual review

```
View Name: Manual Review Required
API Name: Manual_Review_Required
Who sees this list view: Finance Team, Admins

Filters:
  Manual Sync Required equals TRUE
  AND
  Posted to QBO equals FALSE

Columns:
  1. Transaction Name (Link)
  2. Contact
  3. Date Received
  4. Amount Net
  5. Payment Method
  6. Memo
  7. Last Modified Date

Sort By: Date Received (Ascending)
```

#### 4.4 List View: Successfully Synced to QBO

**Purpose:** Show transactions successfully posted to QuickBooks

```
View Name: Successfully Synced to QBO
API Name: Successfully_Synced_to_QBO
Who sees this list view: All users

Filters:
  Posted to QBO equals TRUE

Columns:
  1. Transaction Name (Link)
  2. Contact
  3. Date Received
  4. Amount Net
  5. QBO Doc Type
  6. QBO Doc ID
  7. QBO Posted At
  8. Last Modified Date

Sort By: QBO Posted At (Descending)
```

#### 4.5 List View: Recent Transactions

**Purpose:** Show all recent transactions with QBO sync status

```
View Name: Recent Transactions
API Name: Recent_Transactions
Who sees this list view: All users

Filters:
  Created Date equals LAST_N_DAYS:30

Columns:
  1. Transaction Name (Link)
  2. Contact
  3. Date Received
  4. Amount Net
  5. Status
  6. Posted to QBO
  7. QBO Doc Type
  8. Payment Method
  9. Created Date

Sort By: Created Date (Descending)
```

---

## Report Configuration

### Step 5: Create Reports

Navigate to: **App Launcher → Reports → New Report**

#### 5.1 Report: QBO Sync Status Dashboard

**Report Type:** Transactions

1. **Report Details:**
   ```
   Report Name: QBO Sync Status Dashboard
   Report Unique Name: QBO_Sync_Status_Dashboard
   Folder: Finance Reports
   ```

2. **Filters:**
   ```
   Show: All transactions
   Date Field: Date Received
   Range: Current FY
   ```

3. **Columns:**
   - Transaction Name
   - Contact Name
   - Date Received
   - Amount Net
   - Status
   - Posted to QBO
   - QBO Doc Type
   - QBO Posted At
   - Posting Error
   - Sync Attempt Count

4. **Grouping:**
   - Group Rows by: Posted to QBO
   - Summarize: Record Count
   - Also show: Sum of Amount Net

5. **Chart:**
   ```
   Chart Type: Horizontal Bar Chart
   X-Axis: Sum of Amount Net
   Y-Axis: Posted to QBO
   ```

#### 5.2 Report: Daily QBO Sync Summary

**Report Type:** Transactions

1. **Report Details:**
   ```
   Report Name: Daily QBO Sync Summary
   Report Unique Name: Daily_QBO_Sync_Summary
   Folder: Finance Reports
   ```

2. **Filters:**
   ```
   Show: All transactions
   Date Field: QBO Posted At
   Range: Last 30 Days
   Posted to QBO equals TRUE
   ```

3. **Columns:**
   - Transaction Name
   - Date Received
   - Amount Net
   - QBO Doc Type
   - QBO Posted At
   - Payment Method

4. **Grouping:**
   - Group Rows by: QBO Posted At (by Day)
   - Summarize: 
     - Record Count
     - Sum of Amount Net
     - Sum of Amount Fee

5. **Chart:**
   ```
   Chart Type: Stacked Column Chart
   X-Axis: QBO Posted At (Day)
   Y-Axis: Sum of Amount Net
   Group By: QBO Doc Type
   ```

#### 5.3 Report: QBO Sync Errors

**Report Type:** Transactions

1. **Report Details:**
   ```
   Report Name: QBO Sync Errors
   Report Unique Name: QBO_Sync_Errors
   Folder: Finance Reports
   ```

2. **Filters:**
   ```
   Show: All transactions
   Posting Error not equal to (blank)
   Date Field: Sync Attempted Date
   Range: All Time
   ```

3. **Columns:**
   - Transaction Name
   - Contact Name
   - Date Received
   - Amount Net
   - Posting Error (Full Width)
   - Sync Attempted Date
   - Sync Attempt Count

4. **Grouping:**
   - Group Rows by: Posting Error
   - Summarize: Record Count

5. **Conditional Formatting:**
   ```
   Rule 1:
     If Sync Attempt Count > 3
     Then Background Color = Red
   
   Rule 2:
     If Sync Attempt Count > 1
     Then Background Color = Yellow
   ```

#### 5.4 Report: Monthly Revenue by QBO Doc Type

**Report Type:** Transactions

1. **Report Details:**
   ```
   Report Name: Monthly Revenue by QBO Doc Type
   Report Unique Name: Monthly_Revenue_by_QBO_Doc_Type
   Folder: Finance Reports
   ```

2. **Filters:**
   ```
   Show: All transactions
   Posted to QBO equals TRUE
   Date Field: Date Received
   Range: Current FY
   ```

3. **Columns:**
   - Transaction Name
   - Date Received
   - Amount Net
   - QBO Doc Type
   - QBO Item Name
   - QBO Class

4. **Grouping:**
   - Group Rows by: 
     - Date Received (by Month)
     - Then by QBO Doc Type
   - Summarize: 
     - Record Count
     - Sum of Amount Net
     - Sum of Amount Fee
     - Sum of Amount Gross

5. **Chart:**
   ```
   Chart Type: Line Chart
   X-Axis: Date Received (Month)
   Y-Axis: Sum of Amount Net
   Group By: QBO Doc Type
   ```

---

## Apex Integration Code

### Step 6: Create Apex Classes

#### 6.1 Named Credential Setup

First, create a Named Credential for the Azure Function:

Navigate to: **Setup → Named Credentials → New**

```
Label: QBO Manual Sync API
Name: QBO_Manual_Sync_API
URL: https://your-function-app.azurewebsites.net
Identity Type: Named Principal
Authentication Protocol: Custom
Authentication: Use custom headers

Custom Headers:
  x-functions-key: your-function-key-here
```

#### 6.2 Apex Class: QBOManualSyncService

Create the main service class:

```apex
/**
 * @description Service class for syncing Salesforce Transactions to QuickBooks Online
 * @author Your Name
 * @date 2025-10-31
 */
public with sharing class QBOManualSyncService {
    
    // Named Credential for API endpoint
    private static final String NAMED_CREDENTIAL = 'callout:QBO_Manual_Sync_API';
    private static final String ENDPOINT_PATH = '/qbo/manual-sync';
    
    /**
     * @description Sync a single transaction to QuickBooks (called from triggers or UI)
     * @param transactionId Salesforce Transaction ID
     * @return Result of the sync operation
     */
    public static SyncResult syncTransaction(Id transactionId) {
        return syncTransaction(transactionId, true);
    }
    
    /**
     * @description Sync a single transaction to QuickBooks with contact matching option
     * @param transactionId Salesforce Transaction ID
     * @param performContactMatching Whether to perform contact matching/creation
     * @return Result of the sync operation
     */
    public static SyncResult syncTransaction(Id transactionId, Boolean performContactMatching) {
    /**
     * @description Sync a single transaction to QuickBooks with contact matching option
     * @param transactionId Salesforce Transaction ID
     * @param performContactMatching Whether to perform contact matching/creation
     * @return Result of the sync operation
     */
    public static SyncResult syncTransaction(Id transactionId, Boolean performContactMatching) {
        SyncResult result = new SyncResult();
        result.transactionId = transactionId;
        result.success = false;
        
        try {
            // Query transaction with all required fields
            Transaction__c txn = queryTransaction(transactionId);
            
            if (txn == null) {
                result.errorMessage = 'Transaction not found';
                return result;
            }
            
            // Perform contact matching/creation if requested and no contact is linked
            if (performContactMatching && txn.Contact__c == null) {
                Id matchedContactId = findOrCreateContact(txn);
                if (matchedContactId != null) {
                    // Update transaction with matched/created contact
                    Transaction__c updateTxn = new Transaction__c(
                        Id = transactionId,
                        Contact__c = matchedContactId
                    );
                    update updateTxn;
                    
                    // Re-query transaction with updated contact data
                    txn = queryTransaction(transactionId);
                    result.contactCreated = true;
                    result.contactId = matchedContactId;
                }
            }
            
            if (txn == null) {
                result.errorMessage = 'Transaction not found';
                return result;
            }
            
            // Validate transaction can be synced
            String validationError = validateTransaction(txn);
            if (String.isNotBlank(validationError)) {
                result.errorMessage = validationError;
                updateTransactionError(transactionId, validationError);
                return result;
            }
            
            // Build the request payload
            Map<String, Object> payload = buildPayload(txn);
            
            // Make HTTP callout
            HttpRequest req = new HttpRequest();
            req.setEndpoint(NAMED_CREDENTIAL + ENDPOINT_PATH);
            req.setMethod('POST');
            req.setHeader('Content-Type', 'application/json');
            req.setBody(JSON.serialize(payload));
            req.setTimeout(120000); // 120 second timeout
            
            Http http = new Http();
            HttpResponse res = http.send(req);
            
            // Process response
            if (res.getStatusCode() == 200) {
                Map<String, Object> responseBody = (Map<String, Object>) JSON.deserializeUntyped(res.getBody());
                
                if ((Boolean) responseBody.get('success')) {
                    result.success = true;
                    result.qboDocId = (String) responseBody.get('id');
                    result.qboDocType = (String) responseBody.get('type');
                    
                    // Update transaction record
                    updateTransactionSuccess(transactionId, result.qboDocId, result.qboDocType);
                } else {
                    result.errorMessage = (String) responseBody.get('error');
                    updateTransactionError(transactionId, result.errorMessage);
                }
            } else {
                result.errorMessage = 'HTTP ' + res.getStatusCode() + ': ' + res.getStatus();
                updateTransactionError(transactionId, result.errorMessage);
            }
            
        } catch (Exception e) {
            result.errorMessage = e.getMessage();
            updateTransactionError(transactionId, e.getMessage());
        }
        
        return result;
    }
    
    /**
     * @description Find existing contact by email or create new contact from transaction data
     * @param txn Transaction record with customer information
     * @return Contact ID (existing or newly created)
     */
    private static Id findOrCreateContact(Transaction__c txn) {
        // Extract contact information from transaction
        String email = null;
        String firstName = null;
        String lastName = 'Unknown';
        
        // Try to get email from QBO Customer Email formula or other sources
        if (String.isNotBlank(txn.QBO_Customer_Email__c)) {
            email = txn.QBO_Customer_Email__c;
        }
        
        // Try to parse name from QBO Customer Name
        if (String.isNotBlank(txn.QBO_Customer_Name__c) && txn.QBO_Customer_Name__c != 'Anonymous Donor') {
            List<String> nameParts = txn.QBO_Customer_Name__c.split(' ', 2);
            if (nameParts.size() > 0) {
                firstName = nameParts[0];
            }
            if (nameParts.size() > 1) {
                lastName = nameParts[1];
            } else if (nameParts.size() == 1) {
                lastName = nameParts[0];
                firstName = null;
            }
        }
        
        // If no valid contact information, return null
        if (String.isBlank(email) && String.isBlank(firstName) && lastName == 'Unknown') {
            return null;
        }
        
        // Try to find existing contact by email first (most reliable)
        if (String.isNotBlank(email)) {
            List<Contact> existingContacts = [
                SELECT Id, Email, FirstName, LastName
                FROM Contact
                WHERE Email = :email
                LIMIT 1
            ];
            
            if (!existingContacts.isEmpty()) {
                return existingContacts[0].Id;
            }
        }
        
        // Try to find by name if email search failed
        if (String.isNotBlank(firstName) || lastName != 'Unknown') {
            String nameQuery = 'SELECT Id FROM Contact WHERE ';
            List<String> conditions = new List<String>();
            
            if (String.isNotBlank(firstName)) {
                conditions.add('FirstName = :firstName');
            }
            if (lastName != 'Unknown') {
                conditions.add('LastName = :lastName');
            }
            
            nameQuery += String.join(conditions, ' AND ') + ' LIMIT 1';
            
            List<Contact> nameMatches = Database.query(nameQuery);
            if (!nameMatches.isEmpty()) {
                return nameMatches[0].Id;
            }
        }
        
        // No existing contact found - create new one
        Contact newContact = new Contact();
        newContact.FirstName = firstName;
        newContact.LastName = lastName;
        newContact.Email = email;
        
        // Add address information if available from transaction formulas
        if (String.isNotBlank(txn.QBO_Bill_Addr_Line1__c)) {
            newContact.MailingStreet = txn.QBO_Bill_Addr_Line1__c;
        }
        if (String.isNotBlank(txn.QBO_Bill_Addr_City__c)) {
            newContact.MailingCity = txn.QBO_Bill_Addr_City__c;
        }
        if (String.isNotBlank(txn.QBO_Bill_Addr_State__c)) {
            newContact.MailingState = txn.QBO_Bill_Addr_State__c;
        }
        if (String.isNotBlank(txn.QBO_Bill_Addr_PostalCode__c)) {
            newContact.MailingPostalCode = txn.QBO_Bill_Addr_PostalCode__c;
        }
        if (String.isNotBlank(txn.QBO_Bill_Addr_Country__c)) {
            newContact.MailingCountry = txn.QBO_Bill_Addr_Country__c;
        }
        
        // Add description noting this was auto-created
        newContact.Description = 'Auto-created from Transaction: ' + txn.Name + ' on ' + System.now().format();
        
        try {
            insert newContact;
            return newContact.Id;
        } catch (DmlException e) {
            // If creation fails, log and return null
            System.debug('Failed to create contact: ' + e.getMessage());
            return null;
        }
    }
    
    /**
     * @description Sync multiple transactions in batch
     * @param transactionIds List of Transaction IDs
     * @return List of sync results
     */
    public static List<SyncResult> syncTransactions(List<Id> transactionIds) {
        return syncTransactions(transactionIds, true);
    }
    
    /**
     * @description Sync multiple transactions in batch with contact matching option
     * @param transactionIds List of Transaction IDs
     * @param performContactMatching Whether to perform contact matching/creation
     * @return List of sync results
     */
    public static List<SyncResult> syncTransactions(List<Id> transactionIds, Boolean performContactMatching) {
        List<SyncResult> results = new List<SyncResult>();
        
        for (Id txnId : transactionIds) {
            results.add(syncTransaction(txnId, performContactMatching));
        }
        
        return results;
    }
    
    /**
     * @description Query transaction with all required fields
     */
    private static Transaction__c queryTransaction(Id transactionId) {
        List<Transaction__c> transactions = [
            SELECT Id, Name, Amount_Net__c, Amount_Gross__c, Amount_Fee__c,
                   Received_At__c, Payment_Method__c, Memo__c,
                   QBO_Target_Account__c, QBO_Item_Name__c, QBO_Class__c, QBO_Department__c,
                   QBO_Customer_Name__c, QBO_Customer_Email__c,
                   QBO_Bill_Addr_Line1__c, QBO_Bill_Addr_City__c, 
                   QBO_Bill_Addr_State__c, QBO_Bill_Addr_PostalCode__c, QBO_Bill_Addr_Country__c,
                   QBO_Doc_Type_Override__c, Payment_Brand__c, Payment_Last4__c,
                   Stripe_Charge_Id__c, Posted_to_QBO__c, Sync_Attempt_Count__c,
                   Contact__r.Email, Contact__r.Name
            FROM Transaction__c
            WHERE Id = :transactionId
            LIMIT 1
        ];
        
        return transactions.isEmpty() ? null : transactions[0];
    }
    
    /**
     * @description Validate transaction before syncing
     */
    private static String validateTransaction(Transaction__c txn) {
        if (txn.Posted_to_QBO__c) {
            return 'Transaction already posted to QuickBooks';
        }
        
        if (txn.Amount_Net__c == null || txn.Amount_Net__c <= 0) {
            return 'Transaction amount must be greater than zero';
        }
        
        if (String.isBlank(txn.QBO_Target_Account__c)) {
            return 'QBO Target Account is required';
        }
        
        if (String.isBlank(txn.QBO_Item_Name__c)) {
            return 'QBO Item Name is required';
        }
        
        return null;
    }
    
    /**
     * @description Build the payload for the manual sync API
     */
    private static Map<String, Object> buildPayload(Transaction__c txn) {
        // Determine document type (default to sales-receipt)
        String docType = String.isNotBlank(txn.QBO_Doc_Type_Override__c) 
            ? txn.QBO_Doc_Type_Override__c 
            : 'sales-receipt';
        
        Map<String, Object> payload = new Map<String, Object>();
        payload.put('type', docType);
        
        // Build data object based on document type
        if (docType == 'sales-receipt') {
            payload.put('data', buildSalesReceiptData(txn));
        } else if (docType == 'journal-entry') {
            payload.put('data', buildJournalEntryData(txn));
        } else if (docType == 'bank-deposit') {
            payload.put('data', buildBankDepositData(txn));
        }
        
        return payload;
    }
    
    /**
     * @description Build sales receipt data
     */
    private static Map<String, Object> buildSalesReceiptData(Transaction__c txn) {
        Map<String, Object> data = new Map<String, Object>();
        
        // Transaction date
        if (txn.Received_At__c != null) {
            data.put('TxnDate', txn.Received_At__c.format('yyyy-MM-dd'));
        }
        
        // Private note
        if (String.isNotBlank(txn.Memo__c)) {
            data.put('PrivateNote', txn.Memo__c);
        }
        
        // Deposit account
        data.put('DepositToAccountRef', new Map<String, Object>{
            'name' => txn.QBO_Target_Account__c
        });
        
        // Customer reference
        if (String.isNotBlank(txn.QBO_Customer_Name__c)) {
            data.put('CustomerRef', new Map<String, Object>{
                'name' => txn.QBO_Customer_Name__c
            });
        }
        
        // Customer email
        if (String.isNotBlank(txn.QBO_Customer_Email__c)) {
            data.put('BillEmail', new Map<String, Object>{
                'Address' => txn.QBO_Customer_Email__c
            });
        }
        
        // Billing address
        if (String.isNotBlank(txn.QBO_Bill_Addr_Line1__c)) {
            Map<String, Object> billAddr = new Map<String, Object>();
            if (String.isNotBlank(txn.QBO_Bill_Addr_Line1__c)) {
                billAddr.put('Line1', txn.QBO_Bill_Addr_Line1__c);
            }
            if (String.isNotBlank(txn.QBO_Bill_Addr_City__c)) {
                billAddr.put('City', txn.QBO_Bill_Addr_City__c);
            }
            if (String.isNotBlank(txn.QBO_Bill_Addr_State__c)) {
                billAddr.put('CountrySubDivisionCode', txn.QBO_Bill_Addr_State__c);
            }
            if (String.isNotBlank(txn.QBO_Bill_Addr_PostalCode__c)) {
                billAddr.put('PostalCode', txn.QBO_Bill_Addr_PostalCode__c);
            }
            if (String.isNotBlank(txn.QBO_Bill_Addr_Country__c)) {
                billAddr.put('Country', txn.QBO_Bill_Addr_Country__c);
            }
            
            if (!billAddr.isEmpty()) {
                data.put('BillAddr', billAddr);
            }
        }
        
        // Payment details
        if (String.isNotBlank(txn.Payment_Method__c)) {
            data.put('PaymentMethodRef', new Map<String, Object>{
                'name' => txn.Payment_Method__c.capitalize()
            });
        }
        
        if (String.isNotBlank(txn.Stripe_Charge_Id__c)) {
            data.put('PaymentRefNum', txn.Stripe_Charge_Id__c);
        }
        
        // Line items
        List<Map<String, Object>> lines = new List<Map<String, Object>>();
        
        Map<String, Object> line = new Map<String, Object>();
        line.put('Amount', txn.Amount_Net__c);
        line.put('DetailType', 'SalesItemLineDetail');
        
        String description = txn.Name;
        if (String.isNotBlank(txn.Payment_Brand__c) && String.isNotBlank(txn.Payment_Last4__c)) {
            description += ' - ' + txn.Payment_Brand__c + ' ending in ' + txn.Payment_Last4__c;
        }
        line.put('Description', description);
        
        Map<String, Object> lineDetail = new Map<String, Object>();
        lineDetail.put('ItemRef', new Map<String, Object>{
            'name' => txn.QBO_Item_Name__c
        });
        
        // Add class if specified
        if (String.isNotBlank(txn.QBO_Class__c)) {
            lineDetail.put('ClassRef', new Map<String, Object>{
                'name' => txn.QBO_Class__c
            });
        }
        
        line.put('SalesItemLineDetail', lineDetail);
        lines.add(line);
        
        data.put('Line', lines);
        
        return data;
    }
    
    /**
     * @description Build journal entry data
     */
    private static Map<String, Object> buildJournalEntryData(Transaction__c txn) {
        Map<String, Object> data = new Map<String, Object>();
        
        // Transaction date
        if (txn.Received_At__c != null) {
            data.put('TxnDate', txn.Received_At__c.format('yyyy-MM-dd'));
        }
        
        // Private note
        if (String.isNotBlank(txn.Memo__c)) {
            data.put('PrivateNote', txn.Memo__c);
        }
        
        // Line items (must balance)
        List<Map<String, Object>> lines = new List<Map<String, Object>>();
        
        // Debit line
        Map<String, Object> debitLine = new Map<String, Object>();
        debitLine.put('Amount', txn.Amount_Net__c);
        debitLine.put('DetailType', 'JournalEntryLineDetail');
        debitLine.put('Description', txn.Name);
        
        Map<String, Object> debitDetail = new Map<String, Object>();
        debitDetail.put('PostingType', 'Debit');
        debitDetail.put('AccountRef', new Map<String, Object>{
            'name' => txn.QBO_Target_Account__c
        });
        
        debitLine.put('JournalEntryLineDetail', debitDetail);
        lines.add(debitLine);
        
        // Credit line (placeholder - adjust as needed)
        Map<String, Object> creditLine = new Map<String, Object>();
        creditLine.put('Amount', txn.Amount_Net__c);
        creditLine.put('DetailType', 'JournalEntryLineDetail');
        creditLine.put('Description', txn.Name);
        
        Map<String, Object> creditDetail = new Map<String, Object>();
        creditDetail.put('PostingType', 'Credit');
        creditDetail.put('AccountRef', new Map<String, Object>{
            'name' => 'Undeposited Funds' // Default credit account
        });
        
        creditLine.put('JournalEntryLineDetail', creditDetail);
        lines.add(creditLine);
        
        data.put('Line', lines);
        
        return data;
    }
    
    /**
     * @description Build bank deposit data
     */
    private static Map<String, Object> buildBankDepositData(Transaction__c txn) {
        Map<String, Object> data = new Map<String, Object>();
        
        // Transaction date
        if (txn.Received_At__c != null) {
            data.put('TxnDate', txn.Received_At__c.format('yyyy-MM-dd'));
        }
        
        // Private note
        if (String.isNotBlank(txn.Memo__c)) {
            data.put('PrivateNote', txn.Memo__c);
        }
        
        // Deposit account
        data.put('DepositToAccountRef', new Map<String, Object>{
            'name' => txn.QBO_Target_Account__c
        });
        
        // Line items
        List<Map<String, Object>> lines = new List<Map<String, Object>>();
        
        Map<String, Object> line = new Map<String, Object>();
        line.put('Amount', txn.Amount_Net__c);
        line.put('DetailType', 'DepositLineDetail');
        line.put('Description', txn.Name);
        
        Map<String, Object> lineDetail = new Map<String, Object>();
        lineDetail.put('AccountRef', new Map<String, Object>{
            'name' => 'Undeposited Funds'
        });
        
        line.put('DepositLineDetail', lineDetail);
        lines.add(line);
        
        data.put('Line', lines);
        
        return data;
    }
    
    /**
     * @description Update transaction record on successful sync
     */
    @future
    private static void updateTransactionSuccess(Id transactionId, String qboDocId, String qboDocType) {
        Transaction__c txn = new Transaction__c(
            Id = transactionId,
            Posted_to_QBO__c = true,
            QBO_Doc_Id__c = qboDocId,
            QBO_Doc_Type__c = qboDocType,
            QBO_Posted_At__c = System.now(),
            Posting_Error__c = null,
            Sync_Attempted_Date__c = System.now()
        );
        
        update txn;
    }
    
    /**
     * @description Update transaction record on sync error
     */
    @future
    private static void updateTransactionError(Id transactionId, String errorMessage) {
        Transaction__c existingTxn = [
            SELECT Sync_Attempt_Count__c 
            FROM Transaction__c 
            WHERE Id = :transactionId 
            LIMIT 1
        ];
        
        Decimal attemptCount = existingTxn.Sync_Attempt_Count__c != null 
            ? existingTxn.Sync_Attempt_Count__c + 1 
            : 1;
        
        Transaction__c txn = new Transaction__c(
            Id = transactionId,
            Posting_Error__c = errorMessage,
            Sync_Attempted_Date__c = System.now(),
            Sync_Attempt_Count__c = attemptCount
        );
        
        update txn;
    }
    
    /**
     * @description Inner class for sync results
     */
    public class SyncResult {
        @AuraEnabled public Id transactionId;
        @AuraEnabled public Boolean success;
        @AuraEnabled public String qboDocId;
        @AuraEnabled public String qboDocType;
        @AuraEnabled public String errorMessage;
        @AuraEnabled public Boolean contactCreated;
        @AuraEnabled public Id contactId;
    }
}
```

#### 6.3 Apex Trigger: TransactionTrigger

Create an after-insert trigger to automatically sync transactions to QuickBooks:

**Navigate to:** Setup → Apex Triggers → New

```apex
/**
 * @description Trigger on Transaction__c for automatic QBO sync
 * @author Your Name
 * @date 2025-10-31
 */
trigger TransactionTrigger on Transaction__c (after insert, after update) {
    
    if (Trigger.isAfter && Trigger.isInsert) {
        // Handle new transactions
        TransactionTriggerHandler.handleAfterInsert(Trigger.new);
    }
    
    if (Trigger.isAfter && Trigger.isUpdate) {
        // Handle updated transactions
        TransactionTriggerHandler.handleAfterUpdate(Trigger.new, Trigger.oldMap);
    }
}
```

#### 6.4 Apex Class: TransactionTriggerHandler

Create the trigger handler class:

```apex
/**
 * @description Handler class for Transaction trigger logic
 * @author Your Name
 * @date 2025-10-31
 */
public class TransactionTriggerHandler {
    
    // Custom setting to control auto-sync behavior
    private static Boolean AUTO_SYNC_ENABLED = true; // Set via Custom Setting in production
    
    /**
     * @description Handle after insert - automatically sync eligible transactions to QBO
     * @param newTransactions List of newly inserted transactions
     */
    public static void handleAfterInsert(List<Transaction__c> newTransactions) {
        if (!AUTO_SYNC_ENABLED) {
            return;
        }
        
        // Collect transaction IDs eligible for auto-sync
        List<Id> transactionsToSync = new List<Id>();
        
        for (Transaction__c txn : newTransactions) {
            if (isEligibleForAutoSync(txn)) {
                transactionsToSync.add(txn.Id);
            }
        }
        
        // Perform async sync to avoid blocking transaction creation
        if (!transactionsToSync.isEmpty()) {
            System.enqueueJob(new QBOSyncQueueable(transactionsToSync));
        }
    }
    
    /**
     * @description Handle after update - sync transactions that become eligible
     * @param newTransactions List of updated transactions
     * @param oldTransactionMap Map of old transaction versions
     */
    public static void handleAfterUpdate(List<Transaction__c> newTransactions, Map<Id, Transaction__c> oldTransactionMap) {
        if (!AUTO_SYNC_ENABLED) {
            return;
        }
        
        // Collect transaction IDs that became eligible for sync
        List<Id> transactionsToSync = new List<Id>();
        
        for (Transaction__c txn : newTransactions) {
            Transaction__c oldTxn = oldTransactionMap.get(txn.Id);
            
            // Check if status changed to 'paid' and not already posted
            if (txn.Status__c == 'paid' && 
                oldTxn.Status__c != 'paid' && 
                !txn.Posted_to_QBO__c &&
                !txn.Manual_Sync_Required__c) {
                transactionsToSync.add(txn.Id);
            }
        }
        
        // Perform async sync
        if (!transactionsToSync.isEmpty()) {
            System.enqueueJob(new QBOSyncQueueable(transactionsToSync));
        }
    }
    
    /**
     * @description Check if transaction is eligible for automatic sync
     * @param txn Transaction record
     * @return True if eligible for auto-sync
     */
    private static Boolean isEligibleForAutoSync(Transaction__c txn) {
        // Sync criteria:
        // 1. Status is 'paid'
        // 2. Not already posted to QBO
        // 3. Not flagged for manual review
        // 4. Has required QBO fields populated
        
        return txn.Status__c == 'paid' &&
               !txn.Posted_to_QBO__c &&
               !txn.Manual_Sync_Required__c &&
               String.isNotBlank(txn.QBO_Target_Account__c) &&
               String.isNotBlank(txn.QBO_Item_Name__c);
    }
}
```

#### 6.5 Apex Class: QBOSyncQueueable

Create a queueable class for async processing:

```apex
/**
 * @description Queueable class for asynchronous QBO sync
 * @author Your Name
 * @date 2025-10-31
 */
public class QBOSyncQueueable implements Queueable, Database.AllowsCallouts {
    
    private List<Id> transactionIds;
    private Integer batchSize = 10; // Process 10 at a time to avoid limits
    
    public QBOSyncQueueable(List<Id> transactionIds) {
        this.transactionIds = transactionIds;
    }
    
    public void execute(QueueableContext context) {
        // Take first batch of transactions
        Integer endIndex = Math.min(batchSize, transactionIds.size());
        List<Id> currentBatch = new List<Id>();
        
        for (Integer i = 0; i < endIndex; i++) {
            currentBatch.add(transactionIds[i]);
        }
        
        // Sync current batch with contact matching enabled
        List<QBOManualSyncService.SyncResult> results = 
            QBOManualSyncService.syncTransactions(currentBatch, true);
        
        // Log results
        for (QBOManualSyncService.SyncResult result : results) {
            if (result.success) {
                System.debug('Successfully synced transaction ' + result.transactionId + 
                           ' to QBO. Doc ID: ' + result.qboDocId);
                if (result.contactCreated) {
                    System.debug('Created/matched contact: ' + result.contactId);
                }
            } else {
                System.debug('Failed to sync transaction ' + result.transactionId + 
                           ': ' + result.errorMessage);
            }
        }
        
        // If there are more transactions, chain another job
        if (transactionIds.size() > batchSize) {
            List<Id> remainingIds = new List<Id>();
            for (Integer i = batchSize; i < transactionIds.size(); i++) {
                remainingIds.add(transactionIds[i]);
            }
            
            // Chain next batch (governor limit: 50 chained jobs)
            if (!Test.isRunningTest()) {
                System.enqueueJob(new QBOSyncQueueable(remainingIds));
            }
        }
    }
}
```

#### 6.6 Apex Class: QBOManualSyncController (Lightning Component Controller)

#### 6.6 Apex Class: QBOManualSyncController (Lightning Component Controller)

```apex
/**
 * @description Lightning Component controller for QBO Manual Sync
 * @author Your Name
 * @date 2025-10-31
 */
public with sharing class QBOManualSyncController {
    
    /**
     * @description Sync a single transaction from Lightning Component
     * @param transactionId Transaction record ID
     * @return Sync result
     */
    @AuraEnabled
    public static QBOManualSyncService.SyncResult syncSingleTransaction(Id transactionId) {
        return QBOManualSyncService.syncTransaction(transactionId, true);
    }
    
    /**
     * @description Sync multiple transactions from list view
     * @param transactionIds List of transaction IDs
     * @return List of sync results
     */
    @AuraEnabled
    public static List<QBOManualSyncService.SyncResult> syncMultipleTransactions(List<Id> transactionIds) {
        return QBOManualSyncService.syncTransactions(transactionIds, true);
    }
    
    /**
     * @description Get transaction sync status
     * @param transactionId Transaction record ID
     * @return Transaction sync status
     */
    @AuraEnabled(cacheable=true)
    public static TransactionSyncStatus getTransactionStatus(Id transactionId) {
        List<Transaction__c> transactions = [
            SELECT Posted_to_QBO__c, QBO_Doc_Id__c, QBO_Doc_Type__c,
                   QBO_Posted_At__c, Posting_Error__c, Sync_Attempt_Count__c
            FROM Transaction__c
            WHERE Id = :transactionId
            LIMIT 1
        ];
        
        if (transactions.isEmpty()) {
            return null;
        }
        
        Transaction__c txn = transactions[0];
        
        TransactionSyncStatus status = new TransactionSyncStatus();
        status.isPosted = txn.Posted_to_QBO__c;
        status.qboDocId = txn.QBO_Doc_Id__c;
        status.qboDocType = txn.QBO_Doc_Type__c;
        status.postedAt = txn.QBO_Posted_At__c;
        status.errorMessage = txn.Posting_Error__c;
        status.attemptCount = txn.Sync_Attempt_Count__c != null 
            ? Integer.valueOf(txn.Sync_Attempt_Count__c) 
            : 0;
        
        return status;
    }
    
    /**
     * @description Inner class for transaction sync status
     */
    public class TransactionSyncStatus {
        @AuraEnabled public Boolean isPosted;
        @AuraEnabled public String qboDocId;
        @AuraEnabled public String qboDocType;
        @AuraEnabled public DateTime postedAt;
        @AuraEnabled public String errorMessage;
        @AuraEnabled public Integer attemptCount;
    }
}
```

#### 6.7 Test Class: QBOManualSyncServiceTest

```apex
/**
 * @description Test class for QBOManualSyncService
 * @author Your Name
 * @date 2025-10-31
 */
@isTest
private class QBOManualSyncServiceTest {
    
    @testSetup
    static void setup() {
        // Create test contact
        Contact testContact = new Contact(
            FirstName = 'Test',
            LastName = 'Customer',
            Email = 'test@example.com',
            MailingStreet = '123 Main St',
            MailingCity = 'Seattle',
            MailingState = 'WA',
            MailingPostalCode = '98101',
            MailingCountry = 'USA'
        );
        insert testContact;
        
        // Create test transaction WITH contact
        Transaction__c testTxnWithContact = new Transaction__c(
            Name = 'Test Transaction With Contact',
            Amount_Net__c = 100.00,
            Amount_Gross__c = 103.00,
            Amount_Fee__c = 3.00,
            Contact__c = testContact.Id,
            Received_At__c = System.now(),
            Payment_Method__c = 'card',
            Payment_Brand__c = 'visa',
            Payment_Last4__c = '4242',
            QBO_Target_Account__c = 'Checking Account',
            QBO_Item_Name__c = 'General Giving',
            Stripe_Charge_Id__c = 'ch_test123',
            Posted_to_QBO__c = false,
            Status__c = 'paid'
        );
        insert testTxnWithContact;
        
        // Create test transaction WITHOUT contact (for auto-matching test)
        Transaction__c testTxnWithoutContact = new Transaction__c(
            Name = 'Test Transaction Without Contact',
            Amount_Net__c = 50.00,
            Amount_Gross__c = 52.00,
            Amount_Fee__c = 2.00,
            Received_At__c = System.now(),
            Payment_Method__c = 'card',
            QBO_Target_Account__c = 'Checking Account',
            QBO_Item_Name__c = 'General Giving',
            Posted_to_QBO__c = false,
            Status__c = 'paid'
        );
        insert testTxnWithoutContact;
    }
    
    @isTest
    static void testSyncTransactionSuccess() {
        Test.setMock(HttpCalloutMock.class, new QBOSuccessMock());
        
        Transaction__c txn = [SELECT Id FROM Transaction__c WHERE Name = 'Test Transaction With Contact' LIMIT 1];
        
        Test.startTest();
        QBOManualSyncService.SyncResult result = QBOManualSyncService.syncTransaction(txn.Id);
        Test.stopTest();
        
        System.assertEquals(true, result.success, 'Sync should succeed');
        System.assertNotEquals(null, result.qboDocId, 'QBO Doc ID should be set');
        
        // Verify transaction was updated
        Transaction__c updatedTxn = [
            SELECT Posted_to_QBO__c, QBO_Doc_Id__c, QBO_Doc_Type__c, QBO_Posted_At__c
            FROM Transaction__c
            WHERE Id = :txn.Id
        ];
        
        System.assertEquals(true, updatedTxn.Posted_to_QBO__c, 'Posted flag should be true');
        System.assertNotEquals(null, updatedTxn.QBO_Posted_At__c, 'Posted date should be set');
    }
    
    @isTest
    static void testSyncTransactionWithContactMatching() {
        Test.setMock(HttpCalloutMock.class, new QBOSuccessMock());
        
        Transaction__c txn = [SELECT Id, Contact__c FROM Transaction__c WHERE Name = 'Test Transaction Without Contact' LIMIT 1];
        System.assertEquals(null, txn.Contact__c, 'Transaction should not have contact initially');
        
        Test.startTest();
        // Sync with contact matching enabled
        QBOManualSyncService.SyncResult result = QBOManualSyncService.syncTransaction(txn.Id, true);
        Test.stopTest();
        
        System.assertEquals(true, result.success, 'Sync should succeed');
        
        // Verify contact was created/matched
        // Note: Contact matching logic depends on transaction having email or name data
        // In this test, those fields may be blank, so contact might not be created
    }
    
    @isTest
    static void testSyncTransactionError() {
        Test.setMock(HttpCalloutMock.class, new QBOErrorMock());
        
        Transaction__c txn = [SELECT Id FROM Transaction__c LIMIT 1];
        
        Test.startTest();
        QBOManualSyncService.SyncResult result = QBOManualSyncService.syncTransaction(txn.Id);
        Test.stopTest();
        
        System.assertEquals(false, result.success, 'Sync should fail');
        System.assertNotEquals(null, result.errorMessage, 'Error message should be set');
    }
    
    @isTest
    static void testTriggerAutoSync() {
        Test.setMock(HttpCalloutMock.class, new QBOSuccessMock());
        
        Test.startTest();
        // Create new transaction - should trigger auto-sync
        Transaction__c newTxn = new Transaction__c(
            Name = 'Auto Sync Test',
            Amount_Net__c = 75.00,
            Amount_Gross__c = 78.00,
            Amount_Fee__c = 3.00,
            Status__c = 'paid',
            Received_At__c = System.now(),
            Payment_Method__c = 'card',
            QBO_Target_Account__c = 'Checking Account',
            QBO_Item_Name__c = 'Donation',
            Posted_to_QBO__c = false,
            Manual_Sync_Required__c = false
        );
        insert newTxn;
        Test.stopTest();
        
        // Note: In test context, queueable jobs execute synchronously
        // Verify the transaction was queued for sync (you may need to check different fields)
    }
    
    @isTest
    static void testQueueableSync() {
        Test.setMock(HttpCalloutMock.class, new QBOSuccessMock());
        
        List<Transaction__c> txns = [SELECT Id FROM Transaction__c LIMIT 2];
        List<Id> txnIds = new List<Id>();
        for (Transaction__c t : txns) {
            txnIds.add(t.Id);
        }
        
        Test.startTest();
        System.enqueueJob(new QBOSyncQueueable(txnIds));
        Test.stopTest();
        
        // Verify jobs executed successfully
        // In test context, queueable executes synchronously
    }
    
    // Mock class for successful HTTP response
    private class QBOSuccessMock implements HttpCalloutMock {
        public HttpResponse respond(HttpRequest req) {
            HttpResponse res = new HttpResponse();
            res.setStatusCode(200);
            res.setBody('{"success":true,"id":"123","type":"sales-receipt"}');
            return res;
        }
    }
    
    // Mock class for error HTTP response
    private class QBOErrorMock implements HttpCalloutMock {
        public HttpResponse respond(HttpRequest req) {
            HttpResponse res = new HttpResponse();
            res.setStatusCode(500);
            res.setBody('{"success":false,"error":"Test error message"}');
            return res;
        }
    }
}
```

#### 6.8 Custom Setting for Auto-Sync Configuration

Create a Custom Setting to control auto-sync behavior:

**Navigate to:** Setup → Custom Settings → New

```
Label: QBO Sync Settings
Object Name: QBO_Sync_Settings__c
Setting Type: Hierarchy
Visibility: Protected

Fields:
  - Auto_Sync_Enabled__c (Checkbox, Default: true)
  - Auto_Contact_Matching_Enabled__c (Checkbox, Default: true)
  - Max_Sync_Attempts__c (Number, Default: 3)
  - Sync_Batch_Size__c (Number, Default: 10)
```

Update the TransactionTriggerHandler to use this setting:

```apex
// In TransactionTriggerHandler class, replace the static variable:
private static QBO_Sync_Settings__c settings = QBO_Sync_Settings__c.getInstance();
private static Boolean AUTO_SYNC_ENABLED = settings != null ? settings.Auto_Sync_Enabled__c : true;
private static Boolean AUTO_CONTACT_MATCHING = settings != null ? settings.Auto_Contact_Matching_Enabled__c : true;
```

---

## Permission Sets

### Step 7: Create Permission Set

Navigate to: **Setup → Permission Sets → New**

#### 7.1 Permission Set: QBO Sync User

```
Label: QBO Sync User
API Name: QBO_Sync_User
Description: Grants access to sync transactions to QuickBooks Online

Assigned Apps:
  - Sales (or your custom app)

Object Settings - Transaction__c:
  Read: Yes
  Create: No
  Edit: Yes (specific fields only)
  Delete: No
  View All: No
  Modify All: No

Field Permissions:
  QBO_Target_Account__c: Read, Edit
  QBO_Item_Name__c: Read, Edit
  QBO_Class__c: Read, Edit
  QBO_Department__c: Read, Edit
  Manual_Sync_Required__c: Read, Edit
  QBO_Doc_Type_Override__c: Read, Edit
  Posted_to_QBO__c: Read Only
  QBO_Doc_Id__c: Read Only
  QBO_Doc_Type__c: Read Only
  QBO_Posted_At__c: Read Only
  Posting_Error__c: Read Only
  Sync_Attempted_Date__c: Read Only
  Sync_Attempt_Count__c: Read Only

Apex Class Access:
  QBOManualSyncService: Enabled
  QBOManualSyncController: Enabled
```

#### 7.2 Permission Set: QBO Sync Administrator

```
Label: QBO Sync Administrator
API Name: QBO_Sync_Administrator
Description: Full administrative access for QBO sync functionality

Object Settings - Transaction__c:
  Read: Yes
  Create: Yes
  Edit: Yes
  Delete: Yes
  View All: Yes
  Modify All: Yes

All Field Permissions: Read, Edit

Apex Class Access:
  QBOManualSyncService: Enabled
  QBOManualSyncController: Enabled

Additional Permissions:
  - View Setup and Configuration
  - Manage Reports and Dashboards
  - Run Reports
```

---

## Testing Guide

### Step 8: Test the Integration

#### 8.1 Unit Testing Checklist

- [ ] Create test transaction record
- [ ] Set required fields (QBO_Target_Account__c, QBO_Item_Name__c)
- [ ] Click "Sync to QuickBooks" quick action
- [ ] Verify successful sync
- [ ] Check Posted_to_QBO__c checkbox is true
- [ ] Verify QBO_Doc_Id__c is populated
- [ ] Verify QBO_Posted_At__c is set

#### 8.2 Error Handling Testing

- [ ] Create transaction without QBO_Target_Account__c
- [ ] Attempt sync - should fail with validation error
- [ ] Verify Posting_Error__c field is populated
- [ ] Verify Sync_Attempt_Count__c is incremented
- [ ] Clear error and retry

#### 8.3 List View Testing

- [ ] Navigate to "Pending QBO Sync" list view
- [ ] Verify unpublished transactions appear
- [ ] Select multiple transactions
- [ ] Use batch sync action
- [ ] Verify all transactions sync successfully
- [ ] Check "Successfully Synced to QBO" list view

#### 8.4 Report Testing

- [ ] Run "QBO Sync Status Dashboard" report
- [ ] Verify data accuracy
- [ ] Export report to Excel
- [ ] Schedule report for daily delivery

---

## Automation & Scheduled Jobs

### Step 9: Automatic Sync Configuration

#### 9.1 Automatic Sync on Transaction Creation

The system is configured to automatically sync transactions to QuickBooks when they are created or updated. Here's how it works:

**Workflow:**

```
1. Transaction Created/Updated
   ↓
2. TransactionTrigger fires (after insert/update)
   ↓
3. TransactionTriggerHandler checks eligibility:
   - Status = 'paid'
   - Posted_to_QBO__c = false
   - Manual_Sync_Required__c = false
   - QBO_Target_Account__c is populated
   - QBO_Item_Name__c is populated
   ↓
4. If eligible → QBOSyncQueueable job enqueued
   ↓
5. Queueable job executes (async):
   a. Contact Matching/Creation (if Contact__c is null):
      - Search for contact by email
      - Search for contact by name
      - Create new contact if not found
      - Link contact to transaction
   b. Build QBO payload from transaction data
   c. Call Manual QBO Sync API endpoint
   d. Process response
   ↓
6. Update Transaction record:
   SUCCESS:
   - Posted_to_QBO__c = true
   - QBO_Doc_Id__c = response.id
   - QBO_Doc_Type__c = response.type
   - QBO_Posted_At__c = now()
   - Posting_Error__c = null
   
   FAILURE:
   - Posting_Error__c = error message
   - Sync_Attempt_Count__c += 1
   - Sync_Attempted_Date__c = now()
```

#### 9.2 Contact Matching Logic

When a transaction is created without a linked Contact (`Contact__c = null`), the system automatically attempts to find or create a matching contact:

**Contact Matching Process:**

```
1. Extract contact data from transaction:
   - Email: From Contact__r.Email or other sources
   - Name: From transaction or customer fields
   
2. Search for existing contact:
   Step 1: Search by Email (most reliable)
   - Query: SELECT Id FROM Contact WHERE Email = :email
   - If found → Return existing contact ID
   
   Step 2: Search by Name (fallback)
   - Query: SELECT Id FROM Contact WHERE FirstName = :firstName AND LastName = :lastName
   - If found → Return existing contact ID
   
   Step 3: Create new contact if not found
   - FirstName, LastName from parsed name
   - Email from transaction
   - MailingAddress from transaction address formulas
   - Description: "Auto-created from Transaction: [Name] on [Date]"
   - Insert new contact
   
3. Link contact to transaction:
   - Update Transaction__c.Contact__c = matched/created contact ID
   
4. Re-query transaction with updated contact data:
   - This ensures QBO sync has complete customer information
   - Contact formulas now populate correctly
```

**Example Scenarios:**

**Scenario A: Transaction with Email**
```
Transaction Data:
  - QBO_Customer_Email__c: "john.doe@example.com"
  - QBO_Customer_Name__c: "John Doe"
  - Contact__c: null

Result:
  - Search finds existing contact with email "john.doe@example.com"
  - Transaction.Contact__c updated to existing contact ID
  - QBO sync proceeds with complete customer data
```

**Scenario B: Transaction without Existing Contact**
```
Transaction Data:
  - QBO_Customer_Email__c: "newcustomer@example.com"
  - QBO_Customer_Name__c: "Jane Smith"
  - Contact__c: null

Result:
  - No contact found by email
  - No contact found by name
  - New contact created:
      FirstName: "Jane"
      LastName: "Smith"
      Email: "newcustomer@example.com"
  - Transaction.Contact__c updated to new contact ID
  - QBO sync proceeds with new contact data
```

**Scenario C: Transaction Already Has Contact**
```
Transaction Data:
  - Contact__c: 003UQ00000K9DQjYAN (existing contact)

Result:
  - Contact matching skipped
  - QBO sync proceeds with existing contact data
```

#### 9.3 Disable Automatic Sync

To disable automatic sync (for testing or maintenance):

**Option 1: Use Custom Setting**
```
Navigate to: Setup → Custom Settings → QBO Sync Settings → Manage
Click "New" (if no default exists) or "Edit"
Set:
  Auto_Sync_Enabled__c = false
  Auto_Contact_Matching_Enabled__c = false (optional - disable just contact matching)
Save
```

**Option 2: Disable Trigger**
```
Navigate to: Setup → Apex Triggers → TransactionTrigger
Click "Edit"
Comment out trigger logic or set isActive = false
```

#### 9.4 Manual Sync Override

Even with automatic sync enabled, you can still:
- Set `Manual_Sync_Required__c = true` to skip auto-sync for specific transactions
- Use the "Mark for Manual Review" quick action
- Manually sync later using the "Sync to QuickBooks" quick action

#### 9.5 Scheduled Apex for Batch Sync

Create scheduled job to retry failed syncs:

```apex
/**
 * @description Scheduled batch to retry failed QBO syncs
 */
global class QBOSyncScheduledBatch implements Schedulable {
    global void execute(SchedulableContext sc) {
        // Query failed transactions with retry count < max attempts
        QBO_Sync_Settings__c settings = QBO_Sync_Settings__c.getInstance();
        Decimal maxAttempts = settings != null && settings.Max_Sync_Attempts__c != null 
            ? settings.Max_Sync_Attempts__c 
            : 3;
        
        List<Transaction__c> failedTransactions = [
            SELECT Id
            FROM Transaction__c
            WHERE Posted_to_QBO__c = false
            AND Posting_Error__c != null
            AND Sync_Attempt_Count__c < :maxAttempts
            AND Received_At__c = LAST_N_DAYS:30
            AND Manual_Sync_Required__c = false
            ORDER BY Sync_Attempted_Date__c ASC
            LIMIT 50
        ];
        
        List<Id> txnIds = new List<Id>();
        for (Transaction__c txn : failedTransactions) {
            txnIds.add(txn.Id);
        }
        
        if (!txnIds.isEmpty()) {
            // Enqueue queueable job for async processing
            System.enqueueJob(new QBOSyncQueueable(txnIds));
        }
    }
}
```

Schedule to run daily:
```apex
// Run this in Anonymous Apex to schedule the job
QBOSyncScheduledBatch batch = new QBOSyncScheduledBatch();
String cronExp = '0 0 2 * * ?'; // 2 AM daily
System.schedule('QBO Sync Retry Job', cronExp, batch);
```

Or schedule via UI:
```
Navigate to: Setup → Apex Classes → Schedule Apex
Apex Class: QBOSyncScheduledBatch
Job Name: QBO Sync Retry - Daily
Frequency: Daily
Preferred Start Time: 2:00 AM
```

---

## Troubleshooting

### Common Issues

**Issue 1: "Remote site settings required"**
- Solution: Add Azure Function URL to Remote Site Settings
- Navigate to: Setup → Security → Remote Site Settings
- Add: https://your-function-app.azurewebsites.net

**Issue 2: "Unauthorized" error**
- Solution: Verify Named Credential has correct function key
- Check custom header `x-functions-key` is set correctly

**Issue 3: Transactions not syncing automatically**
- Check transaction meets eligibility criteria:
  - Status__c = 'paid'
  - Posted_to_QBO__c = false
  - Manual_Sync_Required__c = false
  - QBO_Target_Account__c is populated
  - QBO_Item_Name__c is populated
- Verify Custom Setting `Auto_Sync_Enabled__c = true`
- Check debug logs for trigger execution
- Verify user has permission to execute trigger

**Issue 4: Contact not being created/matched**
- Verify transaction has customer data:
  - Check QBO_Customer_Email__c formula field
  - Check QBO_Customer_Name__c formula field
  - Ensure Contact__c lookup is null before sync
- Check Custom Setting `Auto_Contact_Matching_Enabled__c = true`
- Review debug logs for contact matching logic
- Verify user has Create permission on Contact object

**Issue 5: Queueable job not executing**
- Check queueable job limits (max 50 enqueued per transaction)
- Review System Jobs: Setup → Environments → Jobs → Apex Jobs
- Look for "QBOSyncQueueable" in job list
- Check job status and error messages

**Issue 6: Field-level security errors**
- Verify user has QBO Sync User permission set assigned
- Check field-level security settings for custom fields
- Ensure user can edit Contact__c lookup field

**Issue 7: Transaction syncs but contact not linked**
- Contact matching only occurs if Contact__c is null
- If contact was previously set, it won't be overridden
- Manually clear Contact__c and trigger re-sync to test

**Issue 8: Duplicate contacts being created**
- Ensure email addresses are properly formatted
- Check for extra spaces or case differences
- Review contact matching logic in code
- Consider adding duplicate rules on Contact object

### Debug Checklist

When a transaction doesn't sync as expected:

1. **Check Transaction Fields**
   ```
   Status__c = ?
   Posted_to_QBO__c = ?
   Manual_Sync_Required__c = ?
   QBO_Target_Account__c = ?
   QBO_Item_Name__c = ?
   ```

2. **Check Custom Settings**
   ```
   Navigate to: Setup → Custom Settings → QBO Sync Settings
   Auto_Sync_Enabled__c = ?
   Auto_Contact_Matching_Enabled__c = ?
   Max_Sync_Attempts__c = ?
   ```

3. **Check Debug Logs**
   ```
   Navigate to: Setup → Debug Logs
   Add trace flag for your user
   Create test transaction
   Review logs for:
   - TransactionTrigger execution
   - TransactionTriggerHandler.isEligibleForAutoSync()
   - QBOSyncQueueable.execute()
   - Contact matching logic
   - HTTP callout request/response
   ```

4. **Check Queueable Jobs**
   ```
   Navigate to: Setup → Apex Jobs
   Look for: QBOSyncQueueable
   Status should be: Completed
   Check for errors in job details
   ```

5. **Check Posting Errors**
   ```
   Query: SELECT Id, Name, Posting_Error__c, Sync_Attempt_Count__c 
          FROM Transaction__c 
          WHERE Posted_to_QBO__c = false 
          AND Posting_Error__c != null
   Review error messages for specific issues
   ```

6. **Verify API Connectivity**
   ```
   Test callout manually from Developer Console:
   
   HttpRequest req = new HttpRequest();
   req.setEndpoint('callout:QBO_Manual_Sync_API/qbo/manual-sync');
   req.setMethod('POST');
   req.setHeader('Content-Type', 'application/json');
   req.setBody('{"type":"sales-receipt","data":{...}}');
   
   Http http = new Http();
   HttpResponse res = http.send(req);
   System.debug(res.getBody());
   ```

### Logging and Monitoring

**Enable Debug Logging:**

1. Navigate to: Setup → Debug Logs
2. Click "New" under User Trace Flags
3. Select your user
4. Set log level:
   - Apex Code: FINEST
   - Callout: FINEST
   - Database: INFO
   - System: INFO
5. Duration: 1 hour (or longer for ongoing monitoring)

**Monitor Sync Activity:**

Create a custom report or dashboard to monitor:
- Total transactions created today
- Successful syncs today
- Failed syncs today
- Average sync time
- Most common error messages

**Set Up Email Alerts:**

Example Process Builder or Flow:
```
Trigger: Transaction__c updated
Criteria: 
  - Sync_Attempt_Count__c > 2
  - Posted_to_QBO__c = false
  
Action: 
  - Send email to Finance Team
  - Subject: "Transaction Sync Failed Multiple Times"
  - Body: Include Transaction Name, Amount, Error Message
```

---

## Maintenance & Best Practices

### Best Practices

1. **Always test in Sandbox first** before deploying to production
2. **Monitor Sync_Attempt_Count__c** - investigate transactions with >3 attempts
3. **Review Posting_Error__c daily** using the "Failed QBO Sync" list view
4. **Set up email alerts** for failed syncs exceeding threshold
5. **Regular reconciliation** between Salesforce and QuickBooks
6. **Keep Named Credential secure** - rotate function keys periodically
7. **Document custom mappings** for your specific QBO setup
8. **Train finance team** on manual review process

### Monitoring

Create email alerts for critical scenarios:

**Alert 1: Excessive Sync Failures**
```
Alert Name: QBO Sync Failures Alert
Object: Transaction
Criteria:
  Sync Attempt Count > 2
  AND Posted to QBO = FALSE
  
Recipients: Finance Team
Frequency: Daily Summary
```

**Alert 2: Large Transaction Sync Failed**
```
Alert Name: Large Transaction Sync Failed
Object: Transaction
Criteria:
  Amount Net > 1000
  AND Posting Error != blank
  AND Posted to QBO = FALSE
  
Recipients: Finance Manager
Frequency: Immediate
```

---

## Summary

This comprehensive setup enables:

✅ **Automatic sync on transaction creation** - Transactions automatically sync to QuickBooks when created with status='paid'  
✅ **Intelligent contact matching** - Automatically finds or creates Salesforce contacts based on customer data  
✅ **Contact association** - Links transactions to contacts even when not initially specified  
✅ **Automatic reference resolution** - Accounts, customers, and items resolved by name in QuickBooks  
✅ **Full customer address mapping** - Contact addresses automatically pulled into QuickBooks  
✅ **Flexible document types** - Sales receipts, journal entries, and bank deposits supported  
✅ **Error tracking and retry logic** - Failed syncs tracked with automatic retry attempts  
✅ **Comprehensive reporting** - Dashboards and reports for monitoring sync status  
✅ **User-friendly quick actions** - Manual sync and review actions available from record page  
✅ **Batch processing** - Sync multiple transactions at once  
✅ **Async processing** - Queueable jobs prevent blocking transaction creation  
✅ **Configurable settings** - Custom settings control auto-sync behavior  
✅ **Manual override** - Flag transactions for manual review when needed  

### How It Works

**When a Transaction is Created:**

1. **Transaction triggers** → After insert/update trigger fires
2. **Eligibility check** → Validates status, QBO fields, and flags
3. **Contact matching** → If no contact linked:
   - Searches by email
   - Searches by name
   - Creates new contact if needed
   - Links contact to transaction
4. **QBO sync queued** → Async job enqueued
5. **API call executed** → Calls manual QBO sync endpoint
6. **Response processed** → Updates transaction with QBO doc ID and status
7. **Contact updated** → Contact relationship established

**Result:** Transaction is automatically posted to QuickBooks with full customer data, and Salesforce maintains a complete record with proper contact association.

### Key Features

**Automatic Contact Management:**
- Email-based matching (primary)
- Name-based matching (fallback)
- Auto-creation of new contacts
- Address data population
- Automatic contact linking

**Flexible Sync Options:**
- Automatic sync on creation
- Manual sync via quick action
- Batch sync from list views
- Scheduled retry for failures

**Error Handling:**
- Tracks sync attempt count
- Stores detailed error messages
- Automatic retry (up to 3 attempts by default)
- Manual review flagging

**Monitoring & Reporting:**
- Real-time sync status
- Failed sync alerts
- Daily summary reports
- Success/failure dashboards

For questions or issues, consult the Azure Function logs and Salesforce debug logs for detailed error messages.
