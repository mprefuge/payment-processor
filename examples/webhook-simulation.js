#!/usr/bin/env node

/**
 * Simulate Stripe webhook requests for testing
 * This creates example payloads that match what Stripe would send
 */

// Example 1: Manual payout.created event
const manualPayoutCreated = {
    id: "evt_test_manual_created_001",
    object: "event",
    api_version: "2023-10-16",
    created: Math.floor(Date.now() / 1000),
    data: {
        object: {
            id: "po_test_manual_001",
            object: "payout",
            amount: 2365,
            arrival_date: Math.floor(Date.now() / 1000) + 86400, // Tomorrow
            automatic: false,
            balance_transaction: "txn_test_001",
            created: Math.floor(Date.now() / 1000),
            currency: "usd",
            description: "Manual payout",
            destination: "ba_test_001",
            failure_code: null,
            failure_message: null,
            livemode: false,
            metadata: {},
            method: "standard",
            source_type: "card",
            statement_descriptor: null,
            status: "in_transit",
            type: "bank_account"
        }
    },
    livemode: false,
    pending_webhooks: 1,
    request: {
        id: null,
        idempotency_key: null
    },
    type: "payout.created"
};

// Example 2: Manual payout.paid event
const manualPayoutPaid = {
    ...manualPayoutCreated,
    id: "evt_test_manual_paid_001",
    type: "payout.paid",
    data: {
        object: {
            ...manualPayoutCreated.data.object,
            status: "paid"
        }
    }
};

// Example 3: Automatic payout.created event (platform)
const automaticPayoutCreated = {
    ...manualPayoutCreated,
    id: "evt_test_auto_created_001",
    type: "payout.created",
    data: {
        object: {
            ...manualPayoutCreated.data.object,
            id: "po_test_auto_001",
            automatic: true,
            description: "STRIPE PAYOUT"
        }
    }
};

// Example 4: Automatic payout.paid event (platform)
const automaticPayoutPaid = {
    ...automaticPayoutCreated,
    id: "evt_test_auto_paid_001",
    type: "payout.paid",
    data: {
        object: {
            ...automaticPayoutCreated.data.object,
            status: "paid"
        }
    }
};

// Example 5: Connected account payout.created
const connectedPayoutCreated = {
    ...automaticPayoutCreated,
    id: "evt_test_connected_created_001",
    type: "payout.created",
    data: {
        object: {
            ...automaticPayoutCreated.data.object,
            id: "po_test_connected_001"
        }
    }
};

// Example 6: Connected account payout.paid (with Stripe-Account header)
const connectedPayoutPaid = {
    ...connectedPayoutCreated,
    id: "evt_test_connected_paid_001",
    type: "payout.paid",
    data: {
        object: {
            ...connectedPayoutCreated.data.object,
            status: "paid"
        }
    }
};

// Generate curl commands to test the webhook endpoint
console.log("=".repeat(80));
console.log("STRIPE WEBHOOK SIMULATION - HTTP REQUEST EXAMPLES");
console.log("=".repeat(80));
console.log("\nThese examples show what Stripe would send to your webhook endpoint.");
console.log("Note: In production, you need to verify the stripe-signature header.\n");

console.log("\n1. MANUAL PAYOUT - CREATED EVENT");
console.log("-".repeat(80));
console.log("curl -X POST http://localhost:7071/api/stripe/webhook \\");
console.log("  -H 'Content-Type: application/json' \\");
console.log("  -H 'User-Agent: Stripe/1.0 (+https://stripe.com/docs/webhooks)' \\");
console.log("  -d '" + JSON.stringify(manualPayoutCreated, null, 2).replace(/'/g, "'\\''") + "'");

console.log("\n2. MANUAL PAYOUT - PAID EVENT");
console.log("-".repeat(80));
console.log("curl -X POST http://localhost:7071/api/stripe/webhook \\");
console.log("  -H 'Content-Type: application/json' \\");
console.log("  -H 'User-Agent: Stripe/1.0 (+https://stripe.com/docs/webhooks)' \\");
console.log("  -d '" + JSON.stringify(manualPayoutPaid, null, 2).replace(/'/g, "'\\''") + "'");

console.log("\n3. AUTOMATIC PAYOUT (PLATFORM) - CREATED EVENT");
console.log("-".repeat(80));
console.log("curl -X POST http://localhost:7071/api/stripe/webhook \\");
console.log("  -H 'Content-Type: application/json' \\");
console.log("  -H 'User-Agent: Stripe/1.0 (+https://stripe.com/docs/webhooks)' \\");
console.log("  -d '" + JSON.stringify(automaticPayoutCreated, null, 2).replace(/'/g, "'\\''") + "'");

console.log("\n4. AUTOMATIC PAYOUT (PLATFORM) - PAID EVENT");
console.log("-".repeat(80));
console.log("curl -X POST http://localhost:7071/api/stripe/webhook \\");
console.log("  -H 'Content-Type: application/json' \\");
console.log("  -H 'User-Agent: Stripe/1.0 (+https://stripe.com/docs/webhooks)' \\");
console.log("  -d '" + JSON.stringify(automaticPayoutPaid, null, 2).replace(/'/g, "'\\''") + "'");

console.log("\n5. CONNECTED ACCOUNT PAYOUT - CREATED EVENT");
console.log("-".repeat(80));
console.log("curl -X POST http://localhost:7071/api/stripe/webhook \\");
console.log("  -H 'Content-Type: application/json' \\");
console.log("  -H 'User-Agent: Stripe/1.0 (+https://stripe.com/docs/webhooks)' \\");
console.log("  -H 'Stripe-Account: acct_test_connected_001' \\");
console.log("  -d '" + JSON.stringify(connectedPayoutCreated, null, 2).replace(/'/g, "'\\''") + "'");

console.log("\n6. CONNECTED ACCOUNT PAYOUT - PAID EVENT");
console.log("-".repeat(80));
console.log("curl -X POST http://localhost:7071/api/stripe/webhook \\");
console.log("  -H 'Content-Type: application/json' \\");
console.log("  -H 'User-Agent: Stripe/1.0 (+https://stripe.com/docs/webhooks)' \\");
console.log("  -H 'Stripe-Account: acct_test_connected_001' \\");
console.log("  -d '" + JSON.stringify(connectedPayoutPaid, null, 2).replace(/'/g, "'\\''") + "'");

console.log("\n" + "=".repeat(80));
console.log("\nSIMPLIFIED JSON PAYLOADS (for documentation):");
console.log("=".repeat(80));

console.log("\n1. Manual Payout Created:");
console.log(JSON.stringify(manualPayoutCreated, null, 2));

console.log("\n2. Manual Payout Paid:");
console.log(JSON.stringify(manualPayoutPaid, null, 2));

console.log("\n3. Automatic Payout Created:");
console.log(JSON.stringify(automaticPayoutCreated, null, 2));

console.log("\n4. Automatic Payout Paid:");
console.log(JSON.stringify(automaticPayoutPaid, null, 2));

console.log("\n5. Connected Account Payout Created:");
console.log(JSON.stringify(connectedPayoutCreated, null, 2));

console.log("\n6. Connected Account Payout Paid:");
console.log(JSON.stringify(connectedPayoutPaid, null, 2));
