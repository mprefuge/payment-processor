# Donation Form Local Testing Guide

## Overview

The `test-donation-form.html` page provides a complete local testing environment for the donation form (`new-popup-don.js`) before deploying to production. It includes configuration management, real-time activity logging, and support for both popup and embedded form modes.

## Quick Start

### 1. **Open the Test Page**
```bash
# From the project root, serve the file locally
# Option A: Using Python
python -m http.server 8000

# Option B: Using Node.js http-server
npx http-server

# Option C: Using VS Code Live Server extension
# Right-click test-donation-form.html → Open with Live Server
```

Then navigate to: `http://localhost:8000/test-donation-form.html`

### 2. **Configure Donor Information**
- **API Endpoint**: Pre-configured to point to the Azure payment processor
- **Stripe Mode**: Toggle between "Test" and "Live" (test mode recommended)
- **Donor Email**: Test email address (e.g., `test@micah-test.local`)
- **Organization Name**: For testing org donations (e.g., `micah test Inc`)
- **Donor Last Name**: For testing individual donations

### 3. **Test the Forms**
- **Popup Modal**: Click "Open Popup Form" to test the modal popup version
- **Embedded Form**: Switch to "Embedded Form" tab to test inline integration
- **View Quick Actions**: Use tabs and buttons to navigate different test scenarios

## Test Scenarios

### Scenario 1: Individual Donation (Popup)
1. Set **Donor Email**: `test@micah-test.local`
2. Set **Donor Last Name**: `Test Donor` (required for individuals)
3. Click **"Individual Donation"** button
4. Fill the form with test data:
   - Select amount (e.g., $50)
   - Choose frequency (e.g., "One-time")
   - Enter payment method
5. Monitor logs for validation and API calls
6. Perform test payment with Stripe test card

### Scenario 2: Organization Donation (Popup)
1. Set **Organization Name**: `micah test Inc`
2. Set **Donor Email**: `accounts@org-test.local`
3. Click **"Org Donation"** button
4. Note: Last name is NOT required for organization donations
5. Complete the donation form
6. Verify the **Salesforce Account** path is taken (check logs)

### Scenario 3: Embedded Form
1. Switch to **"Embedded Form"** tab
2. Form renders inline instead of in a modal
3. Test the same scenarios but within the page

## Stripe Test Cards

Use these test card numbers in test mode (all use 12/25 and CVC 123):

| Card Type | Number | Result |
| --------- | ------ | ------ |
| Visa (Success) | `4242 4242 4242 4242` | ✅ Charge succeeds |
| Card Declined | `4000 0000 0000 0002` | ❌ Card declined |
| 3D Secure Required | `4000 0025 0000 3155` | ⚠️ Requires auth |
| Mastercard | `5555 5555 5555 4444` | ✅ Charge succeeds |
| American Express | `3782 822463 10005` | ✅ Charge succeeds |

**Expires**: Any future month/year (e.g., `12/25`)
**CVC**: Any 3-4 digits (e.g., `123`)

## Configuration Management

### Pre-filled Test Data
The form comes pre-configured with test values:
- **Donor Email**: `test@micah-test.local`
- **Organization**: `micah test Inc`
- **Last Name**: `Test Donor`

### Stripe Mode Toggle
- **Test Mode** (default): Uses test API keys, no real charges
- **Live Mode**: Uses live API keys ⚠️ **REAL CHARGES WILL OCCUR**

### API Endpoint
Pre-set to: `http://localhost:7071/api/transaction`

To test against a local payment processor:
1. Edit the "API Endpoint" field
2. Paste local URL (e.g., `http://localhost:7071/api/transaction`)

## Local Testing Setup

### Option A: Using Azure Functions Core Tools (Recommended)

#### 1. Install Prerequisites
```bash
# macOS
brew tap azure/tap
brew install azure-functions-core-tools@4

# Windows (via chocolatey)
choco install azure-functions-core-tools
```

#### 2. Start Local Payment Processor
```bash
func start
# Output: Http Functions: processTransaction [POST] http://localhost:7071/api/transaction
```

#### 3. Configure Test Page
Set **API Endpoint** to: `http://localhost:7071/api/transaction`

### Option B: Docker Container
```bash
docker build -t payment-processor .
docker run -p 7071:80 -e STRIPE_TEST_SECRET_KEY=sk_test_... payment-processor
```

## Stripe Webhook Configuration for Local Testing

### Install and Setup Stripe CLI
```bash
# macOS
brew install stripe/stripe-cli/stripe

# Windows
choco install stripe

# Login
stripe login
```

### Forward Webhooks to Local Machine

**Terminal 1**: Start webhook listener
```bash
stripe listen --forward-to localhost:7071/api/webhook/stripe
# Save the webhook signing secret: whsec_test_xxx
```

**Terminal 2**: Local payment processor
```bash
func start
# Listen on localhost:7071
```

**Terminal 3**: Test page server
```bash
python -m http.server 8000
```

### Configure Environment Variables
```bash
# .env.local or local.settings.json
STRIPE_WEBHOOK_SECRET=whsec_test_xxx
STRIPE_TEST_SECRET_KEY=sk_test_...
```

### Test Webhook Events
```bash
# In Terminal 3, trigger test events
stripe trigger charge.succeeded
stripe trigger charge.failed
stripe trigger charge.refunded
stripe trigger payout.paid
stripe trigger payout.failed
```

Monitor Terminal 1 (webhook listener) and Terminal 2 (payment processor) for event processing.

### Full Local Integration Workflow (30 minutes)

1. **Setup Phase (5 min)**
  - Terminal 1: `stripe listen --forward-to localhost:7071/api/webhook/stripe`
  - Terminal 2: `func start`
  - Terminal 3: `python -m http.server 8000`

2. **Form Testing (10 min)**
  - Open `http://localhost:8000/test-donation-form.html`
  - Set API endpoint to `http://localhost:7071/api/transaction`
  - Test popup form with individual donation
  - Use card: `4242 4242 4242 4242`

3. **Webhook Verification (5 min)**
  - Check Terminal 1: Webhook receipt
  - Check Terminal 2: Processing log
  - Verify transaction in Salesforce/QBO

4. **Error Testing (5 min)**
  - Test declined card: `4000 0000 0000 0002`
  - Trigger webhook failure: `stripe trigger payout.failed`

5. **Duplicate Prevention (5 min)**
  - Replay request in DevTools Network tab
  - Verify only ONE transaction created

### Local Testing Checklist

- [ ] Stripe CLI installed and authenticated
- [ ] Webhook listener running (Terminal 1)
- [ ] Payment processor running (Terminal 2)
- [ ] Test page server running (Terminal 3)
- [ ] API endpoint set to localhost in test page
- [ ] Webhook secret in environment variables
- [ ] Stripe mode set to Test
- [ ] Monitor all 3 terminals during testing

## Activity Logs

The **Activity Logs** panel (bottom left) displays:
- ✅ **Success**: Form validations passed, donations processed
- ❌ **Error**: Validation failures, API errors
- ⚠️ **Warning**: Mode changes, deprecated features
- ℹ️ **Info**: General flow events

### Log Types
- **Info** (blue): General messages and flow progress
- **Success** (green): Successful operations
- **Error** (red): Failures and issues
- **Warning** (orange): Warnings and potentially unsafe actions

### Features
- Latest 50 log entries shown
- Click "Clear Logs" to reset
- Logs are NOT persistent (page refresh clears them)

## Advanced Testing

### 1. **Validate Form Configuration**
Click **"Validate Form"** to check:
- Required fields are populated
- Configuration is consistent
- No obvious errors

### 2. **Inspect Network Logs**
Click **"Network Logs"** to:
- Open browser DevTools (F12)
- Go to **Network** tab
- View all API calls to payment processor
- Inspect request/response payloads

### 3. **Download Test Report**
Click **"Download Test Report"** to generate JSON file containing:
- Test timestamp
- Current configuration
- All activity logs
- Test passes/failures count
- Export as `donation-form-test-[timestamp].json`

## Testing Duplicate Prevention

To verify no duplicates are created:

### Method 1: Idempotency Header
1. Open browser DevTools (F12)
2. Go to **Network** tab
3. Submit a donation form
4. Find the API call to `/api/transaction`
5. Verify `Idempotency-Key` header is present
6. Retry the exact same request (it should return 200 without reprocessing)

### Method 2: CRM Verification
1. Log into Salesforce
2. After submitting a form, check **Transactions__c** object
3. Verify only ONE transaction exists per checkout session
4. Verify Session ID: `Stripe_Checkout_Session_Id__c`

### Method 3: QuickBooks Verification
1. Log into QuickBooks Online
2. Check **Journal Entries** for Stripe entries
3. Verify DocNumber is unique (e.g., `STRIPE-ch_1234567890`)
4. Same charge should never create duplicate entries

## Common Issues & Solutions

### Issue: "Stripe.js not loaded"
- **Cause**: Stripe script loaded before page rendered
- **Solution**: Refresh the page or wait 2 seconds before clicking buttons

### Issue: "Payment processor returned 400"
- **Cause**: Invalid form data or missing required fields
- **Solution**: Check Activity Logs for validation error details

### Issue: Form doesn't appear
- **Cause**: CSS conflicts or script loading issues
- **Solution**: 
  1. Open DevTools Console (F12)
  2. Check for JavaScript errors
  3. Clear browser cache and refresh

### Issue: API calls fail with 401/403
- **Cause**: Authentication token expired or invalid
- **Solution**: 
  1. Verify API endpoint is correct
  2. Check payment processor is running
  3. Verify Stripe keys are valid

## Pre-Deployment Checklist

Before pushing to production, test:

- [ ] **Popup form opens and closes correctly**
- [ ] **Embedded form renders inline properly**
- [ ] **Individual donations work without organization name**
- [ ] **Organization donations work without last name**
- [ ] **All donation amounts are selectable**
- [ ] **All frequency options work (one-time, weekly, monthly, yearly)**
- [ ] **Form validation shows appropriate error messages**
- [ ] **Stripe checkout redirects correctly**
- [ ] **Test payment succeeds with test card**
- [ ] **Transaction appears in Salesforce (if CRM configured)**
- [ ] **Transaction appears in QuickBooks (if accounting configured)**
- [ ] **No duplicate transactions created on retry**
- [ ] **Idempotency key prevents duplicate processing**
- [ ] **Organization routing doesn't create duplicate contacts**
- [ ] **Contact/Account separation works correctly**
- [ ] **All 270 tests pass** (`npm run test`)

## Integration with CI/CD

### Local Development Workflow
```bash
# 1. Make changes to new-popup-don.js

# 2. Open test page to verify
open test-donation-form.html

# 3. Run full test suite
npm run test

# 4. If all tests pass and manual testing successful
git commit -m "feat: donation form updates"

# 5. Push to staging/production
git push
```

### Pre-Merge Verification
Before merging a PR with donation form changes:
1. Run full test suite: `npm run test` (should see 270/270 passing)
2. Manual test through test page for key scenarios
3. Verify CRM/accounting integrations work
4. Check payment processor logs for errors

## Debugging Tips

### Enable Secure Debug Logging
Add to payment processor `.env`:
```
SECURE_DEBUG=true
```
This enables detailed request logging in payment processor output.

### Monitor Stripe Dashboard
1. Log into Stripe Dashboard
2. Go to **Payments** → **Charges**
3. Filter by test/live mode
4. View charge details and logs

### Check Payment Processor Logs
```bash
# Azure Functions (if running locally)
func start

# Check output for donation processing logs

# Or view live logs
az functionapp logs tail --resource-group <rg> --name <function-app>
```

## Support & Feedback

If encountering issues:
1. Check Activity Logs for error messages
2. Review browser DevTools Console (F12)
3. Inspect Network tab for failed requests
4. Run `npm run test` to check for regressions
5. Compare with successful test runs in CI/CD

## See Also

- [Payment Processor README](./README.md)
- [Donation Form Integration Guide](./docs/QUICK_START_CHECKLIST.md)
- [Stripe Integration Documentation](./docs/stripe-true-up-quick-reference.md)
- [CRM Integration Guide](./docs/CUSTOMER_SYNC_IMPLEMENTATION.md)
