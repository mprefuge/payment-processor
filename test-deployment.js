#!/usr/bin/env node

/**
 * Test script to verify the deployed Azure Function
 * Usage: node test-deployment.js [function-url] [function-key]
 * 
 * Example:
 * node test-deployment.js https://payment-processing-function.azurewebsites.net/api/donation your-function-key
 */

const https = require('https');
const http = require('http');

const functionUrl = process.argv[2] || 'http://localhost:7071/api/donation';
const functionKey = process.argv[3];

if (!functionUrl) {
    console.error('❌ Please provide the function URL as the first argument');
    console.log('Usage: node test-deployment.js [function-url] [function-key]');
    process.exit(1);
}

console.log('🔍 Testing Azure Function deployment...');
console.log('📍 URL:', functionUrl);
console.log('🔑 Using function key:', functionKey ? 'Yes' : 'No (local testing)');

const testPayload = {
    email: 'test@example.com',
    firstname: 'Test',
    lastname: 'User',
    amount: 2500, // $25.00 in cents
    frequency: 'onetime',
    livemode: false,
    category: 'Test Donation'
};

const postData = JSON.stringify(testPayload);

const url = new URL(functionUrl);
const isHttps = url.protocol === 'https:';
const requestModule = isHttps ? https : http;

const options = {
    hostname: url.hostname,
    port: url.port || (isHttps ? 443 : 80),
    path: url.pathname + (url.search || ''),
    method: 'POST',
    headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData)
    }
};

// Add function key header if provided
if (functionKey) {
    options.headers['x-functions-key'] = functionKey;
}

console.log('\n📤 Sending test request...');
console.log('📋 Payload:', JSON.stringify(testPayload, null, 2));

const req = requestModule.request(options, (res) => {
    console.log('\n📨 Response received:');
    console.log('📊 Status Code:', res.statusCode);
    console.log('📝 Headers:', JSON.stringify(res.headers, null, 2));
    
    let data = '';
    res.on('data', (chunk) => {
        data += chunk;
    });
    
    res.on('end', () => {
        console.log('\n📄 Response Body:');
        try {
            const jsonResponse = JSON.parse(data);
            console.log(JSON.stringify(jsonResponse, null, 2));
            
            if (res.statusCode === 200 && jsonResponse.success) {
                console.log('\n✅ Function test PASSED!');
                console.log('🔗 Checkout URL:', jsonResponse.checkoutUrl);
                if (jsonResponse.sessionId) {
                    console.log('🆔 Session ID:', jsonResponse.sessionId);
                }
            } else {
                console.log('\n❌ Function test FAILED!');
                console.log('Expected status 200 with success: true');
            }
        } catch (error) {
            console.log(data);
            console.log('\n⚠️  Response is not valid JSON');
            if (res.statusCode === 200) {
                console.log('✅ Function responded successfully (non-JSON response)');
            } else {
                console.log('❌ Function test FAILED!');
            }
        }
    });
});

req.on('error', (error) => {
    console.error('\n❌ Request failed:', error.message);
    console.log('🔧 Troubleshooting tips:');
    console.log('   • Check if the function URL is correct');
    console.log('   • Verify the function key (if required)');
    console.log('   • Ensure the function is deployed and running');
    console.log('   • Check Azure Function logs for errors');
});

req.write(postData);
req.end();

console.log('⏳ Waiting for response...');