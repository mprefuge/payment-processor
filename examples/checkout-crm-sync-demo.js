/**
 * Example: Checkout Session with CRM Sync
 * 
 * This example demonstrates how the checkout session creation now includes
 * automatic contact synchronization with Salesforce.
 */

console.log(`
╔════════════════════════════════════════════════════════════════════════════╗
║                                                                            ║
║         Checkout Session CRM Sync - Example Flow                          ║
║                                                                            ║
╚════════════════════════════════════════════════════════════════════════════╝

This example demonstrates the new checkout session CRM sync feature.

═══════════════════════════════════════════════════════════════════════════

📋 SCENARIO 1: New Customer Creates Checkout Session
───────────────────────────────────────────────────────────────────────────

1. Customer fills out transaction form:
   - Email: new.donor@example.com
   - Name: Jane Smith
   - Phone: +1 555-123-4567
   - Address: 123 Main St, New York, NY 10001
   - Amount: $100
   - Frequency: onetime

2. System creates Stripe customer

3. System creates Stripe checkout session

4. ✨ NEW: System syncs contact to Salesforce ✨
   → Searches for existing contact by email/name/phone
   → No contact found
   → Creates new Salesforce contact with all information:
      * FirstName: Jane
      * LastName: Smith
      * Email: new.donor@example.com
      * Phone: +1 555-123-4567
      * MailingStreet: 123 Main St
      * MailingCity: New York
      * MailingState: NY
      * MailingPostalCode: 10001
      * LeadSource: Online Donation

5. Notification email sent

6. Customer redirected to Stripe checkout page

7. (Later) Customer completes payment → Webhook processes transaction

───────────────────────────────────────────────────────────────────────────

📋 SCENARIO 2: Existing Customer Creates New Checkout Session
───────────────────────────────────────────────────────────────────────────

1. Customer fills out transaction form:
   - Email: existing.donor@example.com (already in Salesforce)
   - Name: John Doe
   - Address: 456 New Ave, Los Angeles, CA 90001 (updated address)
   - Amount: $250
   - Frequency: monthly

2. System finds existing Stripe customer

3. System creates Stripe checkout session

4. ✨ NEW: System syncs contact to Salesforce ✨
   → Searches for existing contact
   → Contact found (ID: 0031234567890001)
   → Updates contact address with new information:
      * MailingStreet: 456 New Ave (updated)
      * MailingCity: Los Angeles (updated)
      * MailingState: CA (updated)
      * MailingPostalCode: 90001 (updated)

5. Notification email sent

6. Customer redirected to Stripe checkout page

7. (Later) Customer completes payment → Webhook processes transaction

───────────────────────────────────────────────────────────────────────────

📋 SCENARIO 3: CRM Error Handling (Salesforce Down)
───────────────────────────────────────────────────────────────────────────

1. Customer fills out transaction form

2. System creates Stripe customer

3. System creates Stripe checkout session

4. System attempts to sync contact to Salesforce
   → ⚠️  Salesforce connection fails
   → Error logged: "Error syncing contact to CRM: Connection timeout"
   → ✅ Checkout process continues normally
   → Customer is not affected

5. Notification email sent

6. Customer redirected to Stripe checkout page

7. Contact can be synced later when webhook processes the payment

───────────────────────────────────────────────────────────────────────────

🔧 CONFIGURATION
───────────────────────────────────────────────────────────────────────────

To enable this feature, configure these environment variables:

CRM_PROVIDER=salesforce
SALESFORCE_USERNAME=your-username@example.com
SALESFORCE_PASSWORD=your-password
SALESFORCE_SECURITY_TOKEN=your-token
SALESFORCE_LOGIN_URL=https://login.salesforce.com

If CRM is not configured, the checkout process works normally without
the CRM sync step.

═══════════════════════════════════════════════════════════════════════════

✅ KEY BENEFITS:

1. Early Contact Capture
   → Contact information is saved in Salesforce immediately
   → Even if customer abandons checkout, you have their information

2. Address Updates
   → Existing contacts get latest address information
   → Keeps your CRM data fresh and accurate

3. Non-Blocking
   → CRM errors don't prevent checkout from completing
   → Payment flow is never interrupted

4. Consistent Data
   → Same validation and matching logic as webhook
   → Follows established patterns from stripeWebhook

═══════════════════════════════════════════════════════════════════════════

📚 RELATED FILES:

- Implementation: processTransaction/index.js
- Tests: tests/checkoutCrmSync.test.js
- Documentation: README.md
- CRM Service: services/crm/salesforceCrm.js

═══════════════════════════════════════════════════════════════════════════
`);
