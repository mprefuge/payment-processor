# Environment Variable Corrections

## ⚠️ Important: Variable Name Changes

This document clarifies the **correct** environment variable names to use based on the actual codebase implementation in `src/config/env.ts`.

---

## 🔧 What Was Fixed

Previously, the documentation incorrectly referenced `INTUIT_*` variables. These are **NOT used** in the codebase.

### ❌ Old (Incorrect) Documentation
```bash
INTUIT_CLIENT_ID=your-client-id
INTUIT_CLIENT_SECRET=your-client-secret
INTUIT_REDIRECT_URI=https://your-app.com/callback
```

### ✅ Correct Variables (Now Fixed)
```bash
QBO_CLIENT_ID=your-client-id
QBO_CLIENT_SECRET=your-client-secret
QBO_REALM_ID=your-company-id
QBO_REFRESH_TOKEN=your-refresh-token
```

---

## 📋 Complete Mapping

| Incorrect Variable | Correct Variable | Notes |
|--------------------|------------------|-------|
| `INTUIT_CLIENT_ID` | `QBO_CLIENT_ID` | QuickBooks OAuth Client ID |
| `INTUIT_CLIENT_SECRET` | `QBO_CLIENT_SECRET` | QuickBooks OAuth Client Secret |
| `INTUIT_REDIRECT_URI` | ❌ Not needed | OAuth handled internally |
| - | `QBO_REALM_ID` | QuickBooks Company/Realm ID (required) |
| - | `QBO_REFRESH_TOKEN` | OAuth refresh token (required) |

---

## 🎯 Why This Matters

The application's centralized configuration system in `src/config/env.ts` defines which environment variables are actually read and validated. Using incorrect variable names will cause:

1. **Environment validation failures** - `validateEnvironment()` checks for the correct names
2. **QuickBooks sync failures** - The QBO service won't have credentials
3. **Startup errors** - Missing required variables will prevent the function from starting

---

## ✅ Files Updated

The following files have been corrected to use the proper variable names:

### Code Files
- ✅ `src/handlers/stripeTrueUp.ts` - `validateEnvironment()` function

### Documentation
- ✅ `docs/STRIPE_TRUE_UP_DEPLOYMENT_GUIDE.md` - All QBO sections
- ✅ `docs/QUICK_START_CHECKLIST.md` - QuickBooks checklist items
- ✅ `docs/ENVIRONMENT_VARIABLES.md` - Complete reference (NEW)

---

## 🔍 How to Verify

You can verify the correct variable names by checking:

1. **Source Code**: `src/config/env.ts` lines 200-250
   ```typescript
   const quickBooksRaw = {
     // ...
     clientId: resolveEnv('QBO_CLIENT_ID'),
     clientSecret: resolveEnv('QBO_CLIENT_SECRET'),
     // ...
   ```

2. **Local Template**: `local.settings.json.template`
   ```json
   {
     "Values": {
       "QBO_CLIENT_ID": "your_qbo_client_id_here",
       "QBO_CLIENT_SECRET": "your_qbo_client_secret_here",
       "QBO_REALM_ID": "your_qbo_realm_id_here"
     }
   }
   ```

3. **Existing Usage**: Search the codebase
   ```powershell
   # Find QBO_CLIENT_ID usage
   git grep "QBO_CLIENT_ID"
   
   # Try to find INTUIT_CLIENT_ID usage (should find nothing in code)
   git grep "INTUIT_CLIENT_ID"
   ```

---

## 📚 Additional Notes

### Salesforce Variables
The codebase supports **both** naming conventions:
- Modern: `SF_USERNAME`, `SF_PASSWORD`, etc.
- Legacy: `SALESFORCE_USERNAME`, `SALESFORCE_PASSWORD`, etc.

Both work, but `SF_*` is preferred for consistency.

### Variable Fallback System
The `resolveEnv()` function in `src/config/env.ts` supports fallback variable names:

```typescript
// Example: Tries QBO_REALM_ID first, then QBO_COMPANY_ID
realmId: resolveEnv('QBO_REALM_ID', {
  fallbackNames: ['QBO_COMPANY_ID'],
})
```

This means some variables have aliases that work interchangeably.

---

## 🚀 Next Steps

1. **Update Azure Configuration**:
   - Go to Azure Portal → Function App → Configuration
   - Remove any `INTUIT_*` variables (if present)
   - Add correct `QBO_*` variables

2. **Deploy Updated Code**:
   ```powershell
   func azure functionapp publish payment-processing-function
   ```

3. **Test**:
   ```powershell
   # Should now pass environment validation
   .\scripts\test-true-up.ps1 -From "2024-01-01" -To "2024-01-31" -Type payments -DryRun $true -FunctionKey $functionKey
   ```

---

## 📖 Related Documentation

- `docs/ENVIRONMENT_VARIABLES.md` - Complete environment variable reference
- `docs/STRIPE_TRUE_UP_DEPLOYMENT_GUIDE.md` - Full deployment guide
- `docs/QUICK_START_CHECKLIST.md` - Quick setup checklist
- `src/config/env.ts` - Source of truth for configuration
- `local.settings.json.template` - Local development template

---

## ✏️ Summary

**Problem**: Documentation referenced non-existent `INTUIT_*` variables  
**Root Cause**: Codebase actually uses `QBO_*` variables via centralized config  
**Solution**: Updated code validation and all documentation to use correct names  
**Result**: Consistent variable names across codebase, code, and documentation  

**Key Takeaway**: Always use `QBO_*` prefixed variables for QuickBooks, NOT `INTUIT_*`.
