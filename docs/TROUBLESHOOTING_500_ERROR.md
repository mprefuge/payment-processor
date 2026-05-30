# Fixing 500 Internal Server Error

## Problem
Getting a 500 Internal Server Error with no response body when calling the Stripe True-Up endpoint.

## Root Cause
The `src/config/env.ts` file throws an error during module load if required environment variables are missing. This happens **before** the Azure Function handler can even run, which is why you get a 500 error with no custom error message.

## What Triggers This?
The `env.ts` file has conditional requirements based on your configuration:

### Always Required:
- `STRIPE_SECRET` (or `STRIPE_LIVE_SECRET_KEY` / `STRIPE_TEST_SECRET_KEY`)
- `STRIPE_WEBHOOK_SECRET` (or variants)

### Required if `ACCOUNTING_SYNC_ENABLED=true`:
- `QBO_CLIENT_ID`
- `QBO_CLIENT_SECRET`
- `QBO_REALM_ID` (or `QBO_COMPANY_ID`)
- `QBO_REFRESH_TOKEN`

### Required if `SF_AUTH_MODE=username-password`:
- `SF_USERNAME` (or `SALESFORCE_USERNAME`)
- `SF_PASSWORD` (or `SALESFORCE_PASSWORD`)

### Required if `SF_AUTH_MODE=jwt`:
- `SF_CLIENT_ID`
- `SF_USERNAME`
- `SF_JWT_PRIVATE_KEY`

## Solution Applied

I've updated `stripeTrueUp.ts` to gracefully handle `env.ts` loading failures:

```typescript
// Try to import env config, but don't fail if it's incomplete
let env: any = { stripe: { secret: '' } };
try {
  env = require('../config/env').default;
} catch (error) {
  console.warn('[StripeTrueUp] env.ts failed to load, will use environment variables directly:', error);
}
```

This means the true-up handler will now:
1. Try to load the centralized config
2. If it fails (missing vars), fall back to reading `process.env` directly
3. Still run its own `validateEnvironment()` check and return a proper error message

## Deployment Steps

### 1. Deploy the Fix
```powershell
npm run build
func azure functionapp publish payment-processing-function
```

### 2. Check Your Azure Configuration

**Option A: Set ACCOUNTING_SYNC_ENABLED=false** (if you don't need QuickBooks)
```bash
az functionapp config appsettings set \
  --name payment-processing-function \
  --resource-group YOUR_RESOURCE_GROUP \
  --settings ACCOUNTING_SYNC_ENABLED=false
```

**Option B: Add Missing QBO Variables** (if ACCOUNTING_SYNC_ENABLED=true)
```bash
az functionapp config appsettings set \
  --name payment-processing-function \
  --resource-group YOUR_RESOURCE_GROUP \
  --settings \
    QBO_CLIENT_ID="your-client-id" \
    QBO_CLIENT_SECRET="your-client-secret" \
    QBO_REALM_ID="your-realm-id" \
    QBO_REFRESH_TOKEN="your-refresh-token"
```

### 3. Restart the Function App (if needed)
```bash
az functionapp restart --name payment-processing-function --resource-group YOUR_RESOURCE_GROUP
```

### 4. Test
```powershell
Invoke-WebRequest -Uri "https://payment-processing-function.azurewebsites.net/api/stripe/true-up?from=2025-01-01&to=2025-10-25&type=payments&dryRun=true&code=YOUR_FUNCTION_KEY" -Method GET
```

## How to Diagnose

### Check What's Set in Azure
```bash
# Login first
az login

# List all settings
az functionapp config appsettings list \
  --name payment-processing-function \
  --resource-group YOUR_RESOURCE_GROUP \
  --query "[].{Name:name, Value:value}" \
  --output table
```

### Check Specific Variables
```bash
az functionapp config appsettings list \
  --name payment-processing-function \
  --resource-group YOUR_RESOURCE_GROUP \
  --query "[?name=='ACCOUNTING_SYNC_ENABLED' || name=='QBO_CLIENT_ID' || name=='QBO_CLIENT_SECRET'].{Name:name, Value:value}" \
  --output table
```

### View Live Logs
1. Go to Azure Portal
2. Navigate to your Function App
3. Select **Log stream** under Monitoring
4. Make a request and watch for errors

### Check Application Insights
1. Go to Azure Portal → Application Insights
2. Go to **Logs**
3. Run query:
```kusto
traces
| where timestamp > ago(1h)
| where message contains "StripeTrueUp"
| project timestamp, message, severityLevel
| order by timestamp desc
```

## Common Scenarios

### Scenario 1: ACCOUNTING_SYNC_ENABLED=true but no QBO vars
**Error**: 500 during module load
**Fix**: Either set QBO vars OR set `ACCOUNTING_SYNC_ENABLED=false`

### Scenario 2: SF_AUTH_MODE=username-password but no Salesforce password
**Error**: 500 during module load  
**Fix**: Either set Salesforce vars OR set `SF_AUTH_MODE=disabled`

### Scenario 3: Missing STRIPE_WEBHOOK_SECRET
**Error**: 500 during module load
**Fix**: Set `STRIPE_WEBHOOK_SECRET` (or `STRIPE_WEBHOOK_SECRET_TEST`/`STRIPE_WEBHOOK_SECRET_LIVE`)

### Scenario 4: Old code still deployed
**Error**: Still getting 500 after fixing vars
**Fix**: Run `func azure functionapp publish payment-processing-function`

## After the Fix

Once deployed with the updated code, if environment variables are missing, you'll get a proper JSON error response like:

```json
{
  "error": "configuration_error",
  "message": "Required environment variables are not configured.",
  "details": [
    "STRIPE_TEST_SECRET_KEY is not configured for test mode",
    "QBO_CLIENT_ID is not configured (QuickBooks sync will fail)"
  ]
}
```

This is much better than a blank 500 error!

## Prevention

To avoid this in the future:

1. **Use the checklist**: `docs/QUICK_START_CHECKLIST.md`
2. **Check env vars**: `docs/ENVIRONMENT_VARIABLES.md`
3. **Set optional features to disabled** if not needed:
   - `ACCOUNTING_SYNC_ENABLED=false`
   - `SF_AUTH_MODE=disabled`
4. **Test locally first**: Use `local.settings.json` to test with minimal config

## Related Files

- `src/config/env.ts` - Centralized configuration that validates on load
- `src/handlers/stripeTrueUp.ts` - Now handles env.ts loading errors gracefully
- `docs/ENVIRONMENT_VARIABLES.md` - Complete list of all variables
- `docs/QUICK_START_CHECKLIST.md` - Deployment checklist
