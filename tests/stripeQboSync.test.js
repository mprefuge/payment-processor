const assert = require('assert');
const os = require('os');
const path = require('path');
const fs = require('fs/promises');
const { setTimeout: delay } = require('timers/promises');

const {
    resolveQboCustomer,
    buildChargeJE,
    mapBalanceTxnToEntries,
    postJEIfNew,
    postTransferIfNew,
    reconcilePayout,
    attachStripeArtifacts,
    ProcessedStripeStore,
    ensureStripeVendor,
    convertPayoutAmount,
    normalizeAmount
} = require('../dist/services/qbo/stripe');

const accounts = {
    revenueId: 'acct-revenue',
    stripeFeesId: 'acct-fees',
    refundsContraId: 'acct-refunds',
    stripeClearingId: 'acct-clearing',
    operatingBankId: 'acct-operating',
    adjustments: {
        default: 'acct-adjustments',
        tax: 'acct-tax'
    }
};

class MockQuickBooksProvider {
    constructor() {
        this.customersByEmail = new Map();
        this.upsertedJournalEntries = [];
        this.attachments = [];
        this.transfers = [];
    }

    async ensureCustomer(payload) {
        if (payload.email && this.customersByEmail.has(payload.email)) {
            return this.customersByEmail.get(payload.email);
        }
        const record = {
            id: payload.email ? `cust-${payload.email}` : 'cust-unknown',
            displayName: payload.displayName
        };
        if (payload.email) {
            this.customersByEmail.set(payload.email, record);
        }
        return record;
    }

    async ensureVendor(payload) {
        return {
            id: payload.externalId || 'vendor-stripe',
            displayName: payload.displayName
        };
    }

    async upsertJournalEntry(journalEntry) {
        const existing = this.upsertedJournalEntries.find(entry => entry.docNumber === journalEntry.docNumber);
        if (existing) {
            return { id: existing.id, docNumber: existing.docNumber, created: false };
        }
        const record = {
            ...journalEntry,
            id: `je-${this.upsertedJournalEntries.length + 1}`
        };
        this.upsertedJournalEntries.push(record);
        return { id: record.id, docNumber: record.docNumber, created: true };
    }

    async upsertTransfer(transfer) {
        const existing = this.transfers.find(t => t.docNumber === transfer.docNumber);
        if (existing) {
            return { id: existing.id, created: false };
        }
        const created = {
            ...transfer,
            id: `transfer-${this.transfers.length + 1}`
        };
        this.transfers.push(created);
        return { id: created.id, created: true };
    }

    async attachDocument(transactionId, attachment) {
        this.attachments.push({ transactionId, attachment });
        return { id: `att-${this.attachments.length}`, fileName: attachment.fileName };
    }
}

async function runTest(name, fn) {
    try {
        await fn();
        console.log(`✅ ${name}`);
    } catch (error) {
        console.error(`❌ ${name}`);
        throw error;
    }
}

async function testResolveQboCustomer() {
    const provider = new MockQuickBooksProvider();

    const charge = {
        id: 'ch_123',
        billing_details: {
            name: 'Ada Lovelace',
            email: 'ada@example.com'
        },
        customer: {
            id: 'cus_123',
            name: 'Augusta Ada',
            email: 'ada@example.com'
        }
    };

    const resolved = await resolveQboCustomer(charge, provider);
    assert.strictEqual(resolved.id, 'cust-ada@example.com');
    assert.strictEqual(resolved.isFallback, false);
    assert.strictEqual(resolved.displayName, 'Ada Lovelace');

    const fallbackCharge = { id: 'ch_456', billing_details: {} };
    const fallback = await resolveQboCustomer(fallbackCharge, provider);
    assert.strictEqual(fallback.isFallback, true);
    assert.strictEqual(fallback.displayName, 'Unknown Donor (Stripe)');
}

async function testBuildChargeJournalEntry() {
    const provider = new MockQuickBooksProvider();
    const vendor = await ensureStripeVendor(provider, { vendorId: 'vendor-stripe', vendorName: 'Stripe' });
    const charge = {
        id: 'ch_789',
        created: 1700000000,
        payment_intent: 'pi_123',
        metadata: {
            campaign: 'Giving Tuesday',
            source_form: 'Landing Page'
        },
        receipt_url: 'https://stripe.test/receipt/ch_789',
        balance_transaction: {
            id: 'bt_123',
            type: 'charge',
            amount: 25000,
            fee: 725,
            net: 24275,
            currency: 'usd',
            payout: 'po_123'
        },
        billing_details: {
            name: 'Grace Hopper',
            email: 'grace@example.com'
        }
    };

    const customer = {
        id: 'cust-1',
        displayName: 'Grace Hopper'
    };

    const { journalEntry, attachments, amounts } = buildChargeJE(charge, accounts, vendor, customer, {
        companyHomeCurrency: 'USD',
        timezone: 'America/New_York'
    });

    assert.strictEqual(journalEntry.docNumber, 'STRIPE-ch_789');
    assert.ok(journalEntry.memo.includes('stripe:ch=ch_789'));
    assert.ok(journalEntry.memo.includes('bt=bt_123'));
    assert.ok(journalEntry.memo.includes('pi=pi_123'));
    assert.strictEqual(attachments.length, 1);
    assert.ok(attachments[0].includes('https://stripe.test/receipt/ch_789'));

    const totalDebits = journalEntry.lines.filter(l => l.type === 'debit').reduce((sum, line) => sum + line.amount, 0);
    const totalCredits = journalEntry.lines.filter(l => l.type === 'credit').reduce((sum, line) => sum + line.amount, 0);
    assert.strictEqual(totalDebits, totalCredits);
    assert.strictEqual(amounts.gross, 25000);
    assert.strictEqual(amounts.fee, 725);
    assert.strictEqual(amounts.net, 24275);

    const revenueLine = journalEntry.lines.find(line => line.accountId === accounts.revenueId);
    assert.strictEqual(revenueLine.entityRef.type, 'Customer');
    assert.strictEqual(revenueLine.entityRef.value, customer.id);

    const feeLine = journalEntry.lines.find(line => line.accountId === accounts.stripeFeesId);
    assert.strictEqual(feeLine.entityRef.type, 'Vendor');
    assert.strictEqual(feeLine.entityRef.value, vendor.id);

    const clearingLine = journalEntry.lines.find(line => line.accountId === accounts.stripeClearingId);
    assert.strictEqual(typeof clearingLine.entityRef, 'undefined');
}

async function testBalanceTransactionMappings() {
    const vendor = { id: 'vendor-stripe', name: 'Stripe', type: 'Vendor' };

    const refundBT = {
        id: 'bt_ref',
        type: 'refund',
        reporting_category: 'refund',
        amount: -1500,
        fee: 50,
        net: -1550,
        currency: 'usd',
        payout: 'po_123'
    };
    const refundMapped = mapBalanceTxnToEntries(refundBT, {
        accounts,
        vendor,
        refund: { id: 're_1', charge: 'ch_789' },
        charge: { id: 'ch_789', payment_intent: 'pi_123' }
    });
    assert.strictEqual(refundMapped.lines.length, 3);
    const refundClearing = refundMapped.lines.find(line => line.accountId === accounts.stripeClearingId);
    assert.strictEqual(refundClearing.type, 'credit');

    const disputeBT = {
        id: 'bt_dp',
        type: 'dispute',
        reporting_category: 'dispute',
        amount: -2000,
        fee: 150,
        net: -2150,
        currency: 'usd',
        payout: 'po_123'
    };
    const disputeMapped = mapBalanceTxnToEntries(disputeBT, {
        accounts,
        vendor,
        dispute: { id: 'dp_1', charge: 'ch_789' },
        charge: { id: 'ch_789', payment_intent: 'pi_123' }
    });
    assert.strictEqual(disputeMapped.lines.length, 3);
    const disputeFeeLine = disputeMapped.lines.find(line => line.accountId === accounts.stripeFeesId);
    assert.strictEqual(disputeFeeLine.type, 'debit');

    const feeBT = {
        id: 'bt_fee',
        type: 'fee',
        reporting_category: 'fee',
        amount: -300,
        fee: 0,
        net: -300,
        currency: 'usd',
        payout: 'po_123'
    };
    const feeMapped = mapBalanceTxnToEntries(feeBT, { accounts, vendor });
    assert.strictEqual(feeMapped.lines.length, 2);
    assert.strictEqual(feeMapped.lines[0].type, 'debit');

    const feeRefundBT = {
        id: 'bt_fee_ref',
        type: 'fee_refund',
        reporting_category: 'fee_refund',
        amount: 100,
        fee: 0,
        net: 100,
        currency: 'usd',
        payout: 'po_123'
    };
    const feeRefundMapped = mapBalanceTxnToEntries(feeRefundBT, { accounts, vendor });
    assert.strictEqual(feeRefundMapped.lines[0].type, 'credit');
    assert.strictEqual(feeRefundMapped.lines[1].type, 'debit');

    const adjustmentBT = {
        id: 'bt_adj',
        type: 'adjustment',
        reporting_category: 'other_adjustment',
        amount: 500,
        fee: 0,
        net: 500,
        currency: 'usd'
    };
    const disputeReversalBT = {
        id: 'bt_dr',
        type: 'dispute',
        reporting_category: 'dispute_reversal',
        amount: 2000,
        fee: -150,
        net: 2150,
        currency: 'usd',
        payout: 'po_123'
    };

    const disputeReversalMapped = mapBalanceTxnToEntries(disputeReversalBT, {
        accounts,
        vendor,
        dispute: { id: 'dp_1', charge: 'ch_789' },
        charge: { id: 'ch_789', payment_intent: 'pi_123' }
    });
    assert.strictEqual(disputeReversalMapped.lines.length, 3);
    const reversalRefund = disputeReversalMapped.lines.find(line => line.accountId === accounts.refundsContraId);
    assert.strictEqual(reversalRefund.type, 'credit');
    const reversalClearing = disputeReversalMapped.lines.find(line => line.accountId === accounts.stripeClearingId);
    assert.strictEqual(reversalClearing.type, 'debit');

    const adjustmentMapped = mapBalanceTxnToEntries(adjustmentBT, { accounts, vendor });
    assert.strictEqual(adjustmentMapped.lines[0].accountId, accounts.adjustments.default);
    assert.strictEqual(adjustmentMapped.lines[0].type, 'debit');
}

async function testPayoutReconciliationAndTransfer() {
    const provider = new MockQuickBooksProvider();
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'stripe-qbo-store-'));
    const store = new ProcessedStripeStore({ storagePath: path.join(tmpDir, 'state.json') });

    const chargeBT = {
        id: 'bt_charge',
        type: 'charge',
        amount: 30000,
        fee: 900,
        net: 29100,
        currency: 'usd',
        payout: 'po_partial'
    };
    const chargeMapped = mapBalanceTxnToEntries(chargeBT, {
        accounts,
        vendor: { id: 'vendor-stripe', name: 'Stripe' },
        charge: {
            id: 'ch_partial',
            payment_intent: 'pi_partial',
            metadata: {}
        },
        customer: { id: 'cust-partial', displayName: 'Partial Donor' }
    });

    const refundBT = {
        id: 'bt_refund_partial',
        type: 'refund',
        amount: -5000,
        fee: 0,
        net: -5000,
        currency: 'usd',
        payout: 'po_partial'
    };
    const refundMapped = mapBalanceTxnToEntries(refundBT, {
        accounts,
        vendor: { id: 'vendor-stripe', name: 'Stripe' },
        refund: { id: 're_partial', charge: 'ch_partial' },
        charge: { id: 'ch_partial', payment_intent: 'pi_partial' }
    });

    const payout = {
        id: 'po_partial',
        amount: 24100,
        currency: 'usd',
        arrival_date: 1700100000
    };

    const reconciliation = reconcilePayout(payout, [chargeMapped, refundMapped], { companyHomeCurrency: 'USD' });
    assert.strictEqual(reconciliation.payoutAmount, 24100);
    assert.strictEqual(reconciliation.clearingImpact, 24100);

    const transferResult = await postTransferIfNew(payout, provider, {
        accounts,
        store,
        companyHomeCurrency: 'USD'
    });
    assert.strictEqual(transferResult.status, 'created');

    const transferReplay = await postTransferIfNew(payout, provider, {
        accounts,
        store,
        companyHomeCurrency: 'USD'
    });
    assert.strictEqual(transferReplay.status, 'skipped');
}

async function testJournalEntryIdempotencyWithAttachments() {
    const provider = new MockQuickBooksProvider();
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'stripe-qbo-store-'));
    const store = new ProcessedStripeStore({ storagePath: path.join(tmpDir, 'state.json') });

    const journalEntry = {
        docNumber: 'STRIPE-ch_12345',
        date: '2023-11-15',
        memo: 'stripe:ch=ch_12345;pi=pi_12345;bt=bt_12345;payout=po_1;customer=cust_1',
        lines: [
            { type: 'credit', accountId: accounts.revenueId, amount: 10000 },
            { type: 'debit', accountId: accounts.stripeFeesId, amount: 300, entityRef: { type: 'Vendor', value: 'vendor-stripe' } },
            { type: 'debit', accountId: accounts.stripeClearingId, amount: 9700 }
        ]
    };

    const first = await postJEIfNew(journalEntry, provider, {
        store,
        attachments: ['https://stripe.test/receipt/ch_12345']
    });
    assert.strictEqual(first.status, 'created');
    assert.strictEqual(provider.attachments.length, 1);

    const second = await postJEIfNew(journalEntry, provider, { store });
    assert.strictEqual(second.status, 'skipped');
}

async function testMulticurrencyConversion() {
    const provider = new MockQuickBooksProvider();
    const vendor = { id: 'vendor-stripe', name: 'Stripe' };
    const customer = { id: 'cust-eur', displayName: 'Euro Donor' };

    const charge = {
        id: 'ch_eur',
        created: 1700200000,
        payment_intent: 'pi_eur',
        metadata: {},
        balance_transaction: {
            id: 'bt_eur',
            type: 'charge',
            amount: 10000,
            fee: 300,
            net: 9700,
            currency: 'eur',
            exchange_rate: 1.1
        }
    };

    const { journalEntry, amounts } = buildChargeJE(charge, accounts, vendor, customer, {
        companyHomeCurrency: 'USD'
    });

    assert.ok(journalEntry.memo.includes('fx=1.1'));
    assert.strictEqual(amounts.gross, 11000);
    assert.strictEqual(amounts.fee, 330);
    assert.strictEqual(amounts.net, 10670);
    const debits = journalEntry.lines.filter(line => line.type === 'debit').reduce((sum, line) => sum + line.amount, 0);
    const credits = journalEntry.lines.filter(line => line.type === 'credit').reduce((sum, line) => sum + line.amount, 0);
    assert.strictEqual(debits, credits);
}

async function testAttachmentsHelper() {
    const provider = new MockQuickBooksProvider();
    await attachStripeArtifacts(provider, 'je-123', [
        'https://stripe.test/receipt/ch_1',
        { charge: 'ch_1', amount: 1000 }
    ]);
    assert.strictEqual(provider.attachments.length, 2);
}

async function testConvertPayoutAmount() {
    const payout = { amount: 10000, currency: 'usd' };
    const amount = convertPayoutAmount(payout, 'USD');
    assert.strictEqual(amount, 10000);

    const fxPayout = { amount: 10000, currency: 'eur', exchange_rate: 1.2 };
    const fxAmount = convertPayoutAmount(fxPayout, 'USD');
    assert.strictEqual(fxAmount, 12000);
}

function createMockFs(delayMs = 5) {
    const files = new Map();
    const mockFs = {
        writes: [],
        async mkdir() { return; },
        async readFile(file) {
            if (!files.has(file)) {
                const error = new Error('Not found');
                error.code = 'ENOENT';
                throw error;
            }
            return files.get(file);
        },
        async writeFile(file, contents) {
            await delay(delayMs);
            files.set(file, contents);
            mockFs.writes.push(JSON.parse(contents));
        }
    };
    return mockFs;
}

async function testProcessedStoreDurableFlush() {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'stripe-qbo-store-'));
    const storagePath = path.join(tmpDir, 'state.json');
    const mockFs = createMockFs(20);
    const store = new ProcessedStripeStore({ storagePath, fs: mockFs, logger: console });

    await Promise.all([
        store.recordProcessed({ stripeId: 'evt-1', qboEntityId: 'je-1' }),
        (async () => {
            await delay(5);
            return store.recordProcessed({ stripeId: 'evt-2', qboEntityId: 'je-2' });
        })()
    ]);

    await store.flush();

    const persistedRaw = await mockFs.readFile(storagePath);
    const persisted = JSON.parse(persistedRaw);
    assert.ok(persisted['evt-1']);
    assert.ok(persisted['evt-2']);
    const finalWrite = mockFs.writes[mockFs.writes.length - 1];
    assert.ok(finalWrite['evt-1']);
    assert.ok(finalWrite['evt-2']);
}

async function testNormalizeAmountUtility() {
    assert.strictEqual(normalizeAmount(1050, 'usd'), 10.5);
    assert.strictEqual(normalizeAmount(12345, 'KWD'), 12.345);
    assert.strictEqual(normalizeAmount(500, 'jpy'), 500);
    assert.strictEqual(normalizeAmount(null, 'usd'), 0);
}

(async () => {
    await runTest('Resolves customers with fallback handling', testResolveQboCustomer);
    await runTest('Builds balanced charge journal entry with correct EntityRefs', testBuildChargeJournalEntry);
    await runTest('Maps refunds, disputes, fees, fee refunds, and adjustments correctly', testBalanceTransactionMappings);
    await runTest('Reconciles payout clearing impact and posts transfer idempotently', testPayoutReconciliationAndTransfer);
    await runTest('Prevents duplicate journal entries and stores attachments', testJournalEntryIdempotencyWithAttachments);
    await runTest('Handles multicurrency conversion with memo tagging', testMulticurrencyConversion);
    await runTest('Creates Stripe artifact attachments', testAttachmentsHelper);
    await runTest('Converts payout amounts respecting FX rates', testConvertPayoutAmount);
    await runTest('Flushes ProcessedStripeStore with concurrent writes', testProcessedStoreDurableFlush);
    await runTest('Normalizes Stripe integer amounts by currency exponent', testNormalizeAmountUtility);

    console.log('All Stripe ↔ QBO sync tests passed');
})().catch(error => {
    console.error(error);
    process.exit(1);
});
