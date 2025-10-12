# Salesforce Transaction Field Reference

The Stripe webhook handler maps Stripe payment intents, charges, and balance transactions to the custom `Transaction__c` object in Salesforce. The table below lists every field that the integration populates, along with the Salesforce API name that must exist in your org.

| Integration Key | Salesforce API Name | Notes |
| --- | --- | --- |
| `transaction_type__c` | `Transaction_Type__c` | Derived from the Stripe balance transaction reporting category (charge, refund, dispute, payout). |
| `status__c` | `Status__c` | Maps to the Stripe payment intent/charge status. |
| `stripe_payment_intent_id__c` | `Stripe_Payment_Intent_Id__c` | External ID used for charge upserts. |
| `stripe_charge_id__c` | `Stripe_Charge_Id__c` | Stripe charge identifier. |
| `stripe_balance_transaction_id__c` | `Stripe_Balance_Transaction_Id__c` | External ID used when linking payouts. |
| `stripe_refund_id__c` | `Stripe_Refund_Id__c` | Latest refund identifier on the charge. |
| `stripe_dispute_id__c` | `Stripe_Dispute_Id__c` | Populated from Stripe metadata when a dispute is present. |
| `stripe_checkout_session_id__c` | `Stripe_Checkout_Session_Id__c` | Stored when checkout sessions initiate the transaction. |
| `stripe_customer_id__c` | `Stripe_Customer_Id__c` | Stripe customer identifier. |
| `stripe_subscription_id__c` | `Stripe_Subscription_Id__c` | Derived from metadata or invoice references. |
| `stripe_payout_id__c` | `Stripe_Payout_Id__c` | Links charge transactions to Stripe payouts. |
| `parent_transaction__c` | `Parent_Transaction__c` | Reserved for linking related transactions (e.g., refunds to charges). |
| `amount_gross__c` | `Amount_Gross__c` | Gross amount in major units. |
| `amount_fee__c` | `Amount_Fee__c` | Total Stripe fees in major units. |
| `amount_net__c` | `Amount_Net__c` | Net amount in major units. |
| `currency_iso_code__c` | `Currency_ISO_Code__c` | ISO currency code, uppercase. |
| `memo__c` | `Memo__c` | Free-form notes or audit information about the transaction. |
| `contact__c` | `Contact__c` | Salesforce contact lookup (optional). |
| `account__c` | `Account__c` | Salesforce account lookup (optional). |
| `campaign__c` | `Campaign__c` | Salesforce campaign lookup (optional). |
| `fund__c` | `Fund__c` | Custom fund reference from metadata. |
| `designation__c` | `Designation__c` | Custom designation reference from metadata. |
| `restriction__c` | `Restriction__c` | Custom restriction reference from metadata. |
| `frequency__c` | `Frequency__c` | Donation frequency (e.g., `onetime`, `month`). |
| `attribution__c` | `Attribution__c` | Attribution or campaign source string (optional). |
| `cover_fees__c` | `Cover_Fees__c` | Boolean flag when the donor covers fees. |
| `cover_fees_amount__c` | `Cover_Fees_Amount__c` | Amount of fees covered by the donor. |
| `payment_method__c` | `Payment_Method__c` | Stripe payment method type (card, ach, etc.). |
| `payment_brand__c` | `Payment_Brand__c` | Card brand when available. |
| `payment_last4__c` | `Payment_Last4__c` | Card last four digits when available. |
| `received_at__c` | `Received_At__c` | ISO timestamp when Stripe created the charge/payment intent. |
| `posted_to_qbo__c` | `Posted_to_QBO__c` | Boolean flag set after QuickBooks posting succeeds. |
| `qbo_doc_type__c` | `QBO_Doc_Type__c` | QuickBooks document type that recorded the transaction. |
| `qbo_doc_id__c` | `QBO_Doc_Id__c` | QuickBooks document identifier. |
| `qbo_posted_at__c` | `QBO_Posted_At__c` | ISO timestamp of the QuickBooks posting. |
| `posting_error__c` | `Posting_Error__c` | Error message if a QuickBooks sync fails. |

> **Tip:** The webhook service accepts either the exact Salesforce API name or the lower-case version of each key when parsing Stripe metadata. Ensure that the Salesforce fields above exist and are marked as external IDs where appropriate (`Stripe_Payment_Intent_Id__c`, `Stripe_Balance_Transaction_Id__c`, etc.).
