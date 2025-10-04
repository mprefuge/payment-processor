const processTransaction = require('../processTransaction');

function createMockContext() {
    const logs = [];
    return {
        log: (...args) => {
            logs.push(args);
        },
        res: null,
        logs
    };
}

async function runLoggingSecurityTests() {
    console.log('🧪 Running Logging Security Tests\n');

    let testsPassed = 0;
    let testsTotal = 0;

    const originalSecureDebug = process.env.SECURE_DEBUG;

    const test = async (name, fn) => {
        testsTotal++;
        try {
            await fn();
            console.log(`✅ ${name}`);
            testsPassed++;
        } catch (error) {
            console.log(`❌ ${name}: ${error.message}`);
        }
    };

    const assert = (condition, message) => {
        if (!condition) {
            throw new Error(message);
        }
    };

    await test('Logs exclude sensitive payload details when secure debug disabled', async () => {
        delete process.env.SECURE_DEBUG;

        const context = createMockContext();
        const req = {
            body: {
                email: 'alice@example.com',
                firstname: 'Alice',
                lastname: 'Doe',
                phone: '+15555555555',
                address: {
                    line1: '123 Main St',
                    postal_code: '12345'
                },
                amount: 5000
            }
        };

        await processTransaction(context, req);

        const combinedLogs = JSON.stringify(context.logs);
        assert(!combinedLogs.includes('alice@example.com'), 'Email should not appear in logs');
        assert(!combinedLogs.includes('Alice'), 'First name should not appear in logs');
        assert(!combinedLogs.includes('Doe'), 'Last name should not appear in logs');
        assert(!combinedLogs.includes('123 Main St'), 'Address should not appear in logs');

        const debugLog = context.logs.find(([message]) => message === 'Secure debug payload snapshot');
        assert(!debugLog, 'Secure debug log should be absent when SECURE_DEBUG is disabled');

        const summaryLog = context.logs.find(([message]) => message === 'Request body summary');
        assert(summaryLog, 'Request body summary log should exist');
        const summaryData = summaryLog[1];
        assert(Array.isArray(summaryData.receivedFields), 'Summary should include received fields');
        assert(summaryData.receivedFields.includes('email'), 'Summary should list email field');
    });

    await test('Secure debug log redacts sensitive fields when enabled', async () => {
        process.env.SECURE_DEBUG = 'true';

        const context = createMockContext();
        const req = {
            body: {
                email: 'bob@example.com',
                firstname: 'Bob',
                lastname: 'Smith',
                phone: '+15551234567',
                address: {
                    line1: '456 Market St',
                    postal_code: '67890'
                },
                amount: 7500
            }
        };

        await processTransaction(context, req);

        const debugLog = context.logs.find(([message]) => message === 'Secure debug payload snapshot');
        assert(debugLog, 'Secure debug log should be present when SECURE_DEBUG is true');
        const payload = debugLog[1].payload;
        assert(payload.email === '[REDACTED]', 'Email should be redacted');
        assert(payload.firstname === '[REDACTED]', 'First name should be redacted');
        assert(payload.lastname === '[REDACTED]', 'Last name should be redacted');
        assert(payload.phone === '[REDACTED]', 'Phone should be redacted');
        assert(payload.address.line1 === '[REDACTED]', 'Address line should be redacted');
        assert(payload.address.postal_code === '[REDACTED]', 'Postal code should be redacted');
        assert(payload.amount === 7500, 'Non-sensitive amount should remain');
    });

    process.env.SECURE_DEBUG = originalSecureDebug;

    console.log(`\n📊 Logging Security Test Results: ${testsPassed}/${testsTotal} tests passed`);

    if (testsPassed === testsTotal) {
        console.log('🎉 All logging security tests passed!');
        return true;
    }

    console.log('❌ Some logging security tests failed');
    return false;
}

if (require.main === module) {
    runLoggingSecurityTests().then(success => {
        process.exit(success ? 0 : 1);
    });
}

module.exports = { runLoggingSecurityTests };
