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

const getStripeId = (value) => {
    if (!value) {
        return null;
    }

    if (typeof value === 'string') {
        return value;
    }

    if (typeof value === 'object' && typeof value.id === 'string') {
        return value.id;
    }

    return null;
};

const normalizeCustomerDetails = (customer = {}) => {
    const firstName = customer.firstname || customer.firstName || '';
    const lastName = customer.lastname || customer.lastName || '';
    const name = [firstName, lastName].filter(Boolean).join(' ').trim() || null;

    const addressSource = typeof customer.address === 'object' && customer.address
        ? customer.address
        : null;

    const normalizedAddress = {
        line1: addressSource?.line1 || (typeof customer.address === 'string' ? customer.address : null) || null,
        line2: addressSource?.line2 || null,
        city: addressSource?.city || customer.city || null,
        state: addressSource?.state || customer.state || null,
        postal_code: addressSource?.postal_code || customer.postalCode || customer.zipcode || null,
        country: addressSource?.country || 'US'
    };

    return {
        email: customer.email || null,
        name,
        phone: customer.phone || null,
        address: normalizedAddress,
        tax_exempt: 'none',
        tax_ids: []
    };
};

const normalizeStripeMetadata = (metadata = {}) => {
    const normalized = {};

    for (const [key, value] of Object.entries(metadata || {})) {
        if (typeof value === 'undefined' || value === null) {
            continue;
        }

        if (typeof value === 'object') {
            normalized[key] = JSON.stringify(value);
            continue;
        }

        normalized[key] = String(value);
    }

    return normalized;
};

const createCheckoutSessionCompletedObject = ({ session, customer, customerDetails, paymentIntentId }) => {
    const resolvedCustomerDetails = customerDetails || normalizeCustomerDetails(customer);
    const customerId = getStripeId(session.customer) || (customer && customer.id ? customer.id : null);

    return {
        id: session.id,
        object: 'checkout.session',
        mode: session.mode || 'payment',
        status: 'complete',
        payment_status: 'paid',
        amount_total: session.amount_total ?? session.amount_subtotal ?? null,
        amount_subtotal: session.amount_subtotal ?? session.amount_total ?? null,
        currency: session.currency || 'usd',
        livemode: false,
        customer: customerId,
        customer_details: resolvedCustomerDetails,
        payment_intent: paymentIntentId,
        payment_method_types: Array.isArray(session.payment_method_types) && session.payment_method_types.length > 0
            ? session.payment_method_types
            : ['card'],
        metadata: session.metadata || {},
        created: session.created || Math.floor(Date.now() / 1000),
        expires_at: session.expires_at || null,
        locale: session.locale || null,
        total_details: session.total_details || {
            amount_discount: 0,
            amount_shipping: 0,
            amount_tax: 0
        }
    };
};

const createPaymentIntentSucceededObject = ({ paymentIntent, charge, balanceTransactionId, customerDetails }) => {
    const normalizedPaymentIntent = { ...paymentIntent };
    const fallbackAmount = normalizedPaymentIntent.amount ?? charge.amount ?? null;
    const fallbackCurrency = normalizedPaymentIntent.currency || charge.currency || 'usd';

    const customerId = getStripeId(normalizedPaymentIntent.customer) || getStripeId(charge.customer) || null;
    const paymentMethodId = getStripeId(normalizedPaymentIntent.payment_method) || charge.payment_method || null;
    const resolvedPaymentMethodId = paymentMethodId || 'pm_card_visa';

    const invoiceId = getStripeId(charge.invoice);

    const normalizedCharge = {
        ...charge,
        id: charge.id,
        object: 'charge',
        amount: charge.amount ?? fallbackAmount,
        amount_captured: charge.amount_captured ?? charge.amount ?? fallbackAmount,
        amount_refunded: charge.amount_refunded ?? 0,
        balance_transaction: balanceTransactionId,
        billing_details: charge.billing_details || customerDetails,
        currency: charge.currency || fallbackCurrency,
        customer: customerId,
        description: charge.description || null,
        invoice: invoiceId,
        livemode: charge.livemode === true,
        metadata: charge.metadata || {},
        paid: charge.paid ?? true,
        payment_intent: normalizedPaymentIntent.id,
        payment_method: charge.payment_method || resolvedPaymentMethodId,
        payment_method_details: charge.payment_method_details || {
            type: 'card',
            card: {
                brand: 'visa',
                last4: '4242'
            }
        },
        receipt_email: charge.receipt_email || customerDetails?.email || null,
        receipt_url: charge.receipt_url || null,
        refunded: charge.refunded ?? false,
        status: charge.status || 'succeeded',
        created: charge.created || normalizedPaymentIntent.created || Math.floor(Date.now() / 1000)
    };

    normalizedPaymentIntent.object = 'payment_intent';
    normalizedPaymentIntent.amount = fallbackAmount;
    normalizedPaymentIntent.amount_capturable = normalizedPaymentIntent.amount_capturable ?? 0;
    normalizedPaymentIntent.amount_details = normalizedPaymentIntent.amount_details || { tip: {} };
    normalizedPaymentIntent.amount_received = normalizedPaymentIntent.amount_received ?? fallbackAmount;
    normalizedPaymentIntent.currency = fallbackCurrency;
    normalizedPaymentIntent.customer = customerId;
    normalizedPaymentIntent.livemode = normalizedPaymentIntent.livemode === true;
    normalizedPaymentIntent.metadata = normalizedPaymentIntent.metadata || {};
    normalizedPaymentIntent.payment_method = resolvedPaymentMethodId;
    normalizedPaymentIntent.payment_method_types = Array.isArray(normalizedPaymentIntent.payment_method_types)
        && normalizedPaymentIntent.payment_method_types.length > 0
        ? normalizedPaymentIntent.payment_method_types
        : ['card'];
    normalizedPaymentIntent.receipt_email = normalizedPaymentIntent.receipt_email || normalizedCharge.receipt_email || null;
    normalizedPaymentIntent.invoice = getStripeId(normalizedPaymentIntent.invoice);
    normalizedPaymentIntent.subscription = getStripeId(normalizedPaymentIntent.subscription);
    normalizedPaymentIntent.canceled_at = normalizedPaymentIntent.canceled_at ?? null;
    normalizedPaymentIntent.cancellation_reason = normalizedPaymentIntent.cancellation_reason ?? null;
    normalizedPaymentIntent.last_payment_error = normalizedPaymentIntent.last_payment_error ?? null;
    normalizedPaymentIntent.next_action = normalizedPaymentIntent.next_action ?? null;
    normalizedPaymentIntent.processing = normalizedPaymentIntent.processing ?? null;
    normalizedPaymentIntent.review = normalizedPaymentIntent.review ?? null;
    normalizedPaymentIntent.setup_future_usage = normalizedPaymentIntent.setup_future_usage ?? null;
    normalizedPaymentIntent.shipping = normalizedPaymentIntent.shipping ?? null;
    normalizedPaymentIntent.statement_descriptor = normalizedPaymentIntent.statement_descriptor ?? null;
    normalizedPaymentIntent.statement_descriptor_suffix = normalizedPaymentIntent.statement_descriptor_suffix ?? null;
    normalizedPaymentIntent.transfer_data = normalizedPaymentIntent.transfer_data ?? null;
    normalizedPaymentIntent.transfer_group = normalizedPaymentIntent.transfer_group ?? null;
    normalizedPaymentIntent.status = 'succeeded';
    normalizedPaymentIntent.latest_charge = normalizedCharge.id;
    normalizedPaymentIntent.charges = {
        object: 'list',
        data: [normalizedCharge],
        has_more: false,
        total_count: 1,
        url: `/v1/charges?payment_intent=${normalizedPaymentIntent.id}`
    };

    return normalizedPaymentIntent;
};

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

        const checkoutSession = await stripe.checkout.sessions.retrieve(sessionId);

        const checkoutSessionCurrency = checkoutSession.currency || 'usd';
        const checkoutSessionCustomerId = getStripeId(checkoutSession.customer);
        const normalizedMetadata = {
            ...normalizeStripeMetadata(donationPayload.metadata || {}),
            checkout_session_id: sessionId,
            integration_test_run_id: uniqueRunId
        };

        let paymentIntent = await stripe.paymentIntents.create({
            amount: donationAmount,
            currency: checkoutSessionCurrency,
            customer: checkoutSessionCustomerId || undefined,
            payment_method: 'pm_card_visa',
            payment_method_types: ['card'],
            confirm: true,
            receipt_email: donorEmail,
            description: 'Automated integration test donation',
            metadata: normalizedMetadata,
            expand: ['charges.data.balance_transaction']
        });

        if (paymentIntent.status !== 'succeeded') {
            paymentIntent = await waitFor(
                async () => {
                    const pi = await stripe.paymentIntents.retrieve(paymentIntent.id, {
                        expand: ['charges.data.balance_transaction']
                    });
                    if (pi.status === 'succeeded') {
                        return pi;
                    }
                    return null;
                },
                {
                    attempts: 5,
                    delay: 1000,
                    timeoutMessage: `Timed out waiting for simulated payment intent ${paymentIntent.id} to succeed.`
                }
            );
        }

        const charge = paymentIntent.charges?.data?.[0];
        assert(charge, 'Expected at least one charge on the succeeded payment intent.');
        assert.strictEqual(charge.status, 'succeeded', `Charge ${charge.id} did not succeed.`);

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

        const sanitizedSession = sanitizeStripeObject(checkoutSession);
        const sanitizedPaymentIntent = sanitizeStripeObject(paymentIntent);
        const sanitizedCharge = sanitizeStripeObject(charge);

        if (!sanitizedSession.amount_total) {
            sanitizedSession.amount_total = sanitizedPaymentIntent.amount_received
                ?? sanitizedPaymentIntent.amount
                ?? donationAmount;
        }

        if (!sanitizedSession.amount_subtotal) {
            sanitizedSession.amount_subtotal = sanitizedPaymentIntent.amount
                ?? sanitizedPaymentIntent.amount_received
                ?? donationAmount;
        }

        if (!sanitizedSession.currency) {
            sanitizedSession.currency = sanitizedPaymentIntent.currency || checkoutSessionCurrency;
        }

        const balanceTransactionId = getStripeId(sanitizedCharge.balance_transaction);
        assert(balanceTransactionId, 'Charge does not reference a balance transaction id.');

        const customerDetailsForEvents = (sanitizedSession.customer_details && typeof sanitizedSession.customer_details === 'object')
            ? sanitizedSession.customer_details
            : normalizeCustomerDetails(donationPayload.customer);

        const checkoutSessionEventObject = createCheckoutSessionCompletedObject({
            session: sanitizedSession,
            customer: donationPayload.customer,
            customerDetails: customerDetailsForEvents,
            paymentIntentId: sanitizedPaymentIntent.id
        });

        const paymentIntentEventObject = createPaymentIntentSucceededObject({
            paymentIntent: sanitizedPaymentIntent,
            charge: { ...sanitizedCharge, balance_transaction: balanceTransactionId },
            balanceTransactionId,
            customerDetails: customerDetailsForEvents
        });

        await sendWebhookEvent('checkout.session.completed', checkoutSessionEventObject);
        console.log(`✅ Processed checkout.session.completed for ${sessionId}`);

        await sendWebhookEvent('payment_intent.succeeded', paymentIntentEventObject);
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
