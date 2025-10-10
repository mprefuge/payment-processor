# Quick Testing Guide: Webhook-Only Payout Processing

This guide provides quick test scenarios to validate your webhook-only payout processing setup.

## Prerequisites Checklist

Before testing, verify:
- [ ] Stripe webhook configured to send `payout.paid` events
- [ ] Accounting provider configured (QuickBooks, Xero, etc.)
- [ ] CRM provider configured (Salesforce, optional)
- [ ] Azure Function deployed and running
- [ ] All environment variables set correctly

## Automated End-to-End Donation Flow Test

The repository now includes a fully automated test that executes the live donation lifecycle end to end _against the real downstream services_. The script drives the compiled Azure Function handlers, creates a real Stripe Checkout session in **test mode**, confirms the payment, delivers signed webhook payloads, and then asserts that Salesforce and QuickBooks have persisted the resulting records. Because no fakes or stubs are used any more, the test requires working credentials for every integration that runs in production.

### Environment parity requirements

To mirror the production configuration, ensure the following dependencies are available before running the test:

- **Node.js 20.x** (matching the runtime declared in `package.json`).
- All project dependencies installed with `npm install`.
- Valid credentials for every upstream system the production app touches:
  - **Stripe (test mode)**: `STRIPE_TEST_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET`. Set `STRIPE_SECRET` to the same value so the compiled config loader passes validation.
  - **Salesforce (sandbox)**: `CRM_PROVIDER=salesforce`, `SALESFORCE_USERNAME`, `SALESFORCE_PASSWORD`, `SALESFORCE_SECURITY_TOKEN`, and optionally `SALESFORCE_LOGIN_URL` if your sandbox uses a custom domain.
  - **QuickBooks Online (sandbox or production)**: `QBO_REALM_ID`, `QBO_ACCESS_TOKEN`, `QBO_ENV` (defaults to `sandbox`), plus the chart-of-accounts environment variables (`QBO_ACCOUNT_STRIPE_CLEARING`, `QBO_ACCOUNT_OPERATING_BANK`, `QBO_ACCOUNT_REVENUE`, `QBO_ACCOUNT_FEES`, `QBO_ACCOUNT_REFUNDS`, `QBO_ACCOUNT_DISPUTES`) when they differ from the defaults embedded in `env.ts`.
  - **Accounting feature flags**: `ACCOUNTING_SYNC_ENABLED=true` and, if you rely on a specific journal posting style, `ACCOUNTING_POSTING_STRATEGY` (defaults to `je-transfer`).

⚠️ **QuickBooks access tokens expire every 60 minutes.** Before running the test, refresh the token with your Intuit OAuth client credentials and set `QBO_ACCESS_TOKEN` to the freshly-issued bearer token. The script calls the live QuickBooks API and will fail if the token is stale.

⚠️ **Salesforce and QuickBooks records are created for real.** Run the test only against non-production orgs or ensure you have cleanup automation in place.

### Running the end-to-end suite

```bash
npm install
npm run build
node tests/endToEndDonationFlow.test.js
```

The command above compiles the TypeScript sources, loads the `processTransaction` and `stripeWebhook` handlers from the production build, and asserts that:

- A Stripe checkout session is created and confirmed against the live Stripe API (test mode) with unique donor metadata.
- Salesforce receives the contact + transaction records via the actual CRM service and stores the QuickBooks linkage fields after webhook processing.
- Signed webhook payloads for `checkout.session.completed` and `payment_intent.succeeded` are accepted by the handler, which then posts a document to QuickBooks and marks the Salesforce transaction as `paid` and `posted_to_qbo__c = true`.
- The QuickBooks Online REST API returns the newly-created document referenced by Salesforce, proving that accounting sync completed successfully.

To run the full regression suite (including the end-to-end scenario) use `npm test`, which executes every script in the `tests/` directory against the compiled `dist/` output.

## Quick Test: Trigger Test Webhook

### Using Stripe CLI (Recommended)

```bash
# Install Stripe CLI if not already installed
# https://stripe.com/docs/stripe-cli

# Login to Stripe
stripe login

# Forward webhooks to your local or deployed endpoint
stripe listen --forward-to https://your-function-app.azurewebsites.net/api/stripe/webhook

# In a new terminal, trigger a test payout.paid event
stripe trigger payout.paid
```

### Using Stripe Dashboard

1. Go to **Developers** → **Webhooks**
2. Click on your webhook endpoint
3. Click **Send test webhook**
4. Select event type: `payout.paid`
5. Click **Send test webhook**

## Verification Steps

### 1. Check Azure Function Logs

```bash
# In Azure Portal: Function App → Monitor → Log Stream

# Look for these log entries:
✓ Stripe webhook received
✓ [PayoutJob] Processing payout: po_xxxxx
✓ [PayoutJob] Pulled payout with N transactions
✓ [PayoutJob] Posted to accounting: {...}
✓ [PayoutJob] Created payout record in CRM: a0X...
✓ [PayoutJob] Payout sync completed successfully
```

### 2. Check Accounting System

**In QuickBooks Online:**

1. Navigate to **Transactions** → **Journal Entries**
2. Look for new entry with description like "Stripe Payout - YYYY-MM-DD"
3. Verify:
   - ✓ Debits and credits balance
   - ✓ Amounts match Stripe payout
   - ✓ Accounts used are correct

4. Navigate to **Transactions** → **Transfer**
5. Look for transfer to Operating Bank
6. Verify amount matches net payout

### 3. Check CRM System

**In Salesforce:**

1. Navigate to **Payouts** tab
2. Look for new payout record
3. Verify:
   - ✓ Payout ID matches Stripe
   - ✓ Amount matches Stripe payout
   - ✓ Charge count, refund count are correct
   - ✓ Accounting document IDs are populated
   - ✓ All dates are correct

### 4. Check Sync Status via API

```bash
# Get payout sync status
curl https://your-function-app.azurewebsites.net/api/sync/stripe/payouts/po_xxxxx?account=default

# Expected response:
{
  "payoutId": "po_xxxxx",
  "stripeAccountId": "default",
  "status": "posted",
  "provider": "quickbooks",
  "providerDocIds": {
    "journalEntry": "123",
    "transfer": "456"
  },
  "crmPayoutId": "a0X...",
  "createdAt": "2024-01-15T10:30:00Z",
  "updatedAt": "2024-01-15T10:30:00Z"
}
```

## Common Test Scenarios

### Scenario 1: Simple Payout

**Stripe Test:**
```bash
stripe trigger payout.paid
```

**Expected Results:**
- ✓ Webhook received and processed
- ✓ Journal entry created in accounting
- ✓ Transfer created in accounting
- ✓ Payout record created in CRM
- ✓ Status = "posted"

### Scenario 2: Idempotency Test

**Test:**
1. Trigger same webhook twice
2. Check that only one set of entries created

**Expected Results:**
- ✓ First webhook: Creates entries
- ✓ Second webhook: Logs "Payout already synced"
- ✓ No duplicate accounting entries
- ✓ No duplicate CRM records

### Scenario 3: Manual Status Check

**Test:**
```bash
# Try to manually trigger sync (should fail)
curl -X POST https://your-function-app.azurewebsites.net/api/sync/stripe/payouts/po_xxxxx

# Expected response:
{
  "error": "Method not allowed",
  "message": "Only GET requests are supported. Payout sync is webhook-only..."
}
```

**Expected Results:**
- ✓ POST request returns 405 Method Not Allowed
- ✓ Error message explains webhook-only approach

### Scenario 4: CRM Not Configured

**Setup:**
- Remove or comment out `CRM_PROVIDER` env variable
- Trigger test webhook

**Expected Results:**
- ✓ Webhook processed successfully
- ✓ Accounting sync completes
- ✓ No CRM record created
- ✓ Logs show: "CRM service not configured, skipping CRM payout creation"

### Scenario 5: Accounting Sync Disabled

**Setup:**
- Set `ACCOUNTING_SYNC_ENABLED=false`
- Trigger test webhook

**Expected Results:**
- ✓ Webhook received
- ✓ Logs show: "Accounting sync disabled - skipping payout processing"
- ✓ No accounting entries created
- ✓ No CRM records created

## Troubleshooting Quick Checks

### Webhook Not Received

```bash
# Check webhook configuration in Stripe
stripe webhooks list

# Test webhook delivery
stripe trigger payout.paid --forward-to https://your-url/api/stripe/webhook
```

### Accounting Sync Fails

```bash
# Check environment variables
az functionapp config appsettings list --name your-function-app --resource-group your-rg | grep ACCOUNTING

# Verify account names
az functionapp config appsettings list --name your-function-app --resource-group your-rg | grep ACCOUNT
```

### CRM Sync Fails

```bash
# Check CRM configuration
az functionapp config appsettings list --name your-function-app --resource-group your-rg | grep -E "(CRM|SALESFORCE)"

# Test Salesforce connection separately
# (Use Salesforce Workbench to verify credentials)
```

### Status Check Returns 404

**Possible causes:**
1. Payout hasn't been synced yet
2. Wrong payout ID
3. Wrong Stripe account ID

**Solution:**
```bash
# Check Azure logs for the payout ID
# Verify webhook was received and processed
# Try without account parameter (uses "default")
curl https://your-url/api/sync/stripe/payouts/po_xxxxx
```

## Integration Test Checklist

After deployment, run through this checklist:

1. **Webhook Delivery**
   - [ ] Stripe CLI test webhook received
   - [ ] Dashboard test webhook received
   - [ ] Webhook signature verified

2. **Accounting Integration**
   - [ ] Journal entry created
   - [ ] Transfer created
   - [ ] Amounts match Stripe
   - [ ] Accounts mapped correctly

3. **CRM Integration**
   - [ ] Payout record created
   - [ ] All fields populated
   - [ ] Accounting IDs linked
   - [ ] Dates correct

4. **Idempotency**
   - [ ] Duplicate webhooks handled
   - [ ] No duplicate entries
   - [ ] Status check works

5. **Error Handling**
   - [ ] Invalid webhook rejected
   - [ ] Configuration errors logged
   - [ ] CRM errors don't block accounting
   - [ ] Failed payouts tracked

6. **Manual Sync Disabled**
   - [ ] POST returns 405
   - [ ] GET still works
   - [ ] Error message is clear

## Performance Benchmarks

Expected processing times:

- **Webhook acknowledgment**: < 2 seconds
- **Full payout processing**: < 30 seconds
- **Small payout (< 50 txns)**: < 10 seconds
- **Large payout (500+ txns)**: < 60 seconds

If processing takes longer:
1. Check Azure Function timeout settings
2. Verify accounting provider API response times
3. Check CRM API response times
4. Review balance transaction count

## Next Steps

Once testing is complete:

1. **Monitor for 24-48 hours**
   - Watch for real payouts
   - Verify automatic processing
   - Check for any errors

2. **Set up alerts**
   - Webhook failures
   - Accounting sync errors
   - CRM sync errors
   - Validation failures

3. **Document any customizations**
   - Account mappings
   - Special handling rules
   - Contact information

4. **Train your team**
   - How to check sync status
   - Where to find payout records
   - When to escalate issues

## Support Resources

- [WEBHOOK_PAYOUT_SETUP.md](./WEBHOOK_PAYOUT_SETUP.md) - Complete setup guide
- [PAYOUT_SYNC_SETUP.md](./PAYOUT_SYNC_SETUP.md) - Technical architecture
- [SALESFORCE_PAYOUT_SETUP.md](./SALESFORCE_PAYOUT_SETUP.md) - Salesforce setup
- [GitHub Issues](https://github.com/mprefuge/payment-processor/issues) - Bug reports

## Quick Reference Commands

```bash
# Test webhook
stripe trigger payout.paid

# Check status
curl https://your-url/api/sync/stripe/payouts/{payoutId}

# View logs
az functionapp log tail --name your-function-app --resource-group your-rg

# List environment variables
az functionapp config appsettings list --name your-function-app --resource-group your-rg

# Update environment variable
az functionapp config appsettings set --name your-function-app --resource-group your-rg --settings KEY=value
```
