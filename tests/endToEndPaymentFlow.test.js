/**
 * End-to-end donation flow test that exercises the live integrations.
 *
 * This script intentionally uses the real Stripe, Salesforce, and QuickBooks
 * APIs. It creates an actual checkout session, confirms the payment using the
 * Stripe test card helpers, routes the resulting webhook payloads through the
 * production handlers with valid signatures, and then verifies the downstream
 * state in Salesforce and QuickBooks.
 *
 * Because the script touches real services you must run it with production
 * configuration values (or a fully provisioned test tenant) and valid access
 * tokens. The script exits with a non-zero status if any expectation is not
 * met so it can be wired into CI pipelines that have the required secrets.
 */

const assert = require('assert');
const { randomUUID } = require('crypto');
const Stripe = require('stripe');
const jsforce = require('jsforce');
const QuickBooks = require('node-quickbooks');

const processTransaction = require('../dist/handlers/processTransaction');
const stripeWebhookModule = require('../dist/handlers/stripeWebhook');
const stripeWebhook = stripeWebhookModule && stripeWebhookModule.default ? stripeWebhookModule.default : stripeWebhookModule;

const STRIPE_API_VERSION = '2023-10-16';
const STRIPE_EVENT_TIMEOUT_MS = 120_000;
const STRIPE_EVENT_POLL_INTERVAL_MS = 5_000;
const SALESFORCE_POLL_TIMEOUT_MS = 300_000;
const SALESFORCE_POLL_INTERVAL_MS = 5_000;
const QUICKBOOKS_POLL_TIMEOUT_MS = 120_000;
const QUICKBOOKS_POLL_INTERVAL_MS = 5_000;

const REQUIRED_ENV_VARS = [
    'STRIPE_TEST_SECRET_KEY',
    'STRIPE_WEBHOOK_SECRET',
    'SUCCESS_URL',
    'CANCEL_URL',
    'CRM_PROVIDER',
    'SALESFORCE_USERNAME',
    'SALESFORCE_PASSWORD',
    'SALESFORCE_SECURITY_TOKEN',
    'ACCOUNTING_SYNC_ENABLED',
    'ACCOUNTING_POSTING_STRATEGY',
    'QBO_CLIENT_ID',
    'QBO_CLIENT_SECRET',
    'QBO_REALM_ID',
    'QBO_REFRESH_TOKEN',
    'QBO_ACCESS_TOKEN',
    'QBO_ENV',
    'AZURE_TABLES_CONNECTION_STRING'
];

function requireEnvVar(name) {
    const value = process.env[name];
    if (!value || value.trim().length === 0) {
        throw new Error(`Required environment variable ${name} is not set`);
    }
    return value;
}

function validateEnvironment() {
    console.log('🔐 Validating required environment variables');
    const summary = {};
    for (const name of REQUIRED_ENV_VARS) {
        const value = requireEnvVar(name);
        summary[name] = `${value.slice(0, 6)}…`;
    }
    console.log('✅ Environment validation completed', summary);
}

function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function createFunctionContext(name) {
    return {
        invocationId: `${name}-${randomUUID()}`,
        log: (...args) => console.log(`[${name}]`, ...args)
    };
}

function extractPaymentIntentId(session) {
    if (!session) {
        return null;
    }

    if (typeof session.payment_intent === 'string') {
        return session.payment_intent;
    }

    if (session.payment_intent && typeof session.payment_intent === 'object' && session.payment_intent.id) {
        return session.payment_intent.id;
    }

    return null;
}

async function createCheckoutSession(stripe, runId, donationCents, donor) {
    console.log('🧪 Initiating donation via processTransaction', { runId, donationCents });

    const context = createFunctionContext('processTransaction');
    const payload = {
        amount: donationCents,
        frequency: 'onetime',
        metadata: {
            e2e_run_id: runId,
            source: 'automation'
        },
        customer: {
            email: donor.email,
            firstname: donor.firstName,
            lastname: donor.lastName,
            phone: donor.phone,
            address: {
                line1: '123 E2E Street',
                city: 'Testville',
                state: 'NY',
                postal_code: '10001',
                country: 'US'
            }
        }
    };

    const req = { body: payload };
    await processTransaction(context, req);

    assert(context.res, 'processTransaction did not return a response');
    assert.strictEqual(context.res.status, 200, `processTransaction returned ${context.res.status}`);

    const response = typeof context.res.body === 'string' ? JSON.parse(context.res.body) : context.res.body;
    assert(response && response.id, 'Checkout session id missing from response');
    assert(response.url, 'Checkout session url missing from response');

    console.log('✅ Checkout session created', { sessionId: response.id, url: response.url });
    return { sessionId: response.id, url: response.url };
}

async function confirmCheckout(stripe, sessionId) {
    console.log('⏳ Waiting for checkout session completion', { sessionId });

    const start = Date.now();
    let attempt = 0;
    while (Date.now() - start < STRIPE_EVENT_TIMEOUT_MS) {
        attempt += 1;
        const session = await stripe.checkout.sessions.retrieve(sessionId, { expand: ['payment_intent.charges'] });
        const paymentIntentId = extractPaymentIntentId(session);
        const paymentStatus = session.payment_status;
        const sessionStatus = session.status;

        console.log('🔁 Stripe checkout status', {
            attempt,
            sessionStatus,
            paymentStatus,
            paymentIntentId
        });

        if (sessionStatus === 'complete' && paymentStatus === 'paid' && paymentIntentId) {
            console.log('✅ Checkout session is paid', { sessionId, paymentIntentId });
            return { session, paymentIntentId };
        }

        if (paymentIntentId) {
            const paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId, { expand: ['charges'] });
            if (paymentIntent.status !== 'succeeded') {
                console.log('💳 Confirming payment intent with pm_card_visa', { paymentIntentId, status: paymentIntent.status });
                try {
                    await stripe.paymentIntents.confirm(paymentIntentId, {
                        payment_method: 'pm_card_visa',
                        return_url: 'https://example.org/stripe-complete'
                    });
                } catch (error) {
                    if (error && error.code === 'payment_intent_unexpected_state') {
                        console.log('⚠️ Payment intent already in terminal state', { paymentIntentId, state: paymentIntent.status });
                    } else {
                        throw error;
                    }
                }
            }
        }

        await delay(STRIPE_EVENT_POLL_INTERVAL_MS);
    }

    throw new Error('Timed out waiting for checkout session to complete');
}

async function waitForStripeEvent(stripe, type, predicate, startedAt) {
    console.log('🔍 Waiting for Stripe event', { type });
    const timeoutAt = Date.now() + STRIPE_EVENT_TIMEOUT_MS;

    while (Date.now() < timeoutAt) {
        const events = await stripe.events.list({
            type,
            limit: 20,
            created: { gte: startedAt }
        });

        for (const event of events.data) {
            if (predicate(event)) {
                console.log('✅ Retrieved Stripe event', { type: event.type, id: event.id });
                return event;
            }
        }

        await delay(STRIPE_EVENT_POLL_INTERVAL_MS);
    }

    throw new Error(`Timed out waiting for Stripe event ${type}`);
}

async function invokeStripeWebhook(event, secret) {
    const payload = JSON.stringify(event);
    const signature = Stripe.webhooks.generateTestHeaderString({
        payload,
        secret,
        timestamp: Math.floor(Date.now() / 1000)
    });

    const context = createFunctionContext('stripeWebhook');
    const req = {
        headers: { 'stripe-signature': signature },
        rawBody: Buffer.from(payload),
        body: event
    };

    await stripeWebhook(context, req);

    if (!context.res || context.res.status !== 200) {
        const body = context.res ? context.res.body : '<no response body>';
        throw new Error(`Stripe webhook handler returned ${context.res && context.res.status}: ${body}`);
    }

    console.log('📬 Webhook delivered to handler', { eventId: event.id, eventType: event.type });
}

async function createSalesforceConnection() {
    const username = requireEnvVar('SALESFORCE_USERNAME');
    const password = requireEnvVar('SALESFORCE_PASSWORD');
    const securityToken = process.env.SALESFORCE_SECURITY_TOKEN || '';
    const loginUrl = process.env.SALESFORCE_LOGIN_URL || 'https://login.salesforce.com';

    const connection = new jsforce.Connection({ loginUrl });
    await connection.login(username, `${password}${securityToken}`);
    return connection;
}

async function pollSalesforceRecord(fetchFn, label) {
    const timeoutAt = Date.now() + SALESFORCE_POLL_TIMEOUT_MS;
    let attempt = 0;

    while (Date.now() < timeoutAt) {
        attempt += 1;
        const record = await fetchFn();
        if (record) {
            console.log(`✅ Salesforce ${label} located`, { attempt });
            return record;
        }
        console.log(`⌛ Waiting for Salesforce ${label}`, { attempt });
        await delay(SALESFORCE_POLL_INTERVAL_MS);
    }

    throw new Error(`Timed out waiting for Salesforce ${label}`);
}

async function verifySalesforce(donor, paymentIntentId, chargeId, balanceTransactionId, expectedAmounts) {
    console.log('🔎 Verifying Salesforce data');
    const connection = await createSalesforceConnection();

    const contact = await pollSalesforceRecord(
        () => connection.sobject('Contact').findOne({ Email: donor.email }),
        'contact'
    );

    const transaction = await pollSalesforceRecord(
        () =>
            connection
                .sobject('Transaction__c')
                .findOne({ stripe_payment_intent_id__c: paymentIntentId }, 'Id,Amount_Gross__c,Amount_Net__c,Amount_Fee__c,Stripe_Charge_Id__c,Stripe_Balance_Transaction_Id__c,Posted_to_QBO__c'),
        'transaction'
    );

    assert.strictEqual(transaction.Stripe_Charge_Id__c, chargeId, 'Salesforce charge id mismatch');
    assert.strictEqual(
        transaction.Stripe_Balance_Transaction_Id__c,
        balanceTransactionId,
        'Salesforce balance transaction id mismatch'
    );
    assert.strictEqual(Number(transaction.Amount_Gross__c), expectedAmounts.gross, 'Salesforce gross amount mismatch');
    assert.strictEqual(Number(transaction.Amount_Net__c), expectedAmounts.net, 'Salesforce net amount mismatch');
    assert.strictEqual(Number(transaction.Amount_Fee__c), expectedAmounts.fee, 'Salesforce fee amount mismatch');

    console.log('✅ Salesforce verification complete', {
        contactId: contact.Id,
        transactionId: transaction.Id,
        postedToQbo: transaction.Posted_to_QBO__c
    });
}

function createQuickBooksClient() {
    const clientId = requireEnvVar('QBO_CLIENT_ID');
    const clientSecret = requireEnvVar('QBO_CLIENT_SECRET');
    const accessToken = requireEnvVar('QBO_ACCESS_TOKEN');
    const refreshToken = requireEnvVar('QBO_REFRESH_TOKEN');
    const realmId = requireEnvVar('QBO_REALM_ID');
    const env = (process.env.QBO_ENV || 'sandbox').toLowerCase();
    const useSandbox = env !== 'production';

    return new QuickBooks(
        clientId,
        clientSecret,
        accessToken,
        false,
        realmId,
        useSandbox,
        true,
        null,
        '2.0',
        refreshToken
    );
}

function buildDocNumber(prefix, date, amountCents) {
    const normalizedDate = new Date(date);
    const formattedDate = normalizedDate.toISOString().slice(0, 10).replace(/-/g, '');
    const amountPart = Math.abs(Math.round(amountCents)).toString().slice(-10);
    const suffix = `${formattedDate}-${amountPart}`;
    const maxPrefixLength = Math.max(1, 21 - suffix.length - 1);
    const safePrefix = prefix.slice(0, maxPrefixLength);
    return `${safePrefix}-${suffix}`.slice(0, 21);
}

async function queryQuickBooks(qbo, entity, docNumber) {
    const query = `select Id, DocNumber, TxnDate, PrivateNote from ${entity} where DocNumber = '${docNumber}'`;
    return new Promise((resolve, reject) => {
        qbo.query(query, (error, result) => {
            if (error) {
                reject(error);
                return;
            }

            const response = result && result.QueryResponse ? result.QueryResponse : null;
            const records = response && (response[entity] || response[`${entity}s`]);
            if (Array.isArray(records) && records.length > 0) {
                resolve(records[0]);
                return;
            }

            resolve(null);
        });
    });
}

async function verifyQuickBooksPosting(chargeId, balanceTransaction, postingStrategy) {
    console.log('🔎 Verifying QuickBooks posting');
    const qbo = createQuickBooksClient();
    const postingDateSeconds = balanceTransaction.available_on || balanceTransaction.created;
    const postingDate = postingDateSeconds ? postingDateSeconds * 1000 : Date.now();

    const grossCents = Math.abs(balanceTransaction.amount || 0);
    const feeCents = Math.abs(balanceTransaction.fee || 0);

    const timeoutAt = Date.now() + QUICKBOOKS_POLL_TIMEOUT_MS;
    let attempt = 0;

    while (Date.now() < timeoutAt) {
        attempt += 1;
        console.log('🔁 Polling QuickBooks for posting', { attempt });

        if (postingStrategy === 'sales-receipt') {
            const salesReceiptDoc = buildDocNumber('CHG', postingDate, grossCents);
            const salesReceipt = await queryQuickBooks(qbo, 'SalesReceipt', salesReceiptDoc);
            if (salesReceipt) {
                console.log('✅ QuickBooks sales receipt located', { docNumber: salesReceiptDoc });
                if (feeCents > 0) {
                    const feeDoc = buildDocNumber('FEE', postingDate, feeCents);
                    const feeJournal = await queryQuickBooks(qbo, 'JournalEntry', feeDoc);
                    if (!feeJournal) {
                        console.log('⌛ Waiting for QuickBooks fee journal entry', { docNumber: feeDoc });
                        await delay(QUICKBOOKS_POLL_INTERVAL_MS);
                        continue;
                    }
                    console.log('✅ QuickBooks fee journal entry located', { docNumber: feeDoc });
                }
                return;
            }
        } else {
            const journalDoc = buildDocNumber('CHGJE', postingDate, grossCents + feeCents);
            const journalEntry = await queryQuickBooks(qbo, 'JournalEntry', journalDoc);
            if (journalEntry) {
                console.log('✅ QuickBooks journal entry located', { docNumber: journalDoc });
                return;
            }
        }

        await delay(QUICKBOOKS_POLL_INTERVAL_MS);
    }

    throw new Error('Timed out waiting for QuickBooks posting to appear');
}

async function runEndToEndTest() {
    validateEnvironment();

    const stripeSecret = requireEnvVar('STRIPE_TEST_SECRET_KEY');
    const stripeWebhookSecret = requireEnvVar('STRIPE_WEBHOOK_SECRET');
    const stripe = new Stripe(stripeSecret, { apiVersion: STRIPE_API_VERSION });

    const runId = `e2e-${randomUUID()}`;
    const donor = {
        firstName: 'Grace',
        lastName: 'Hopper',
        email: `donor+${runId}@example.org`,
        phone: '+15555550123'
    };
    const donationCents = 5_000;

    console.log('🚀 Starting live end-to-end donation test', { runId, donor: donor.email, donationCents });

    const startTime = Math.floor(Date.now() / 1000) - 5;
    const { sessionId } = await createCheckoutSession(stripe, runId, donationCents, donor);
    const { paymentIntentId } = await confirmCheckout(stripe, sessionId);

    const checkoutEvent = await waitForStripeEvent(
        stripe,
        'checkout.session.completed',
        event => event.data && event.data.object && event.data.object.id === sessionId,
        startTime
    );
    await invokeStripeWebhook(checkoutEvent, stripeWebhookSecret);

    const paymentIntentEvent = await waitForStripeEvent(
        stripe,
        'payment_intent.succeeded',
        event => event.data && event.data.object && event.data.object.id === paymentIntentId,
        startTime
    );
    await invokeStripeWebhook(paymentIntentEvent, stripeWebhookSecret);

    const paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId, {
        expand: ['charges.data.balance_transaction', 'latest_charge.balance_transaction']
    });

    const charges = Array.isArray(paymentIntent.charges?.data) ? paymentIntent.charges.data : [];
    let charge = charges.find(charge => charge.status === 'succeeded') || charges[0];

    if (!charge) {
        const latestCharge = paymentIntent.latest_charge;
        if (typeof latestCharge === 'string') {
            charge = await stripe.charges.retrieve(latestCharge, { expand: ['balance_transaction'] });
        } else if (latestCharge && typeof latestCharge === 'object') {
            charge = latestCharge;
        }
    }

    assert(charge, 'Charge data missing from payment intent');

    const balanceTransactionRef = charge.balance_transaction;
    const balanceTransactionId =
        typeof balanceTransactionRef === 'string'
            ? balanceTransactionRef
            : balanceTransactionRef?.id;
    assert(balanceTransactionId, 'Balance transaction id missing from charge');
    const balanceTransaction = await stripe.balanceTransactions.retrieve(balanceTransactionId);

    const centsToMajorUnits = value => Number(((value ?? 0) / 100).toFixed(2));
    const expectedAmounts = {
        gross: centsToMajorUnits(balanceTransaction.amount ?? donationCents),
        net: centsToMajorUnits(balanceTransaction.net ?? donationCents),
        fee: centsToMajorUnits(balanceTransaction.fee ?? 0)
    };

    await verifySalesforce(donor, paymentIntentId, charge.id, balanceTransactionId, expectedAmounts);

    const postingStrategy = (process.env.ACCOUNTING_POSTING_STRATEGY || 'je-transfer').toLowerCase();
    if (process.env.ACCOUNTING_SYNC_ENABLED === 'true') {
        await verifyQuickBooksPosting(charge.id, balanceTransaction, postingStrategy);
    } else {
        console.log('ℹ️ Accounting sync disabled; skipping QuickBooks verification');
    }

    console.log('🎉 End-to-end donation test completed successfully', {
        paymentIntentId,
        chargeId: charge.id,
        balanceTransactionId
    });
}

runEndToEndTest().catch(error => {
    console.error('❌ End-to-end donation test failed');
    console.error(error);
    process.exitCode = 1;
});
