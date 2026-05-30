# Quick Start Checklist - Stripe True-Up

## ✅ Pre-Deployment Checklist

### Azure Configuration
- [ ] Azure Function App created: `payment-processing-function`
- [ ] Application Insights enabled
- [ ] Azure Storage Account connected

### Environment Variables Set
Go to: Azure Portal → Function App → Configuration → Application Settings

#### Stripe (Required)
- [ ] `STRIPE_LIVE_SECRET_KEY` = `sk_live_...`
- [ ] `STRIPE_TEST_SECRET_KEY` = `sk_test_...`
- [ ] `STRIPE_TRUE_UP_MODE` = `test` or `live`

#### Salesforce (Required for SF sync)
- [ ] `SALESFORCE_USERNAME` = `your-email@company.com`
- [ ] `SALESFORCE_PASSWORD` = `your-password`
- [ ] `SALESFORCE_SECURITY_TOKEN` = `token` (if IP not whitelisted)
- [ ] `SALESFORCE_LOGIN_URL` = `https://login.salesforce.com` (or sandbox URL)

#### QuickBooks (Required for QBO sync)
- [ ] `QBO_CLIENT_ID` = `your-client-id`
- [ ] `QBO_CLIENT_SECRET` = `your-client-secret`
- [ ] `QBO_REALM_ID` = `your-company-id` (QuickBooks Company/Realm ID)
- [ ] `QBO_ENVIRONMENT` = `sandbox` or `production`
- [ ] **Local OAuth Setup**: Run `npm run setup:qbo` locally to get refresh token
- [ ] **Azure Deployment**: Set `QBO_REFRESH_TOKEN` in Azure Function environment

#### Azure Storage (Required)
- [ ] `AZURE_TABLES_CONNECTION_STRING` = `DefaultEndpointsProtocol=https;...`
  OR
- [ ] `AZURE_STORAGE_CONNECTION_STRING` = `DefaultEndpointsProtocol=https;...`

#### Optional
- [ ] `IDEMPOTENCY_TABLE_NAME` = `IdempotencyState` (default)
- [ ] `DISABLE_AZURE_TABLES` = `0` (use `1` for testing without Azure Tables)
- [ ] `ACCOUNTING_POSTING_STRATEGY` = `journal-entry` or `sales-receipt`

---

## 🚀 Deployment Steps

### 1. Build & Test Locally
```powershell
cd C:\Projects\payment-processor
npm install
npm run build
npm test  # Optional but recommended
```

### 1.5. Setup QuickBooks OAuth (if using QBO sync)
**Important**: This must be done locally, not in Azure!

```powershell
# Ensure QBO_CLIENT_ID, QBO_CLIENT_SECRET, and QBO_REALM_ID are set locally
npm run setup:qbo
# Follow the interactive prompts to authorize locally
# Copy the QBO_REFRESH_TOKEN value from the output
```

### 2. Deploy to Azure

### 2. Deploy to Azure

**Option A: VS Code**
- [ ] Install Azure Functions extension
- [ ] Right-click Function App → Deploy
- [ ] Wait for deployment to complete

**Option B: Command Line**
```powershell
func azure functionapp publish payment-processing-function
```

### 3. Verify Deployment
```powershell
# Test health endpoint
curl https://payment-processing-function.azurewebsites.net/api/health
# Should return: {"status":"healthy"}
```

### 4. Get Function Key
- [ ] Azure Portal → Function App → Functions → stripeTrueUp → Function Keys
- [ ] Copy "default" key
- [ ] Save securely: `$functionKey = "paste-key-here"`

---

## 🎯 First Run

### Step 1: Test with Dry Run
```powershell
# Set your function key
$functionKey = "your-function-key-here"

# Test dry run (no data written)
.\scripts\test-true-up.ps1 `
  -From "2024-01-01" `
  -To "2024-01-31" `
  -Type payments `
  -DryRun $true `
  -FunctionKey $functionKey
```

**Expected Output:**
```json
{
  "type": "payments",
  "dryRun": true,
  "liveMode": false,
  "range": {
    "from": "2024-01-01T00:00:00.000Z",
    "to": "2024-01-31T23:59:59.999Z"
  },
  "counts": {
    "fetched": 150,
    "processed": 145,
    "skipped": 3,
    "salesforceUpdates": 0,
    "qboPosts": 0,
    "errors": 2
  }
}
```

### Step 2: Review and Verify
- [ ] Check `fetched` count matches expected Stripe transactions
- [ ] Review `skipped` count (failed/pending transactions)
- [ ] Check `errors` count is acceptable
- [ ] Verify date range is correct

### Step 3: Run for Real
```powershell
# Actual run (data will be written)
.\scripts\test-true-up.ps1 `
  -From "2024-01-01" `
  -To "2024-01-31" `
  -Type payments `
  -DryRun $false `
  -FunctionKey $functionKey
```

### Step 4: Verify Results
- [ ] Check Salesforce for new Transaction records
- [ ] Verify `posted_to_qbo__c` field is populated
- [ ] Check QuickBooks for Sales Receipts or Journal Entries
- [ ] Confirm dates match original Stripe transactions

---

## 🔍 Quick Troubleshooting

### Error: 500 Internal Server Error
**Fix**: Check environment variables in Azure Configuration

```powershell
# View logs in real-time
az webapp log tail --name payment-processing-function --resource-group your-rg
```

### Error: 401 Unauthorized
**Fix**: Verify function key is correct
- [ ] Get fresh key from Azure Portal
- [ ] Ensure `code` parameter is in URL

### Error: No transactions processed (counts.processed = 0)
**Fix**: Check these:
- [ ] Verify `STRIPE_TRUE_UP_MODE` matches your intent (test vs live)
- [ ] Confirm Stripe has data in the date range
- [ ] Check if transactions were already processed (idempotency)

### Error: Salesforce connection failed
**Fix**: Check Salesforce credentials
- [ ] Verify username/password in Azure Configuration
- [ ] Add security token if IP not whitelisted
- [ ] Check login URL (production vs sandbox)

### Error: QuickBooks OAuth failed
**Fix**: Refresh OAuth tokens
- [ ] Verify `QBO_CLIENT_ID` and `QBO_CLIENT_SECRET`
- [ ] Check token expiration in `data/qbo-tokens/tokens.json`
- [ ] Re-authorize QBO connection if needed

---

## 📊 Monitoring

### View Logs in Azure Portal
1. Go to Function App → Log stream
2. Or use Application Insights → Logs
3. Search for `StripeTrueUp` to filter

### Kusto Query (Application Insights)
```kusto
traces
| where message contains "StripeTrueUp"
| order by timestamp desc
| take 50
```

---

## ✨ Success Criteria

After your first successful run:

- [ ] ✅ Dry run completed without errors
- [ ] ✅ Actual run completed successfully
- [ ] ✅ Transactions appear in Salesforce
- [ ] ✅ Transactions posted to QuickBooks
- [ ] ✅ Historic dates preserved correctly
- [ ] ✅ No duplicate transactions created
- [ ] ✅ Only successful (paid/refunded) transactions synced

---

## 📞 Need Help?

1. **Check the full guide**: `docs/STRIPE_TRUE_UP_DEPLOYMENT_GUIDE.md`
2. **Review improvements doc**: `docs/STRIPE_TRUE_UP_IMPROVEMENTS.md`
3. **Check Application Insights**: Azure Portal → Function App → Application Insights
4. **Test with dry run**: Always safe to run with `dryRun=true`

---

## 🔄 Regular Usage

Once set up, use this command for monthly syncs:

```powershell
# January 2024
.\scripts\test-true-up.ps1 -From "2024-01-01" -To "2024-01-31" -Type payments -FunctionKey $functionKey

# February 2024
.\scripts\test-true-up.ps1 -From "2024-02-01" -To "2024-02-29" -Type payments -FunctionKey $functionKey

# Refunds
.\scripts\test-true-up.ps1 -From "2024-01-01" -To "2024-01-31" -Type refunds -FunctionKey $functionKey

# Payouts
.\scripts\test-true-up.ps1 -From "2024-01-01" -To "2024-01-31" -Type payouts -FunctionKey $functionKey
```

---

## 🎉 You're All Set!

The Stripe True-Up is now configured and ready to sync historic data safely and reliably.
