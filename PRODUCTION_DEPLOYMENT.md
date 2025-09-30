# Production Deployment Checklist

This document provides a comprehensive checklist for deploying the payment processor to production.

## Pre-Deployment Checklist

### Environment Variables

Ensure all required environment variables are configured in your Azure Function App:

#### Required Variables
- [ ] `STRIPE_LIVE_SECRET_KEY` - Stripe live secret key
- [ ] `STRIPE_WEBHOOK_SECRET_LIVE` - Stripe live webhook signing secret
- [ ] `SENDGRID_API_KEY` - SendGrid API key for email notifications
- [ ] `NOTIFICATION_EMAIL_FROM` - Verified SendGrid sender email
- [ ] `NOTIFICATION_EMAIL_LIVE` - Email address for live transaction notifications
- [ ] `SUCCESS_URL` - URL to redirect after successful payment
- [ ] `CANCEL_URL` - URL to redirect after canceled payment

#### Optional Variables
- [ ] `DEBUG_EMAIL` - Email for debug notifications (leave empty for production)
- [ ] `STRIPE_TEST_SECRET_KEY` - Stripe test secret key (for testing in production env)
- [ ] `STRIPE_WEBHOOK_SECRET_TEST` - Stripe test webhook secret
- [ ] `NOTIFICATION_EMAIL_TEST` - Email for test notifications

#### CRM Integration (if using Salesforce)
- [ ] `CRM_PROVIDER` - Set to `salesforce`
- [ ] `SALESFORCE_USERNAME` - Salesforce username
- [ ] `SALESFORCE_PASSWORD` - Salesforce password
- [ ] `SALESFORCE_SECURITY_TOKEN` - Salesforce security token
- [ ] `SALESFORCE_LOGIN_URL` - Salesforce login URL (usually `https://login.salesforce.com`)

#### Contact Matching Configuration (optional)
- [ ] `CONTACT_MATCH_THRESHOLD_HIGH` - Default: `0.90`
- [ ] `CONTACT_MATCH_THRESHOLD_LOW` - Default: `0.60`
- [ ] `CONTACT_MATCH_REDACT_PII` - Default: `true`
- [ ] `TRANSACTION_DEFAULT_CATEGORY` - Default: `Uncategorized`

#### Production Environment
- [ ] `NODE_ENV` - Set to `production`
- [ ] `SUPPRESS_IDEMPOTENCY_WARNING` - Set to `true` only if using Redis/database

### SendGrid Setup
- [ ] Verify sender email address in SendGrid
- [ ] Ensure API key has send permissions
- [ ] Test email sending with test API call

### Stripe Setup
- [ ] Configure webhook endpoint in Stripe dashboard
  - URL: `https://your-function-app.azurewebsites.net/api/stripe/webhook`
  - Events: `payment_intent.succeeded`, `checkout.session.completed`, `payment_intent.payment_failed`, `checkout.session.expired`
- [ ] Copy webhook signing secret to environment variables
- [ ] Verify webhook is receiving events
- [ ] Test both test and live mode webhooks

### Salesforce Setup (if using)
- [ ] Create custom Transaction__c object (optional, falls back to Opportunity)
- [ ] Configure required fields on Transaction__c
- [ ] Ensure Salesforce user has create/update permissions
- [ ] Test Salesforce connection

### Security Considerations
- [ ] All secrets stored in Azure Key Vault or secure environment variables
- [ ] Application Insights enabled for monitoring
- [ ] Enable authentication on function endpoints (if applicable)
- [ ] Review CORS settings
- [ ] Verify no hardcoded credentials in code

### Idempotency Service
⚠️ **CRITICAL**: The current implementation uses in-memory storage for idempotency tracking.

**For Production:**
- [ ] Replace in-memory storage with persistent storage (Redis/database)
- [ ] Consider using Azure Cache for Redis
- [ ] Alternatively, set up Redis or database-backed idempotency
- [ ] Update IdempotencyService to use persistent storage
- [ ] Test idempotency across function restarts

**If you must use in-memory storage temporarily:**
- [ ] Understand that idempotency tracking will be lost on restart
- [ ] Set `SUPPRESS_IDEMPOTENCY_WARNING=true` to suppress warnings
- [ ] Plan migration to persistent storage

### Testing in Production
- [ ] Run test transactions in Stripe test mode
- [ ] Verify webhook signature validation
- [ ] Test CRM integration with test data
- [ ] Verify email notifications are sent
- [ ] Test error handling and logging
- [ ] Verify all URLs are correct (success, cancel, etc.)

### Monitoring and Alerting
- [ ] Enable Application Insights
- [ ] Set up alerts for errors and failures
- [ ] Configure log retention
- [ ] Set up dashboard for key metrics
- [ ] Test alert notifications

### Performance
- [ ] Review function timeout settings (default 5 minutes)
- [ ] Configure appropriate memory allocation
- [ ] Test under expected load
- [ ] Enable autoscaling if needed

### Documentation
- [ ] Document all environment variables
- [ ] Create runbook for common issues
- [ ] Document CRM object schemas
- [ ] Create incident response plan

## Post-Deployment Verification

### Smoke Tests
- [ ] Create test payment in live mode
- [ ] Verify webhook received and processed
- [ ] Check CRM for contact creation/update
- [ ] Verify transaction record created
- [ ] Confirm email notification sent
- [ ] Test payment failure scenario
- [ ] Test payment cancellation scenario

### Monitoring
- [ ] Check Application Insights for errors
- [ ] Review first 24 hours of logs
- [ ] Monitor webhook delivery success rate in Stripe
- [ ] Verify CRM integration success rate

### Rollback Plan
- [ ] Document rollback procedure
- [ ] Keep previous version available
- [ ] Test rollback in staging environment

## Known Limitations

### Idempotency Service
- Uses in-memory storage (not suitable for production at scale)
- Will lose tracking on application restart
- Not suitable for distributed/scaled deployments
- **Recommendation**: Implement Redis-based idempotency before production use

### Logging
- Sensitive data (email, phone) may appear in logs
- PII redaction is implemented in ContactMatcher but not all log points
- **Recommendation**: Review and enhance PII redaction across all logging

### Console Logging
- Some services use `console.log` instead of structured logging
- **Recommendation**: Migrate to Application Insights SDK for structured logging

## Recommended Production Enhancements

### High Priority
1. Implement persistent idempotency storage (Redis/database)
2. Add comprehensive PII redaction to all logging
3. Implement structured logging with Application Insights SDK
4. Add request rate limiting
5. Implement dead letter queue for failed webhooks

### Medium Priority
1. Add circuit breaker pattern for CRM integration
2. Implement retry logic with exponential backoff
3. Add health check endpoints
4. Implement feature flags for gradual rollout
5. Add performance monitoring and APM

### Low Priority
1. Implement webhook event replay mechanism
2. Add webhook event archival
3. Create admin dashboard for monitoring
4. Implement A/B testing framework
5. Add advanced analytics and reporting

## Support and Troubleshooting

### Common Issues

**Webhook signature verification fails**
- Verify webhook secret is correct for test/live mode
- Check that raw body is being sent (not parsed JSON)

**CRM integration fails**
- Verify Salesforce credentials
- Check security token is current
- Ensure user has required permissions
- Check network connectivity to Salesforce

**Emails not sending**
- Verify SendGrid API key
- Check sender email is verified
- Review SendGrid dashboard for errors

**Transactions not created**
- Check Application Insights logs
- Verify webhook events are being received
- Check CRM connection and permissions

### Getting Help
- Review Application Insights logs
- Check Stripe webhook delivery logs
- Review CRM audit logs
- Contact support team with error details

## Compliance and Security

### PCI Compliance
- ✅ Payment data never touches server (handled by Stripe)
- ✅ No credit card data stored or logged
- ✅ Webhook signatures verified

### Data Privacy
- ⚠️ Customer PII (email, phone, name) is processed
- ⚠️ PII may appear in logs
- ✅ PII redaction implemented in ContactMatcher
- **Recommendation**: Ensure compliance with GDPR, CCPA as applicable

### Security Best Practices
- ✅ No hardcoded credentials
- ✅ Environment variables for all secrets
- ✅ Webhook signature verification
- ⚠️ Function endpoints may need authentication
- **Recommendation**: Add API authentication if endpoints are public

## Maintenance

### Regular Tasks
- Review and rotate API keys quarterly
- Update dependencies monthly
- Review and archive old logs
- Monitor storage costs
- Review error rates and patterns

### Updates and Patches
- Test updates in staging environment first
- Schedule updates during low-traffic periods
- Have rollback plan ready
- Notify stakeholders of maintenance windows

---

Last Updated: 2025-09-30
