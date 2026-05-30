# Stripe Transaction Page Layout

Use this page layout for the Transaction__c Stripe Transaction record type.

## Header

- Name
- Status__c
- transaction_type__c
- Amount_Gross__c
- Currency_ISO_Code__c
- Received_At__c
- Stripe_Livemode__c

## Stripe Summary

- Stripe_Event_Id__c
- Stripe_Payment_Intent_Id__c
- Stripe_Charge_Id__c
- Stripe_Checkout_Session_Id__c
- Stripe_Customer_Id__c
- Stripe_Subscription_Id__c
- Stripe_Invoice_ID__c
- Stripe_Refund_Id__c
- Stripe_Dispute_Id__c
- Stripe_Credit_Note_Id__c
- Stripe_Payout_Id__c
- Stripe_Balance_Transaction_Id__c

## Donor And Billing

- Contact__c
- Account__c
- Billing_Name__c
- Billing_Email__c
- Billing_Phone__c
- Payment_Method__c
- Payment_Brand__c
- Payment_Last4__c
- Stripe_Receipt_URL__c
- Statement_Descriptor__c

## Transaction Amounts

- Amount_Gross__c
- Amount_Fee__c
- Amount_Net__c
- Cover_Fees__c
- Cover_Fees_Amount__c
- Available_On_Date__c

## Attribution And Classification

- Campaign__c
- Fund__c
- Designation__c
- Restriction__c
- Frequency__c
- Attribution__c
- Source_System__c
- Parent_Transaction__c

## Failure And Retry

- Error_Message__c
- Failure_Code__c
- Decline_Code__c
- Next_Retry_At__c
- Dunning_Required__c

## Dispute Details

- Dispute_Status__c
- Dispute_Reason__c

## Credit Note Details

- Credit_Note_Number__c
- Credit_Note_Reason__c

## QuickBooks Sync

- Posted_to_QBO__c
- QBO_Doc_Type__c
- QBO_Doc_Id__c
- QBO_Doc_Number__c
- QBO_Customer_Id__c
- QBO_Customer_Name__c
- QBO_Class_Id__c
- QBO_Class_Name__c
- QBO_Private_Note__c
- QBO_Source_Created_At__c
- QBO_Source_Updated_At__c
- QBO_Posted_At__c
- Posting_Error__c

## Notes

- Keep Memo__c visible near the bottom of the page in a full-width section.
- Put related lists for Process History, Activity, and Notes on the lower tabs.
- Use Dynamic Forms or compact highlights so finance users can see amount, status, payment method, and Stripe IDs without scrolling.