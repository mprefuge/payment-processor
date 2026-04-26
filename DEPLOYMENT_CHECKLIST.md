# Production Deployment Checklist

## Go-Live Punch List

Complete these items before calling a deployment production-ready:

- [ ] Set `TEST_MODE=false`
- [ ] Set real `SUCCESS_URL` and `CANCEL_URL`
- [ ] Configure Stripe API and webhook secrets using `STRIPE_SECRET` / `STRIPE_WEBHOOK_SECRET` or their supported live/test fallbacks
- [ ] If Salesforce is enabled, set `CRM_PROVIDER=salesforce`, `SF_AUTH_MODE=client-credentials`, `SF_CLIENT_ID`, and `SF_CLIENT_SECRET`
- [ ] If QuickBooks sync is enabled, set `ACCOUNTING_SYNC_ENABLED=true`, `QBO_REALM_ID`, `QBO_CLIENT_ID`, `QBO_CLIENT_SECRET`, and `QBO_REFRESH_TOKEN` or pre-seed the token store
- [ ] Map all QuickBooks accounts, including refunds and disputes: `QBO_ACCOUNT_STRIPE_CLEARING`, `QBO_ACCOUNT_OPERATING_BANK`, `QBO_ACCOUNT_REVENUE`, `QBO_ACCOUNT_FEES`, `QBO_ACCOUNT_REFUNDS`, `QBO_ACCOUNT_DISPUTES`
- [ ] Set `QBO_DEFAULT_SALES_ITEM` if the default sales item should not remain `Stripe Transaction`
- [ ] Provide `AZURE_TABLES_CONNECTION_STRING` or `AZURE_STORAGE_CONNECTION_STRING`
- [ ] Ensure `DISABLE_AZURE_TABLES` is not `1` in production
- [ ] Provide `APPLICATIONINSIGHTS_CONNECTION_STRING` or an App Insights instrumentation key fallback
- [ ] Deploy to a staging slot first and run smoke tests for health, checkout creation, webhook handling, and accounting sync
- [ ] Confirm rollback path before slot swap or production publish

## Pre-Deployment Validation

### Code Quality

- [x] All tests passing
- [x] TypeScript compilation successful
- [x] No linting errors
- [x] Code formatted with Prettier
- [x] Build process completes successfully

### Configuration Files

- [x] `host.json` - Azure Functions runtime configuration
- [x] `package.json` - Dependencies and scripts
- [x] `tsconfig.json` - TypeScript compiler options
- [x] `local.settings.json.template` - Environment variable template

## Environment Setup

### Azure Configuration

- [ ] Create Azure Function App (Node.js 20.x runtime)
- [ ] Configure App Settings from `local.settings.json.template`
- [ ] Enable Application Insights
- [ ] Configure deployment credentials
- [ ] Set up deployment slots (staging/production)
- [ ] Create GitHub environments named `staging` and `production`
- [ ] Add production environment protection rules or required reviewers before enabling auto-promotion
- [ ] Add GitHub Actions secrets `AZURE_FUNCTIONAPP_STAGING_PUBLISH_PROFILE` and `AZURE_FUNCTIONAPP_PRODUCTION_PUBLISH_PROFILE`
- [ ] Add GitHub Actions secrets `AZURE_FUNCTIONAPP_STAGING_FUNCTION_KEY` and `AZURE_FUNCTIONAPP_PRODUCTION_FUNCTION_KEY` for smoke tests against function-auth endpoints
- [ ] Add GitHub Actions secrets `AZURE_FUNCTIONAPP_STAGING_SMOKE_TRANSACTION_PAYLOAD` and `AZURE_FUNCTIONAPP_PRODUCTION_SMOKE_TRANSACTION_PAYLOAD` for deploy-time test transactions
- [ ] Add GitHub Actions variables `AZURE_FUNCTIONAPP_STAGING_URL` and `AZURE_FUNCTIONAPP_PRODUCTION_URL` if the default slot URLs are not used

### Stripe Integration

- [ ] Obtain Stripe Test & Live API keys
- [ ] Create webhook endpoints in Stripe Dashboard
- [ ] Configure webhook secrets (test & live)
- [ ] Test webhook signature verification
- [ ] Enable required webhook events:
  - payment_intent.succeeded
  - payment_intent.payment_failed
  - invoice.paid
  - invoice.payment_failed
  - charge.refunded
  - payout.paid
  - payout.failed

### QuickBooks Online (Optional)

- [ ] Create QuickBooks app in developer portal
- [ ] Obtain Client ID and Client Secret
- [ ] Configure OAuth redirect URI
- [ ] Complete OAuth flow to get refresh token
- [ ] Map account IDs (Stripe Clearing, Operating Bank, Revenue, Fees, Refunds, Dispute Losses)
- [ ] Set posting strategy (sales-receipt or je-transfer)

### Salesforce CRM (Optional)

- [ ] Create Connected App in Salesforce
- [ ] Configure client-credentials auth for the Connected App
- [ ] Obtain `SF_CLIENT_ID` and `SF_CLIENT_SECRET`
- [ ] Create custom fields on Contact object:
  - Stripe_Customer_ID\_\_c
- [ ] Create custom object: Transaction\_\_c with required fields
- [ ] Set up Campaign object access

### SendGrid Email (Optional)

- [ ] Create SendGrid account
- [ ] Generate API key
- [ ] Configure sender email address
- [ ] Verify sender domain

### Azure Storage

- [ ] Configure Azure Storage connection for idempotency
- [ ] Confirm the app can create/use `IdempotencyState` and `TransactionIdempotency` tables
- [ ] If overriding defaults, set `IDEMPOTENCY_TABLE_NAME` and/or `TRANSACTION_IDEMPOTENCY_TABLE`

## Environment Variables

### Required (Core)

```
STRIPE_SECRET=sk_live_...   # or use STRIPE_LIVE_SECRET_KEY / STRIPE_TEST_SECRET_KEY
STRIPE_WEBHOOK_SECRET=whsec_...   # or use STRIPE_WEBHOOK_SECRET_LIVE / _TEST
SUCCESS_URL=https://yourdomain.com/thankyou
CANCEL_URL=https://yourdomain.com/donate
TEST_MODE=false
FUNCTIONS_WORKER_RUNTIME=node
AzureWebJobsStorage=<connection_string>
AZURE_TABLES_CONNECTION_STRING=<connection_string>
APPLICATIONINSIGHTS_CONNECTION_STRING=InstrumentationKey=...;IngestionEndpoint=...
```

### Optional (Features)

```
# SendGrid
SENDGRID_API_KEY=SG...
NOTIFICATION_EMAIL_FROM=noreply@yourdomain.com
NOTIFICATION_EMAIL_TEST=test@yourdomain.com
NOTIFICATION_EMAIL_LIVE=live@yourdomain.com

# Salesforce
CRM_PROVIDER=salesforce
SF_AUTH_MODE=client-credentials
SF_CLIENT_ID=...
SF_CLIENT_SECRET=...
SF_LOGIN_URL=https://login.salesforce.com
SALESFORCE_CONTACT_LEAD_SOURCE=Online Transaction

# QuickBooks
QBO_ENV=production
QBO_REALM_ID=...
QBO_CLIENT_ID=...
QBO_CLIENT_SECRET=...
QBO_REFRESH_TOKEN=...
QBO_ACCOUNT_STRIPE_CLEARING=Stripe Clearing|123
QBO_ACCOUNT_OPERATING_BANK=Operating Bank|456
QBO_ACCOUNT_REVENUE=Revenue|789
QBO_ACCOUNT_FEES=Stripe Fees|012
QBO_ACCOUNT_REFUNDS=Refunds|345
QBO_ACCOUNT_DISPUTES=Dispute Losses|678
QBO_DEFAULT_SALES_ITEM=Donation|901

# Accounting
ACCOUNTING_POSTING_STRATEGY=sales-receipt
ACCOUNTING_SYNC_ENABLED=true
ACCOUNTING_AUTOCREATE_ACCOUNTS=false

# Application Insights
APPLICATIONINSIGHTS_CONNECTION_STRING=InstrumentationKey=...;IngestionEndpoint=...
```

## Deployment Steps

### 1. Build and Test

```bash
npm install
npm run format:check
npm run build
npm run ci
```

### 2. Deploy to Staging First

```bash
# Login to Azure
az login

# Deploy function app to staging slot
func azure functionapp publish <your-function-app-name> --slot staging
```

### 3. Configure Application Settings

```bash
# Set environment variables in Azure
az functionapp config appsettings set \
  --name <your-function-app-name> \
  --resource-group <your-resource-group> \
  --settings @production.settings.json
```

### 4. Verify Deployment

- [ ] Check function app is running
- [ ] Test health check endpoint: `GET /api/health`
- [ ] Verify all integrations are healthy
- [ ] Test transaction endpoint with test payment
- [ ] Verify webhook endpoint responds correctly
- [ ] Check Application Insights for logs
- [ ] Run at least one staging Stripe checkout + webhook flow end-to-end
- [ ] If QuickBooks is enabled, run a staging accounting sync and verify the posted document
- [ ] If Salesforce is enabled, verify contact and transaction creation/update behavior
- [ ] Confirm the GitHub Actions `smoke-test-staging` job passes before production approval
- [ ] Confirm the GitHub Actions `smoke-test-production` job passes and that the tagged cleanup step removes the deploy-time test artifacts

### 5. Promote to Production

- [ ] Swap staging to production or publish only after staging validation is complete
- [ ] Confirm rollback command works before cutover
- [ ] Approve the `production` GitHub environment only after staging smoke checks pass

## Post-Deployment Validation

### Function Endpoints

- [ ] `/api/health` - Returns 200 with service health
- [ ] `/api/transaction` - Creates checkout session
- [ ] `/api/stripe/webhook` - Processes Stripe events
- [ ] `/api/stripe/payout-sync` - Syncs payouts to QBO
- [ ] `/api/qbo/manual-sync` - Manual QBO sync
- [ ] `/api/stripe/true-up` - Stripe reconciliation
- [ ] `/api/ops/test-artifact-cleanup` - Tagged deploy-time artifact cleanup

### Integration Testing

- [ ] Create test checkout session
- [ ] Complete test payment
- [ ] Run deploy-time tagged checkout smoke test and confirm cleanup deletes the test Stripe, Salesforce, and QuickBooks artifacts
- [ ] Verify webhook processing
- [ ] Check Salesforce transaction creation
- [ ] Verify QuickBooks sync
- [ ] Test refund processing
- [ ] Test payout processing

### Monitoring

- [ ] Configure Application Insights alerts
- [ ] Set up monitoring dashboard
- [ ] Configure error notifications
- [ ] Set up performance metrics
- [ ] Enable diagnostic logging

## Security Checklist

- [ ] All secrets stored in Azure Key Vault or App Settings
- [ ] No hardcoded credentials in code
- [ ] Function endpoints use appropriate auth levels
- [ ] Webhook signature verification enabled
- [ ] HTTPS enforced for all endpoints
- [ ] Secret redaction enabled in logs
- [ ] Rate limiting configured
- [ ] CORS configured appropriately

## Rollback Plan

- [ ] Document current production version
- [ ] Keep previous deployment slot active
- [ ] Test rollback procedure
- [ ] Have manual rollback commands ready:

```bash
# Swap deployment slots
az functionapp deployment slot swap \
  --name <app-name> \
  --resource-group <rg-name> \
  --slot staging
```

## Support and Maintenance

- [ ] Document known issues
- [ ] Create runbook for common operations
- [ ] Set up on-call rotation
- [ ] Document escalation procedures
- [ ] Schedule regular dependency updates
- [ ] Plan for monitoring and maintenance windows

## Final Checks

- [ ] All environment variables configured
- [ ] All tests passing in production environment
- [ ] Webhook endpoints configured in Stripe
- [ ] Monitoring and alerting active
- [ ] Documentation updated
- [ ] Team trained on new features
- [ ] Support contacts documented
- [ ] Rollback procedure tested

---

**Deployment Date**: **\*\***\_\_\_**\*\***
**Deployed By**: **\*\***\_\_\_**\*\***
**Version**: **\*\***\_\_\_**\*\***
**Notes**: **\*\***\_\_\_**\*\***
