# Stripe Payout Feature - Quick Start

## What This Feature Does

Automatically processes Stripe payouts by:
1. ✅ Creating a **Payout transaction in Salesforce** with full details
2. ✅ Posting a **Bank Deposit in QuickBooks** (Stripe Clearing → Operating Bank)
3. ✅ Linking all related transactions to the payout
4. ✅ Marking the transaction as synced with QuickBooks

## Quick Setup

### 1. Salesforce Setup (Required)

Add the `payout` value to the `Transaction_Type__c` picklist:
- Setup → Object Manager → Transaction__c → Fields & Relationships → Transaction_Type__c
- Add value: **payout**

**Verify these fields exist (should already be there):**
- Stripe_Payout_Id__c (Text, 255, External ID)
- Stripe_Balance_Transaction_Id__c (Text, 255, External ID) ⚠️ Must be External ID!
- Amount_Gross__c, Amount_Fee__c, Amount_Net__c (Currency)
- Posted_to_QBO__c (Checkbox)

📖 **Full setup guide:** [docs/salesforce-payout-setup.md](./salesforce-payout-setup.md)

### 2. Environment Variables

Ensure these are set:
```bash
ACCOUNTING_SYNC_ENABLED=true
QBO_ACCOUNT_STRIPE_CLEARING=Stripe Clearing
QBO_ACCOUNT_OPERATING_BANK=Operating Bank
```

### 3. Test the Feature

#### Option A: Use Stripe CLI (Recommended)
```bash
# Terminal 1: Forward webhooks
stripe listen --forward-to http://localhost:7071/api/stripeWebhook

# Terminal 2: Trigger test payout
stripe trigger payout.paid
```

#### Option B: Use Test Script
```powershell
# Start your function app
npm start

# In another terminal
.\scripts\test-payout-webhook.ps1
```

## What Gets Created

### In Salesforce
```
Transaction__c Record:
├─ Transaction_Type__c: "payout"
├─ Status__c: "paid"
├─ Stripe_Payout_Id__c: "po_1QAb..."
├─ Amount_Gross__c: 1000.00
├─ Amount_Fee__c: 30.00
├─ Amount_Net__c: 970.00
├─ Posted_to_QBO__c: ✓
└─ Memo__c: "Stripe Payout po_... | Charges: $1000.00 | Fees: -$30.00 | Net: $970.00"
```

### In QuickBooks
```
Bank Deposit:
├─ Doc Number: PO-po_1QAbCdEf...
├─ Date: (payout arrival date)
├─ From: Stripe Clearing
├─ To: Operating Bank
└─ Amount: $970.00
```

## Supported Payout Events

| Event | Creates SF Transaction | Posts QBO Deposit | Status |
|-------|----------------------|-------------------|--------|
| payout.paid | ✅ | ✅ | paid |
| payout.failed | ✅ | ❌ | failed |
| payout.canceled | ✅ | ❌ | pending |
| payout.reconciliation_completed | ✅ | ✅ | paid |

## Example Webhook Events

See [docs/examples/](./examples/) for sample JSON:
- `payout-paid-event.json` - Successful payout
- `payout-failed-event.json` - Failed payout
- `payout-canceled-event.json` - Canceled payout
- `payout-reconciliation-completed-event.json` - Reconciliation completed

## Verification Steps

After a payout webhook is processed:

### 1. Check Logs
Look for these log messages:
```
[StripeWebhook] Created payout transaction in Salesforce
[StripeWebhook] Marked payout transaction as posted to QBO
[StripeWebhook] Upserted QuickBooks deposit for payout
```

### 2. Check Salesforce
- Navigate to Transaction__c
- Filter by Transaction Type = "payout"
- Verify the record exists with correct amounts

### 3. Check QuickBooks
- Navigate to Banking → Deposits
- Look for deposit from Stripe Clearing to Operating Bank
- Verify amount matches payout net amount

## Troubleshooting

### Payout transaction not created in Salesforce
**Cause:** Missing "payout" value in Transaction_Type__c picklist  
**Fix:** Add "payout" to the picklist (see Salesforce setup guide)

### "Cannot reference External ID field" error
**Cause:** Stripe_Balance_Transaction_Id__c not marked as External ID  
**Fix:** Edit field → Check "External ID" → Save

### Deposit not posted to QuickBooks
**Cause:** ACCOUNTING_SYNC_ENABLED=false  
**Fix:** Set ACCOUNTING_SYNC_ENABLED=true

### Balance doesn't match
**Cause:** Normal - Stripe sometimes has rounding differences  
**Fix:** Check logs for `differenceCents` - small differences are expected

## Documentation

- 📚 [Complete Feature Guide](./payout-feature-guide.md) - Detailed documentation
- 🔧 [Salesforce Setup Guide](./salesforce-payout-setup.md) - Step-by-step Salesforce configuration
- 📝 [Example Events](./examples/) - Sample webhook payloads for testing

## Architecture

```
Stripe Webhook (payout.paid)
        ↓
┌───────────────────────────────┐
│ 1. Fetch Balance Transactions │
└───────────────────────────────┘
        ↓
┌───────────────────────────────┐
│ 2. Link to SF Transactions    │
│    (via Stripe_Payout_Id__c)  │
└───────────────────────────────┘
        ↓
┌───────────────────────────────┐
│ 3. Create SF Payout Record    │
│    - Type: payout             │
│    - Status: paid/failed      │
│    - Amounts calculated       │
└───────────────────────────────┘
        ↓
┌───────────────────────────────┐
│ 4. Post QBO Bank Deposit      │
│    Stripe Clearing → Bank     │
└───────────────────────────────┘
        ↓
┌───────────────────────────────┐
│ 5. Mark SF Transaction        │
│    Posted_to_QBO__c = true    │
└───────────────────────────────┘
```

## Key Files Modified

- ✏️ `src/stripe/handlers/payouts.ts` - Main payout handler with Salesforce integration
- ✏️ `src/handlers/stripeWebhook.ts` - Payout adapter for QBO deposits
- 📄 `docs/payout-feature-guide.md` - Complete documentation
- 📄 `docs/salesforce-payout-setup.md` - Salesforce setup instructions
- 📄 `docs/examples/payout-*.json` - Test event samples

## Support

**For questions about:**
- Salesforce setup → See [salesforce-payout-setup.md](./salesforce-payout-setup.md)
- Testing → See [payout-feature-guide.md](./payout-feature-guide.md#testing-the-feature)
- Webhooks → See [payout-feature-guide.md](./payout-feature-guide.md#example-webhook-payloads)

---

**Last Updated:** October 26, 2025  
**Version:** 1.0.0
