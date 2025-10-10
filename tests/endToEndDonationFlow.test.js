const assert = require('assert');
const { randomUUID } = require('crypto');
const Stripe = require('stripe');
const jsforce = require('jsforce');

const REQUIRED_ENV_SETS = {
    STRIPE_TEST_SECRET_KEY: ['STRIPE_TEST_SECRET_KEY'],
    STRIPE_WEBHOOK_SECRET: ['STRIPE_WEBHOOK_SECRET'],
    SALESFORCE_USERNAME: ['SALESFORCE_USERNAME'],
    SALESFORCE_PASSWORD: ['SALESFORCE_PASSWORD'],
    SALESFORCE_SECURITY_TOKEN: ['SALESFORCE_SECURITY_TOKEN'],
    QBO_ACCESS_TOKEN: ['QBO_ACCESS_TOKEN'],
    QBO_REALM_ID: ['QBO_REALM_ID']
};

const DEFAULT_STRIPE_API_VERSION = '2023-10-16';
const QUICKBOOKS_ENTITY_PATH = {
    'journal-entry': 'journalentry',
    'sales-receipt': 'salesreceipt',
    'bank-deposit': 'deposit'
};

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

const waitFor = async (fn, { attempts = 10, delay = 1000, timeoutMessage }) => {
    let lastError;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
        try {
            const result = await fn();
            if (result) {
                return result;
            }
        } catch (error) {
            lastError = error;
        }
        await sleep(delay);
    }

    if (lastError) {
        throw lastError;
    }

    throw new Error(timeoutMessage || 'Timed out waiting for condition to be met');
};

const getEnvValue = (names, description) => {
    for (const name of names) {
        const value = process.env[name];
        if (value && value.trim().length > 0) {
            return value.trim();
        }
    }
    throw new Error(`Missing required environment variable for ${description}: ${names.join(' or ')}`);
};

const getSalesforceField = (record, fieldNames) => {
    const entries = Object.entries(record || {});
    for (const target of fieldNames) {
        const normalized = target.toLowerCase();
        for (const [key, value] of entries) {
            if (key.toLowerCase() === normalized) {
                return value;
            }
        }
    }
    return undefined;
};

const createContext = (name) => ({
    invocationId: randomUUID(),
    bindingData: { livemode: false },
    log: (...args) => {
        const timestamp = new Date().toISOString();
        console.log(`[${timestamp}] [${name}]`, ...args);
    }
});

const sanitizeStripeObject = (value) => JSON.parse(JSON.stringify(value));

const createStripeEventPayload = (type, object, uniqueSuffix) => ({
    id: `evt_${type.replace(/\./g, '_')}_${uniqueSuffix}`,
    object: 'event',
    api_version: DEFAULT_STRIPE_API_VERSION,
    created: Math.floor(Date.now() / 1000),
    data: { object: sanitizeStripeObject(object) },
    livemode: false,
    pending_webhooks: 1,
    request: { id: null, idempotency_key: null },
    type
});

const fetchQuickBooksDocument = async ({ docType, docId, envConfig, accessToken }) => {
    const entityPath = QUICKBOOKS_ENTITY_PATH[docType];
    if (!entityPath) {
        throw new Error(`Unsupported QuickBooks document type: ${docType}`);
    }

    const realmId = envConfig.quickBooks.realmId;
    if (!realmId) {
        throw new Error('QuickBooks realm ID is not configured.');
    }

    const baseUrl = envConfig.quickBooks.environment === 'production'
        ? 'https://quickbooks.api.intuit.com/v3/company'
        : 'https://sandbox-quickbooks.api.intuit.com/v3/company';

    const url = `${baseUrl}/${encodeURIComponent(realmId)}/${entityPath}/${encodeURIComponent(docId)}?minorversion=73`;

    const response = await fetch(url, {
        method: 'GET',
        headers: {
            Accept: 'application/json',
            Authorization: `Bearer ${accessToken}`
        }
    });

    if (response.status === 404) {
        return null;
    }

    if (!response.ok) {
        const body = await response.text().catch(() => '');
        throw new Error(`QuickBooks API returned ${response.status} for ${docType} ${docId}: ${body}`);
    }

    return response.json();
};

(async () => {
    try {
        console.log('🧪 Starting live-parity end-to-end donation flow test');

        for (const [description, names] of Object.entries(REQUIRED_ENV_SETS)) {
            getEnvValue(names, description);
        }

        const stripeSecret = getEnvValue(['STRIPE_TEST_SECRET_KEY'], 'Stripe test secret key');
        const webhookSecret = getEnvValue(['STRIPE_WEBHOOK_SECRET'], 'Stripe webhook signing secret');
        const salesforceUsername = getEnvValue(['SALESFORCE_USERNAME'], 'Salesforce username');
        const salesforcePassword = getEnvValue(['SALESFORCE_PASSWORD'], 'Salesforce password');
        const salesforceSecurityToken = getEnvValue(['SALESFORCE_SECURITY_TOKEN'], 'Salesforce security token');
        const salesforceLoginUrl = process.env.SALESFORCE_LOGIN_URL || 'https://login.salesforce.com';
        const quickBooksAccessToken = getEnvValue(['QBO_ACCESS_TOKEN'], 'QuickBooks access token');

        process.env.STRIPE_SECRET = process.env.STRIPE_SECRET || stripeSecret;
        process.env.CRM_PROVIDER = process.env.CRM_PROVIDER || 'salesforce';
        process.env.STRIPE_MODE = process.env.STRIPE_MODE || 'test';
        process.env.DISABLE_AZURE_TABLES = '1';
        process.env.ACCOUNTING_SYNC_ENABLED = process.env.ACCOUNTING_SYNC_ENABLED || 'true';
        process.env.ACCOUNTING_POSTING_STRATEGY = process.env.ACCOUNTING_POSTING_STRATEGY || 'je-transfer';

        const processTransaction = require('../dist/handlers/processTransaction');
        const stripeWebhook = require('../dist/handlers/stripeWebhook');
        const { createSalesforceSvc } = require('../dist/services/salesforceSvc');

        let envConfigModule;
        try {
            envConfigModule = require('../dist/config/env');
        } catch (error) {
            throw new Error('Failed to load compiled env configuration. Run "npm run build" before executing the tests.');
        }

        const envConfig = envConfigModule?.default || envConfigModule?.env || envConfigModule;
        if (!envConfig || !envConfig.quickBooks) {
            throw new Error('Unable to resolve QuickBooks configuration from dist/config/env.');
        }

        if (typeof stripeWebhook.__internals?.resetDependencies === 'function') {
            stripeWebhook.__internals.resetDependencies();
        }

        const stripe = new Stripe(stripeSecret, { apiVersion: DEFAULT_STRIPE_API_VERSION });
        const uniqueRunId = randomUUID();
        const donationAmount = 2500; // $25.00
        const donorEmail = `donor+${uniqueRunId}@example.com`;
        const donationPayload = {
            amount: donationAmount,
            frequency: 'onetime',
            customer: {
                email: donorEmail,
                firstname: 'Integration',
                lastname: 'Test',
                phone: '+15551234567',
                address: {
                    line1: '1 Test Way',
                    city: 'Testville',
                    state: 'CA',
                    postal_code: '94016',
                    country: 'US'
                }
            },
            metadata: {
                attribution: 'Automated integration test',
                run_id: uniqueRunId
            }
        };

        const processContext = createContext('processTransaction');
        await processTransaction(processContext, { body: donationPayload });

        assert(processContext.res, 'processTransaction handler did not set an HTTP response.');
        assert.strictEqual(processContext.res.status, 200, `Unexpected status from processTransaction: ${processContext.res.status}`);

        const processResponse = typeof processContext.res.body === 'string'
            ? JSON.parse(processContext.res.body)
            : processContext.res.body;

        assert(processResponse?.id, 'processTransaction response missing checkout session id.');

        const sessionId = processResponse.id;
        console.log(`✅ Created Stripe checkout session ${sessionId}`);

        const sessionAfterCreation = await stripe.checkout.sessions.retrieve(sessionId);
        const paymentIntentIdFromSession = sessionAfterCreation.payment_intent;
        assert(paymentIntentIdFromSession, 'Checkout session did not include a payment intent id.');

        await stripe.paymentIntents.confirm(paymentIntentIdFromSession, {
            payment_method: 'pm_card_visa',
            return_url: 'https://example.com/complete'
        });

        const paymentIntent = await waitFor(
            async () => {
                const pi = await stripe.paymentIntents.retrieve(paymentIntentIdFromSession, {
                    expand: ['charges.data.balance_transaction']
                });
                if (pi.status === 'succeeded') {
                    return pi;
                }
                return null;
            },
            {
                attempts: 10,
                delay: 2000,
                timeoutMessage: `Timed out waiting for payment intent ${paymentIntentIdFromSession} to succeed.`
            }
        );

        const charge = paymentIntent.charges?.data?.[0];
        assert(charge, 'Expected at least one charge on the succeeded payment intent.');
        assert.strictEqual(charge.status, 'succeeded', `Charge ${charge.id} did not succeed.`);

        const checkoutSession = await waitFor(
            async () => {
                const session = await stripe.checkout.sessions.retrieve(sessionId);
                if (session.status === 'complete') {
                    return session;
                }
                return null;
            },
            {
                attempts: 10,
                delay: 2000,
                timeoutMessage: `Timed out waiting for checkout session ${sessionId} to reach the complete state.`
            }
        );

        const sendWebhookEvent = async (type, object) => {
            const payloadObject = createStripeEventPayload(type, object, uniqueRunId);
            const payload = JSON.stringify(payloadObject);
            const signature = Stripe.webhooks.generateTestHeaderString({
                payload,
                secret: webhookSecret
            });

            const webhookContext = createContext('stripeWebhook');
            const request = {
                headers: { 'stripe-signature': signature },
                rawBody: payload
            };

            await stripeWebhook(webhookContext, request);
            assert(webhookContext.res, `Webhook handler did not respond for ${type}.`);
            assert.strictEqual(
                webhookContext.res.status,
                200,
                `Webhook handler returned ${webhookContext.res.status} for ${type}: ${webhookContext.res.body}`
            );
        };

        await sendWebhookEvent('checkout.session.completed', checkoutSession);
        console.log(`✅ Processed checkout.session.completed for ${sessionId}`);

        await sendWebhookEvent('payment_intent.succeeded', paymentIntent);
        console.log(`✅ Processed payment_intent.succeeded for ${paymentIntent.id}`);

        const salesforceConnection = new jsforce.Connection({ loginUrl: salesforceLoginUrl });
        await salesforceConnection.login(salesforceUsername, `${salesforcePassword}${salesforceSecurityToken}`);
        const salesforceSvc = createSalesforceSvc({ connection: salesforceConnection });

        const { id: salesforceTransactionId, record: salesforceRecord } = await waitFor(
            async () => {
                const recordId = await salesforceSvc.findTransactionIdByExternalId('stripe_payment_intent_id__c', paymentIntent.id);
                if (!recordId) {
                    return null;
                }
                const record = await salesforceConnection.sobject('Transaction__c').retrieve(recordId);
                if (!record) {
                    return null;
                }
                return { id: recordId, record };
            },
            {
                attempts: 10,
                delay: 3000,
                timeoutMessage: `Salesforce transaction for payment intent ${paymentIntent.id} was not found.`
            }
        );

        console.log(`✅ Located Salesforce transaction ${salesforceTransactionId}`);

        const statusValue = getSalesforceField(salesforceRecord, ['Status__c', 'status__c']);
        assert(statusValue, 'Salesforce transaction status field is missing.');
        assert.strictEqual(String(statusValue).toLowerCase(), 'paid', `Expected Salesforce status to be "paid" but got "${statusValue}".`);

        const storedPaymentIntentId = getSalesforceField(
            salesforceRecord,
            ['Stripe_Payment_Intent_ID__c', 'stripe_payment_intent_id__c']
        );
        assert.strictEqual(storedPaymentIntentId, paymentIntent.id, 'Salesforce record does not reference the correct payment intent.');

        const postedToQbo = getSalesforceField(salesforceRecord, ['Posted_to_QBO__c', 'posted_to_qbo__c']);
        assert(postedToQbo === true || postedToQbo === 'true', 'Salesforce record is not flagged as posted to QuickBooks.');

        const qboDocId = getSalesforceField(salesforceRecord, ['QBO_Doc_ID__c', 'qbo_doc_id__c']);
        const qboDocType = getSalesforceField(salesforceRecord, ['QBO_Doc_Type__c', 'qbo_doc_type__c']);
        assert(qboDocId, 'Salesforce record missing QuickBooks document ID.');
        assert(qboDocType, 'Salesforce record missing QuickBooks document type.');

        const qboDocument = await waitFor(
            async () => {
                return fetchQuickBooksDocument({
                    docType: String(qboDocType).toLowerCase(),
                    docId: qboDocId,
                    envConfig,
                    accessToken: quickBooksAccessToken
                });
            },
            {
                attempts: 6,
                delay: 5000,
                timeoutMessage: `QuickBooks document ${qboDocType} ${qboDocId} was not found.`
            }
        );

        assert(qboDocument, 'QuickBooks document lookup returned no data.');
        console.log(`✅ Verified QuickBooks document ${qboDocType} ${qboDocId}`);

        if (typeof stripeWebhook.__internals?.resetDependencies === 'function') {
            stripeWebhook.__internals.resetDependencies();
        }

        console.log('🎉 End-to-end donation flow completed successfully with live integrations.');
        process.exit(0);
    } catch (error) {
        console.error('❌ End-to-end donation flow test failed:');
        console.error(error);
        process.exit(1);
    }
})();
