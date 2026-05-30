# Stripe True-Up Deployment and Usage Guide

## Overview
This guide provides complete instructions for deploying and running the Stripe True-Up functionality to sync historic transaction data from Stripe to Salesforce and QuickBooks Online.

---

## Prerequisites

### 1. Azure Resources
- Azure Function App (already created: `payment-processing-function`)
- Azure Storage Account (for idempotency tracking)
- Application Insights (recommended for monitoring)

### 2. Third-Party Accounts
- **Stripe Account** (Test and/or Live mode)
- **Salesforce Account** with API access
- **QuickBooks Online Account** with OAuth 2.0 configured
- **Intuit Developer Account** (for QBO API credentials)

### 3. Development Tools
- Node.js 18+ (for local testing)
- PowerShell 7+ or Bash
- Azure CLI (for deployment)
- Git (for version control)

---

## Required Environment Variables

Configure these in your Azure Function App (Azure Portal → Function App → Configuration → Application Settings):

### Stripe Configuration

| Variable | Required | Description | Example |
|----------|----------|-------------|---------|
| `STRIPE_LIVE_SECRET_KEY` | Yes (Live) | Stripe Live Secret Key | `sk_live_...` |
| `STRIPE_TEST_SECRET_KEY` | Yes (Test) | Stripe Test Secret Key | `sk_test_...` |
| `STRIPE_TRUE_UP_MODE` | Yes | Mode to run in | `test` or `live` |

### Salesforce Configuration

| Variable | Required | Description | Example |
|----------|----------|-------------|---------|
| `SALESFORCE_USERNAME` | Yes | Salesforce username | `user@company.com` |
| `SALESFORCE_PASSWORD` | Yes | Salesforce password | `YourPassword123` |
| `SALESFORCE_SECURITY_TOKEN` | No* | Salesforce security token | `abc123xyz...` |
| `SALESFORCE_LOGIN_URL` | No | Salesforce login URL | `https://login.salesforce.com` |

*Required if your IP is not whitelisted in Salesforce

### QuickBooks Online Configuration

| Variable | Required | Description | Example |
|----------|----------|-------------|---------|
| `QBO_CLIENT_ID` | Yes | QuickBooks OAuth Client ID | `AB...xyz` |
| `QBO_CLIENT_SECRET` | Yes | QuickBooks OAuth Client Secret | `abc123...` |
| `QBO_REALM_ID` | Yes | QuickBooks Company ID (Realm ID) | `123456789` |
| `QBO_COMPANY_ID` | Alternative | Alternative to QBO_REALM_ID | `123456789` |
| `QBO_ENVIRONMENT` | No | QBO environment | `sandbox` or `production` |
| `QBO_REFRESH_TOKEN` | Yes | OAuth refresh token | `AB11...xyz` |

### Azure Storage Configuration

| Variable | Required | Description | Example |
|----------|----------|-------------|---------|
| `AZURE_TABLES_CONNECTION_STRING` | Yes | Azure Tables connection string | `DefaultEndpointsProtocol=https;...` |
| `AZURE_STORAGE_CONNECTION_STRING` | Alternative | Alternative to AZURE_TABLES | Same as above |
| `IDEMPOTENCY_TABLE_NAME` | No | Table name for idempotency | `IdempotencyState` (default) |

### Optional Configuration

| Variable | Required | Description | Default |
|----------|----------|-------------|---------|
| `DISABLE_AZURE_TABLES` | No | Use in-memory store | `0` (disabled) |
| `ACCOUNTING_POSTING_STRATEGY` | No | QBO posting method | `journal-entry` |

---

## Step-by-Step Deployment

### Step 1: Build the Project

```powershell
# Navigate to project directory
cd C:\Projects\payment-processor

# Install dependencies
npm install

# Build TypeScript
npm run build

# Run tests (optional but recommended)
npm test
```

### Step 2: Configure Environment Variables in Azure

**Option A: Azure Portal**
1. Go to Azure Portal → Your Function App
2. Select **Configuration** under Settings
3. Click **+ New application setting** for each variable
4. Add all required variables from the table above
5. Click **Save** and **Continue** to restart the app

**Option B: Azure CLI**
```bash
# Set variables using Azure CLI
az functionapp config appsettings set \
  --name payment-processing-function \
  --resource-group your-resource-group \
  --settings \
    STRIPE_LIVE_SECRET_KEY="sk_live_..." \
    STRIPE_TEST_SECRET_KEY="sk_test_..." \
    STRIPE_TRUE_UP_MODE="test" \
    SALESFORCE_USERNAME="user@company.com" \
    SALESFORCE_PASSWORD="password" \
    QBO_CLIENT_ID="your-client-id" \
    QBO_CLIENT_SECRET="your-client-secret" \
    QBO_REALM_ID="123456789" \
    QBO_REFRESH_TOKEN="your-refresh-token" \
    AZURE_TABLES_CONNECTION_STRING="DefaultEndpointsProtocol=https;..."
```

### Step 3: Deploy to Azure

**Option A: VS Code Azure Functions Extension**
1. Install Azure Functions extension in VS Code
2. Sign in to Azure
3. Right-click on Function App → Deploy to Function App
4. Select your Function App
5. Confirm deployment

**Option B: Azure CLI**
```bash
# Deploy using func CLI
func azure functionapp publish payment-processing-function
```

**Option C: GitHub Actions (Recommended for CI/CD)**
```yaml
# .github/workflows/deploy.yml
name: Deploy to Azure Functions

on:
  push:
    branches: [ prod ]

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      - uses: actions/setup-node@v3
        with:
          node-version: '18'
      - run: npm ci
      - run: npm run build
      - uses: Azure/functions-action@v1
        with:
          app-name: payment-processing-function
          package: .
          publish-profile: ${{ secrets.AZURE_FUNCTIONAPP_PUBLISH_PROFILE }}
```

### Step 4: Verify Deployment

```powershell
# Test health check endpoint (should work without auth)
curl https://payment-processing-function.azurewebsites.net/api/health

# Should return: {"status":"healthy"}
```

### Step 5: Get Function Key

1. Go to Azure Portal → Your Function App
2. Navigate to **Functions** → **stripeTrueUp**
3. Click **Function Keys**
4. Copy the **default** key
5. Save it securely (you'll need this for all requests)

---

## QuickBooks OAuth Setup

The True-Up functionality requires an active QuickBooks OAuth token. Follow these steps:

### 1. Initial OAuth Flow

You need to obtain OAuth tokens using the QBO OAuth flow:

```powershell
# Use the QBO authentication endpoint (you'll need to implement this)
# Or manually authorize via Intuit Developer Portal
```

### 2. Token Storage

Tokens are typically stored in `data/qbo-tokens/tokens.json`:

```json
{
  "access_token": "your-access-token",
  "refresh_token": "your-refresh-token",
  "expires_at": 1234567890,
  "realm_id": "123456789"
}
```

### 3. Token Refresh

The system automatically refreshes tokens when they expire, but ensure:
- `QBO_CLIENT_ID` and `QBO_CLIENT_SECRET` are set
- The refresh token is still valid (they expire after 100 days of inactivity)

---

## Running the True-Up

### Method 1: Using PowerShell Script (Recommended)

```powershell
# Set your function key
$functionKey = "your-function-key-from-azure"

# Dry run to test (recommended first time)
.\scripts\test-true-up.ps1 `
  -From "2024-01-01" `
  -To "2024-01-31" `
  -Type payments `
  -DryRun $true `
  -FunctionKey $functionKey

# Review the output, then run for real
.\scripts\test-true-up.ps1 `
  -From "2024-01-01" `
  -To "2024-01-31" `
  -Type payments `
  -DryRun $false `
  -FunctionKey $functionKey
```

### Method 2: Using cURL

```powershell
# Windows PowerShell
$functionKey = "your-function-key"

curl -X GET "https://payment-processing-function.azurewebsites.net/api/stripe/true-up?from=2024-01-01&to=2024-01-31&type=payments&dryRun=true&code=$functionKey"
```

```bash
# Bash/Linux
functionKey="your-function-key"

curl -X GET \
  "https://payment-processing-function.azurewebsites.net/api/stripe/true-up?from=2024-01-01&to=2024-01-31&type=payments&dryRun=true&code=$functionKey"
```

### Method 3: Using Postman

1. **Method**: `GET`
2. **URL**: `https://payment-processing-function.azurewebsites.net/api/stripe/true-up`
3. **Query Parameters**:
   - `from`: `2024-01-01` (required)
   - `to`: `2024-01-31` (optional)
   - `type`: `payments` (payments/refunds/payouts)
   - `dryRun`: `true` (true/false)
   - `code`: `your-function-key` (required)

---

## Query Parameters

| Parameter | Required | Type | Options | Description |
|-----------|----------|------|---------|-------------|
| `from` | ✅ Yes | Date | ISO 8601 or YYYY-MM-DD | Start date for sync |
| `to` | ❌ No | Date | ISO 8601 or YYYY-MM-DD | End date for sync (inclusive) |
| `type` | ❌ No | String | `payments`, `refunds`, `payouts` | Type of transactions to sync |
| `dryRun` | ❌ No | Boolean | `true`, `false` | Preview mode (no data persisted) |
| `code` | ✅ Yes | String | Azure Function Key | Authentication |

---

## Response Format

### Success Response (200 OK)

```json
{
  "type": "payments",
  "dryRun": false,
  "liveMode": false,
  "range": {
    "from": "2024-01-01T00:00:00.000Z",
    "to": "2024-01-31T23:59:59.999Z"
  },
  "counts": {
    "fetched": 150,
    "processed": 145,
    "skipped": 3,
    "salesforceUpdates": 145,
    "qboPosts": 145,
    "errors": 2
  }
}
```

### Error Response (400/500)

```json
{
  "error": "configuration_error",
  "message": "Required environment variables are not configured.",
  "details": [
    "STRIPE_LIVE_SECRET_KEY is not configured for live mode",
    "SALESFORCE_USERNAME is not configured"
  ]
}
```

---

## Troubleshooting

### 500 Internal Server Error

**Cause**: Missing or invalid environment variables

**Solution**:
1. Check Azure Portal → Function App → Configuration
2. Verify all required variables are set
3. Check Application Insights logs for specific errors
4. Run with `dryRun=true` first

**Check Logs**:
```bash
# View live logs
az webapp log tail --name payment-processing-function --resource-group your-rg

# Or in Azure Portal: Function App → Log stream
```

### 401 Unauthorized

**Cause**: Invalid or missing function key

**Solution**:
1. Get fresh function key from Azure Portal
2. Ensure `code` parameter is in the URL
3. Verify the key hasn't been regenerated

### 400 Bad Request

**Cause**: Invalid parameters

**Solution**:
- Check `from` date format (YYYY-MM-DD or ISO 8601)
- Ensure `type` is one of: payments, refunds, payouts
- Verify `to` date is after `from` date

### No Transactions Processed (counts.processed = 0)

**Possible Causes**:
1. **Wrong Stripe Mode**: Check `STRIPE_TRUE_UP_MODE` (test vs live)
2. **No Data in Date Range**: Verify Stripe has transactions in that period
3. **All Transactions Already Processed**: Check idempotency store
4. **Status Filtering**: Failed/pending transactions are skipped

**Debugging**:
```powershell
# Run in dry run mode to see what would be processed
.\scripts\test-true-up.ps1 -From "2024-01-01" -DryRun $true -FunctionKey $key

# Check Azure Application Insights for logs
```

### Salesforce Connection Failed

**Cause**: Invalid Salesforce credentials or IP restrictions

**Solution**:
1. Verify `SALESFORCE_USERNAME` and `SALESFORCE_PASSWORD`
2. Add `SALESFORCE_SECURITY_TOKEN` if IP not whitelisted
3. Check Salesforce login URL (production vs sandbox)
4. Verify API permissions in Salesforce

### QuickBooks OAuth Errors

**Cause**: Expired or invalid OAuth tokens

**Solution**:
1. Check token expiration in `data/qbo-tokens/tokens.json`
2. Refresh tokens using QBO OAuth flow
3. Verify `QBO_CLIENT_ID` and `QBO_CLIENT_SECRET`
4. Check `QBO_REALM_ID` matches your company

### Idempotency Issues

**Cause**: Azure Tables connection problems

**Solution**:
1. Verify `AZURE_TABLES_CONNECTION_STRING`
2. Check Azure Storage account is accessible
3. Ensure table exists (created automatically on first run)
4. For testing, set `DISABLE_AZURE_TABLES=1` to use in-memory store

---

## Best Practices

### 1. Always Start with Dry Run
```powershell
# Test first
.\scripts\test-true-up.ps1 -From "2024-01-01" -DryRun $true -FunctionKey $key

# Review output, then run for real
.\scripts\test-true-up.ps1 -From "2024-01-01" -DryRun $false -FunctionKey $key
```

### 2. Start with Small Date Ranges
```powershell
# Good: One month at a time
.\scripts\test-true-up.ps1 -From "2024-01-01" -To "2024-01-31" -FunctionKey $key

# Avoid: Entire year at once (first time)
# .\scripts\test-true-up.ps1 -From "2024-01-01" -To "2024-12-31" -FunctionKey $key
```

### 3. Process Each Type Separately
```powershell
# Process payments first
.\scripts\test-true-up.ps1 -From "2024-01-01" -Type payments -FunctionKey $key

# Then refunds
.\scripts\test-true-up.ps1 -From "2024-01-01" -Type refunds -FunctionKey $key

# Finally payouts
.\scripts\test-true-up.ps1 -From "2024-01-01" -Type payouts -FunctionKey $key
```

### 4. Monitor Progress
- Check Application Insights for real-time logs
- Review response counts after each run
- Verify transactions in Salesforce and QBO

### 5. Schedule Regular Syncs
```powershell
# For ongoing sync, run monthly
# January 2024
.\scripts\test-true-up.ps1 -From "2024-01-01" -To "2024-01-31" -Type payments -FunctionKey $key

# February 2024
.\scripts\test-true-up.ps1 -From "2024-02-01" -To "2024-02-29" -Type payments -FunctionKey $key
```

---

## Performance Considerations

### Batch Size
- The function fetches up to 100 transactions per API call
- Processes up to 1,000 transactions per execution
- For large datasets (>1000), run multiple times with smaller date ranges

### Timeout
- Azure Functions have a 5-minute timeout by default
- For large datasets, increase timeout or split into smaller batches
- Consider using Durable Functions for very large syncs

### Rate Limits
- **Stripe**: 100 requests/second (burst), careful with large datasets
- **Salesforce**: 15,000 API calls/day (varies by edition)
- **QuickBooks**: 500 requests/minute

---

## Security Checklist

- [ ] All environment variables are stored in Azure Configuration (not in code)
- [ ] Function keys are rotated regularly
- [ ] Salesforce security token is set if IP not whitelisted
- [ ] QBO OAuth tokens are stored securely
- [ ] Application Insights is enabled for audit logs
- [ ] Access to Azure Function App is restricted to authorized users
- [ ] HTTPS is enforced (Azure Functions default)

---

## Support and Monitoring

### Application Insights Queries

**View Recent True-Up Executions**:
```kusto
traces
| where message contains "StripeTrueUp"
| order by timestamp desc
| take 50
```

**Find Errors**:
```kusto
exceptions
| where operation_Name == "stripeTrueUp"
| order by timestamp desc
```

**Monitor Performance**:
```kusto
requests
| where name == "stripeTrueUp"
| summarize avg(duration), count() by bin(timestamp, 1h)
```

### Health Monitoring

Set up alerts in Azure Monitor for:
- Function execution failures
- High error rates
- Long execution times (>2 minutes)
- Missing environment variables

---

## Appendix: Complete Example Workflow

```powershell
# 1. Set your function key
$functionKey = "your-function-key-here"

# 2. Test connection with dry run
.\scripts\test-true-up.ps1 `
  -From "2024-01-01" `
  -To "2024-01-31" `
  -Type payments `
  -DryRun $true `
  -FunctionKey $functionKey

# 3. Review output - should see:
# - fetched: X
# - processed: X
# - skipped: X
# - errors: 0

# 4. Run for real
.\scripts\test-true-up.ps1 `
  -From "2024-01-01" `
  -To "2024-01-31" `
  -Type payments `
  -DryRun $false `
  -FunctionKey $functionKey

# 5. Verify in Salesforce
# - Check Transaction records
# - Verify posted_to_qbo__c = true

# 6. Verify in QuickBooks
# - Check Sales Receipts or Journal Entries
# - Verify dates match original Stripe transactions

# 7. Process refunds
.\scripts\test-true-up.ps1 `
  -From "2024-01-01" `
  -To "2024-01-31" `
  -Type refunds `
  -DryRun $false `
  -FunctionKey $functionKey

# 8. Process payouts
.\scripts\test-true-up.ps1 `
  -From "2024-01-01" `
  -To "2024-01-31" `
  -Type payouts `
  -DryRun $false `
  -FunctionKey $functionKey
```

---

## Next Steps

After successful deployment:

1. **Test Thoroughly**: Run dry runs for different date ranges
2. **Verify Data**: Check Salesforce and QBO for accuracy
3. **Document**: Keep records of what date ranges have been synced
4. **Automate**: Consider scheduling regular syncs (weekly/monthly)
5. **Monitor**: Set up alerts for failures

## Getting Help

If you encounter issues:
1. Check Application Insights logs in Azure Portal
2. Review this guide's Troubleshooting section
3. Verify all environment variables are set correctly
4. Test with `dryRun=true` first
5. Check Stripe, Salesforce, and QBO API status pages
