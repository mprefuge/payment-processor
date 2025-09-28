// Simple test script to validate the Azure Function locally
// Run with: node test.js

const testPayload = {
    email: "test@example.com",
    firstname: "John",
    lastname: "Doe",
    phone: "+1234567890",
    amount: 5000, // $50.00 in cents
    frequency: "onetime",
    category: "General Donation",
    coverFee: true,
    livemode: false,
    address: {
        line1: "123 Main St",
        line2: "Apt 4B",
        city: "New York",
        state: "NY",
        postal_code: "10001",
        country: "US"
    }
};

async function testFunction() {
    try {
        console.log('Testing Azure Function locally...');
        console.log('Make sure to start the function with: npm start');
        console.log('Testing with payload:', JSON.stringify(testPayload, null, 2));
        console.log('\n--- Making request ---');
        
        // Use node's built-in fetch if available (Node 18+) or require node-fetch
        let fetch;
        try {
            fetch = globalThis.fetch;
        } catch {
            try {
                fetch = require('node-fetch');
            } catch (e) {
                console.log('❌ fetch not available. Install node-fetch: npm install node-fetch@2');
                return;
            }
        }
        
        const response = await fetch('http://localhost:7071/api/donation', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(testPayload)
        });
        
        console.log('Response Status:', response.status);
        console.log('Response Headers:', Object.fromEntries(response.headers.entries()));
        
        let result;
        try {
            result = await response.json();
            console.log('Response Body:', result);
        } catch (e) {
            const text = await response.text();
            console.log('Response Text:', text);
            result = { error: 'Could not parse response as JSON' };
        }
        
        if (response.ok) {
            console.log('✅ Test passed! Checkout session ID:', result.id);
        } else {
            console.log('❌ Test failed with status:', response.status);
            console.log('Error:', result.error || result);
        }
        
    } catch (error) {
        console.error('❌ Test error:', error.message);
        console.log('Make sure the Azure Function is running locally on port 7071');
        console.log('Start it with: func start or npm start');
    }
}

// Test using curl command (alternative)
function showCurlCommand() {
    console.log('\n--- Alternative: Test with curl ---');
    console.log('curl -X POST http://localhost:7071/api/donation \\');
    console.log('  -H "Content-Type: application/json" \\');
    console.log('  -d \'' + JSON.stringify(testPayload) + '\'');
}

// Alternative test payload for recurring donation
const testRecurringPayload = {
    ...testPayload,
    frequency: "month",
    amount: 2500 // $25.00 monthly
};

console.log('=== Azure Function Test ===');
testFunction().then(() => {
    showCurlCommand();
    console.log('\n--- Test Payloads ---');
    console.log('1. One-time donation:', JSON.stringify(testPayload, null, 2));
    console.log('2. Recurring donation:', JSON.stringify(testRecurringPayload, null, 2));
});