# Testing Manual Payout Webhook Events

This guide shows how to test the manual payout webhook handling without creating real Stripe transactions.

## Quick Start

Run the webhook simulation script:

```bash
node examples/webhook-simulation.js
```

This will output curl commands you can use to test your webhook endpoint.

## Example: Testing a Manual Payout

### Step 1: Start your local function app

```bash
npm start
```

This will start the Azure Functions runtime on `http://localhost:7071`.

### Step 2: Get the curl command from the simulation script

```bash
node examples/webhook-simulation.js | grep -A30 "MANUAL PAYOUT - PAID"
```

### Step 3: Send the test request

Copy the curl command and run it in another terminal:

```bash
curl -X POST http://localhost:7071/api/stripe/webhook \
  -H 'Content-Type: application/json' \
  -H 'User-Agent: Stripe/1.0 (+https://stripe.com/docs/webhooks)' \
  -d '{
  "id": "evt_test_manual_paid_001",
  "type": "payout.paid",
  "data": {
    "object": {
      "id": "po_test_manual_001",
      "automatic": false,
      ...
    }
  }
}'
```

### Step 4: Check the logs

You should see logs like:

```
[PayoutSync] Using date range filter for manual payout (no payout ID filtering)
[PayoutSync] Date window: <start> to <end>
[PayoutSync] Fetched X transactions in date range
```

## Testing the Fix

To verify the date window optimization fix works:

### 1. Send first manual payout (will likely fail validation in test)

```bash
# Use evt_test_manual_paid_001 with id po_test_manual_001
```

Check logs - should see:
```
[PayoutJob] Recorded failed sync in ledger for date window optimization
```

### 2. Send second manual payout (23 minutes later timestamp)

```bash
# Modify the simulation script to create a second payout
# with a timestamp 23 minutes after the first
```

Check logs - should see:
```
[PayoutSync] Found previous payout: po_test_manual_001
[PayoutSync] Date window: <23 minute range>
```

The window should be ~23 minutes, NOT 30 days!

## Available Test Scenarios

The simulation script provides examples for:

1. **Manual Payout - Created Event**
   - `evt_test_manual_created_001`
   - Tests payout creation handling

2. **Manual Payout - Paid Event**
   - `evt_test_manual_paid_001`
   - Tests payout sync workflow

3. **Automatic Payout (Platform) - Created Event**
   - `evt_test_auto_created_001`
   - Tests automatic payout on platform account

4. **Automatic Payout (Platform) - Paid Event**
   - `evt_test_auto_paid_001`
   - Tests automatic payout sync

5. **Connected Account Payout - Created Event**
   - `evt_test_connected_created_001`
   - Tests connected account with `Stripe-Account` header

6. **Connected Account Payout - Paid Event**
   - `evt_test_connected_paid_001`
   - Tests connected account payout sync

## Customizing Test Payloads

Edit `examples/webhook-simulation.js` to customize:

- Payout amounts
- Timestamps (for testing date windows)
- Event IDs
- Stripe account IDs

Example modification:

```javascript
// Change payout amount
amount: 5000, // $50.00 instead of $23.65

// Change timestamp (23 minutes after previous)
created: Math.floor(Date.now() / 1000) + (23 * 60),
```

## Monitoring the Fix

After running test payloads, check for these log messages:

### ✅ Success Indicators

```
[PayoutSync] Found previous payout: po_xxx
[PayoutSync] Date window: ...T14:40:06Z to ...T15:03:57Z
[PayoutJob] Recorded failed sync in ledger for date window optimization
```

### ❌ Problem Indicators (should NOT see after fix)

```
[PayoutSync] Date window: ...09-03... to ...10-03... (30 days)
```

If you see a 30-day window, the previous payout lookup is failing.

## Production Considerations

⚠️ **Important:** In production, you MUST verify webhook signatures!

The test curl commands don't include the `stripe-signature` header that Stripe sends. In your webhook handler, you should:

1. **Development/Testing:** Set environment variable to skip signature verification
2. **Production:** Always verify signatures using Stripe's webhook secret

Example:

```javascript
if (process.env.NODE_ENV === 'production') {
    const signature = req.headers['stripe-signature'];
    const event = stripe.webhooks.constructEvent(
        req.rawBody, 
        signature, 
        webhookSecret
    );
}
```

## Troubleshooting

### Issue: "Module not found" error

Make sure you've installed dependencies:

```bash
npm install
```

### Issue: "Cannot connect to localhost:7071"

Make sure the Azure Functions runtime is running:

```bash
npm start
```

### Issue: No logs appearing

Check the function app logs in the terminal where you ran `npm start`.

### Issue: Signature verification fails

For testing, you may need to disable signature verification. Set an environment variable:

```bash
# .env or local.settings.json
DISABLE_WEBHOOK_SIGNATURE_VALIDATION=true
```

⚠️ Never do this in production!

## Next Steps

After verifying the fix works locally:

1. Deploy to your test/staging environment
2. Create real test payouts in Stripe test mode
3. Monitor logs for the optimized date windows
4. Verify validation mismatches are resolved

The webhook simulation script makes it easy to test without waiting for real Stripe events or creating test transactions.
