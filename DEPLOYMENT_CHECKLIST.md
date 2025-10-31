# Production Deployment Checklist

## Pre-Deployment Validation

### Code Quality
- [x] All tests passing (104 tests)
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
- [ ] Map account IDs (Stripe Clearing, Operating Bank, Revenue, Fees)
- [ ] Set posting strategy (sales-receipt or je-transfer)

### Salesforce CRM (Optional)
- [ ] Create Connected App in Salesforce
- [ ] Configure OAuth settings
- [ ] Obtain credentials (username, password, security token)
- [ ] Create custom fields on Contact object:
  - Stripe_Customer_ID__c
- [ ] Create custom object: Transactions__c with required fields
- [ ] Set up Campaign object access

### SendGrid Email (Optional)
- [ ] Create SendGrid account
- [ ] Generate API key
- [ ] Configure sender email address
- [ ] Verify sender domain

### Azure Storage
- [ ] Configure Azure Storage connection for idempotency
- [ ] Create required tables:
  - TransactionIdempotency
  - StripeWebhookEvents

## Environment Variables

### Required (Core)
```
STRIPE_TEST_SECRET_KEY=sk_test_...
STRIPE_LIVE_SECRET_KEY=sk_live_...
STRIPE_WEBHOOK_SECRET_TEST=whsec_...
STRIPE_WEBHOOK_SECRET_LIVE=whsec_...
FUNCTIONS_WORKER_RUNTIME=node
AzureWebJobsStorage=<connection_string>
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
SALESFORCE_USERNAME=user@example.com
SALESFORCE_PASSWORD=password
SALESFORCE_SECURITY_TOKEN=token
SALESFORCE_LOGIN_URL=https://login.salesforce.com

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

# Accounting
ACCOUNTING_POSTING_STRATEGY=sales-receipt
ACCOUNTING_SYNC_ENABLED=true
DEFAULT_SALES_ITEM=Donation

# Application Insights
APPINSIGHTS_INSTRUMENTATIONKEY=...
```

## Deployment Steps

### 1. Build and Test
```bash
npm install
npm run build
npm test
npm run typecheck
```

### 2. Deploy to Azure
```bash
# Login to Azure
az login

# Deploy function app
func azure functionapp publish <your-function-app-name>
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

## Post-Deployment Validation

### Function Endpoints
- [ ] `/api/health` - Returns 200 with service health
- [ ] `/api/transaction` - Creates checkout session
- [ ] `/api/stripe/webhook` - Processes Stripe events
- [ ] `/api/stripe/payout-sync` - Syncs payouts to QBO
- [ ] `/api/qbo/manual-sync` - Manual QBO sync
- [ ] `/api/stripe/true-up` - Stripe reconciliation

### Integration Testing
- [ ] Create test checkout session
- [ ] Complete test payment
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

**Deployment Date**: _______________  
**Deployed By**: _______________  
**Version**: _______________  
**Notes**: _______________
