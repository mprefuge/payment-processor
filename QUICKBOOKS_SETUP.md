# QuickBooks Online Integration Setup Guide

This guide explains how to configure and use the QuickBooks Online (QBO) integration for posting journal entries, transfers, and deposits from Stripe payouts directly to your QuickBooks Online account.

## Overview

The QuickBooks provider enables:
- **Automatic posting** of Stripe payout data to QuickBooks Online
- **Journal entries** for revenue recognition and fee tracking
- **Bank transfers** between clearing and operating accounts
- **Bank deposits** as an alternative to transfers
- **OAuth 2.0 authentication** with automatic token refresh
- **Idempotent operations** to prevent duplicate entries
- **Real-time connectivity checks**

## Prerequisites

Before you begin, you'll need:

1. **QuickBooks Online Account** (sandbox or production)
2. **QuickBooks Developer Account** to create an app and get OAuth credentials
3. **Access tokens** obtained through QuickBooks OAuth 2.0 flow
4. **Azure Function App** or local development environment

## Step 1: Create QuickBooks Developer App

1. Go to [QuickBooks Developer Portal](https://developer.intuit.com/)
2. Sign in and create a new app
3. Note your **Client ID** and **Client Secret**
4. Configure the OAuth redirect URI (e.g., `https://your-domain.com/oauth/callback`)
5. Select the required scopes:
   - `com.intuit.quickbooks.accounting`

## Step 2: Obtain OAuth Tokens

You need to implement an OAuth 2.0 flow to get access and refresh tokens. Here's a simplified example:

```javascript
// Example OAuth flow (implement in your app)
const authUri = `https://appcenter.intuit.com/connect/oauth2?client_id=${CLIENT_ID}&response_type=code&scope=com.intuit.quickbooks.accounting&redirect_uri=${REDIRECT_URI}&state=${STATE}`;

// After user authorizes, exchange code for tokens
const tokenResponse = await fetch('https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer', {
  method: 'POST',
  headers: {
    'Authorization': `Basic ${Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64')}`,
    'Content-Type': 'application/x-www-form-urlencoded'
  },
  body: `grant_type=authorization_code&code=${AUTH_CODE}&redirect_uri=${REDIRECT_URI}`
});

const { access_token, refresh_token, realmId } = await tokenResponse.json();
```

## Step 3: Configure Environment Variables

Add these environment variables to your Azure Function App settings or `local.settings.json`:

### Required Variables

```bash
# QuickBooks Configuration
QBO_COMPANY_ID=1234567890           # Your QuickBooks company/realm ID
QBO_ENVIRONMENT=sandbox             # 'sandbox' or 'production'
QBO_CLIENT_ID=ABxxxxxxxxxxxxxxxx    # From developer portal
QBO_CLIENT_SECRET=xxxxxxxxxxxxxxxx  # From developer portal
QBO_ACCESS_TOKEN=ey...              # OAuth access token
QBO_REFRESH_TOKEN=AB...             # OAuth refresh token
QBO_REALM_ID=1234567890             # Same as company ID

# Accounting Sync (already configured)
ACCOUNTING_SYNC_ENABLED=true
ACCOUNTING_PROVIDER=quickbooks

# Account Mappings
ACCOUNTING_STRIPE_CLEARING_ACCOUNT=Stripe Clearing
ACCOUNTING_REVENUE_ACCOUNT=Revenue
ACCOUNTING_REFUNDS_ACCOUNT=Refunds
ACCOUNTING_STRIPE_FEE_ACCOUNT=Stripe Fees
ACCOUNTING_CHARGEBACK_ACCOUNT=Chargebacks
ACCOUNTING_ADJUSTMENT_ACCOUNT=Adjustments
```

> ℹ️ The operating bank account name is fetched directly from Stripe based on the payout destination; no environment variable
> is required.

### Optional Variables

```bash
# Revenue mapping by category
ACCOUNTING_REVENUE_MAPPING=General Giving:Revenue - Donations,Building Fund:Revenue - Building

# Posting policy
ACCOUNTING_POSTING_GRANULARITY=per-payout
ACCOUNTING_POSTING_STRATEGY=je-transfer
ACCOUNTING_POSTING_DATE_SOURCE=arrival
ACCOUNTING_TIMEZONE=America/New_York
```

## Step 4: Create Chart of Accounts in QuickBooks

The integration can automatically create missing accounts, but it's recommended to create them manually first:

1. **Stripe Clearing** (Bank account, type: Cash on Hand)
2. **Operating Bank** (Bank account, type: Checking)
3. **Revenue** (Income account)
4. **Refunds** (Expense account)
5. **Stripe Fees** (Expense account)
6. **Chargebacks** (Expense account)
7. **Adjustments** (Other Income or Expense)

## Step 5: Test the Integration

### Health Check

Test connectivity to QuickBooks:

```javascript
const QuickBooksProvider = require('./services/accounting/quickbooksProvider');
const AccountingSyncConfig = require('./services/accountingSyncConfig');

const config = new AccountingSyncConfig();
const providerConfig = config.getProviderConfig();
const provider = new QuickBooksProvider(providerConfig);

const health = await provider.healthCheck();
console.log('Health check:', health);
// Expected output:
// {
//   healthy: true,
//   message: 'QBO connection healthy',
//   details: {
//     provider: 'quickbooks',
//     environment: 'sandbox',
//     companyId: '1234567890',
//     companyName: 'Your Company Name'
//   }
// }
```

### Test Journal Entry

```javascript
const journalEntry = {
    docNumber: 'TEST-JE-001',
    date: new Date(),
    memo: 'Test journal entry',
    lines: [
        {
            type: 'debit',
            accountId: 'STRIPE_CLEARING_ACCOUNT_ID',
            amount: 100,
            description: 'Test debit'
        },
        {
            type: 'credit',
            accountId: 'REVENUE_ACCOUNT_ID',
            amount: 100,
            description: 'Test credit'
        }
    ]
};

const result = await provider.upsertJournalEntry(journalEntry);
console.log('Journal entry created:', result);
```

### Test with Stripe Webhook

Send a test payout.paid webhook to your endpoint to trigger the full sync flow.

## Step 6: Token Refresh

The provider automatically refreshes expired access tokens using the refresh token. When a token is refreshed:

1. The new access token is stored in memory
2. A warning is logged to persist the token to permanent storage
3. The QuickBooks client is reinitialized

**Important:** In production, implement token persistence:

```javascript
// After successful refresh
provider.on('tokenRefresh', async (newTokens) => {
    // Save to Azure Key Vault, environment variables, or database
    await saveTokens(newTokens);
});
```

## API Reference

### QuickBooksProvider

#### Constructor

```javascript
new QuickBooksProvider(config)
```

**Config parameters:**
- `companyId` (required): QuickBooks company/realm ID
- `environment` (optional): 'sandbox' or 'production' (default: 'sandbox')
- `oauthTokens` (required): Object with `accessToken` and `refreshToken`

#### Methods

##### `async healthCheck()`
Verifies connectivity to QuickBooks Online.

**Returns:** `{ healthy: boolean, message: string, details: object }`

##### `async ensureChartOfAccounts(accounts)`
Creates missing accounts in QuickBooks.

**Parameters:**
- `accounts`: Array of `{ name, type, subType }`

**Returns:** Object mapping account names to QuickBooks account IDs

##### `async upsertJournalEntry(journalEntry)`
Creates or retrieves an existing journal entry (idempotent).

**Parameters:**
- `docNumber` (required): Unique document number
- `date` (required): Transaction date
- `memo` (optional): Journal entry memo
- `lines` (required): Array of journal entry lines
  - `type`: 'debit' or 'credit'
  - `accountId`: QuickBooks account ID
  - `amount`: Line amount
  - `description`: Line description

**Returns:** Created/existing journal entry with QBO ID

##### `async upsertTransfer(transfer)`
Creates or retrieves an existing transfer (idempotent).

**Parameters:**
- `docNumber` (required): Unique document number
- `date` (required): Transfer date
- `fromAccountId` (required): Source account ID
- `toAccountId` (required): Destination account ID
- `amount` (required): Transfer amount
- `memo` (optional): Transfer memo

**Returns:** Created/existing transfer with QBO ID

##### `async upsertDeposit(deposit)`
Creates or retrieves an existing deposit (idempotent).

**Parameters:**
- `docNumber` (required): Unique document number
- `date` (required): Deposit date
- `toAccountId` (required): Deposit account ID
- `lines` (required): Array of deposit lines
  - `accountId`: Source account ID
  - `amount`: Line amount
  - `description`: Line description
- `memo` (optional): Deposit memo

**Returns:** Created/existing deposit with QBO ID

##### `async getAccount(accountId)`
Retrieves account details by ID.

**Returns:** Account object

##### `async findAccounts(criteria)`
Finds accounts by criteria.

**Parameters:**
- `name` (optional): Account name
- `type` (optional): Account type
- `subType` (optional): Account subtype

**Returns:** Array of matching accounts

##### `async refreshTokens()`
Refreshes the OAuth access token.

**Returns:** `true` on success

## Error Handling

All methods include comprehensive error handling:

```javascript
try {
    const result = await provider.upsertJournalEntry(journalEntry);
    console.log('Success:', result);
} catch (error) {
    console.error('Error:', error.message);
    // Common errors:
    // - 'QuickBooks client not initialized. Check configuration.'
    // - 'Journal entry lines do not balance'
    // - 'Failed to upsert journal entry: [API error]'
    // - 'No refresh token available'
}
```

## Troubleshooting

### "QuickBooks client not initialized"
**Cause:** Missing company ID or access token
**Fix:** Verify `QBO_COMPANY_ID` and `QBO_ACCESS_TOKEN` are set

### "Access token expired"
**Cause:** Token expired (tokens expire after 1 hour)
**Fix:** Provider automatically refreshes if refresh token is available

### "Journal entry lines do not balance"
**Cause:** Debits don't equal credits
**Fix:** Ensure total debits = total credits (within $0.01)

### "Account not found"
**Cause:** Invalid account ID
**Fix:** Use `findAccounts()` or `ensureChartOfAccounts()` to get valid IDs

### "Authentication failed"
**Cause:** Invalid tokens or expired refresh token
**Fix:** Re-authenticate through OAuth flow to get new tokens

## Production Checklist

- [ ] Use production QuickBooks environment (`QBO_ENVIRONMENT=production`)
- [ ] Store tokens securely (Azure Key Vault recommended)
- [ ] Implement token persistence after refresh
- [ ] Set up monitoring for failed API calls
- [ ] Configure account mappings for your specific chart of accounts
- [ ] Test with sample payout before going live
- [ ] Enable verbose logging for troubleshooting
- [ ] Set up alerts for authentication failures

## Security Best Practices

1. **Never commit tokens** to source control
2. **Use Azure Key Vault** or similar for token storage
3. **Rotate tokens regularly** by re-authenticating
4. **Use environment variables** for all sensitive data
5. **Monitor API calls** for unusual activity
6. **Implement rate limiting** to avoid API throttling
7. **Use HTTPS** for all OAuth redirects

## Support

For issues or questions:
- QuickBooks API Documentation: https://developer.intuit.com/app/developer/qbo/docs/api/accounting/most-commonly-used/journalentry
- node-quickbooks library: https://github.com/mcohen01/node-quickbooks
- Project Issues: [GitHub Issues](https://github.com/mprefuge/payment-processor/issues)

## License

This integration uses the MIT-licensed `node-quickbooks` library and follows QuickBooks API terms of service.
