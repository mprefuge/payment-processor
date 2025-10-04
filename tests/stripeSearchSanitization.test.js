const processTransaction = require('../processTransaction');

const { searchStripeCustomer, escapeStripeQueryValue } = processTransaction.__internals;

async function runStripeSearchSanitizationTests() {
    console.log('🧪 Running Stripe Search Sanitization Tests\n');

    let testsPassed = 0;
    let testsTotal = 0;

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

    const assertEqual = (actual, expected, message = '') => {
        if (actual !== expected) {
            throw new Error(`Expected ${expected}, got ${actual}. ${message}`);
        }
    };

    await test('escapeStripeQueryValue escapes apostrophes', async () => {
        const input = "O'Brien";
        const expected = "O\\'Brien";
        const result = escapeStripeQueryValue(input);
        assertEqual(result, expected, 'Apostrophes should be escaped with backslashes');
    });

    await test('searchStripeCustomer escapes apostrophes in queries', async () => {
        const email = "obrien'o@example.com";
        const fullName = "Jamie O'Brien";
        let capturedQuery = null;

        const fakeStripe = {
            customers: {
                search: async ({ query }) => {
                    capturedQuery = query;
                    return { data: [] };
                }
            }
        };

        await searchStripeCustomer(fakeStripe, email, fullName);

        const expectedQuery = "email:'obrien\\'o@example.com' AND name:'Jamie O\\'Brien'";
        assertEqual(capturedQuery, expectedQuery, 'Query should escape apostrophes in both email and name');
    });

    console.log(`\n📊 Stripe Search Sanitization Test Results: ${testsPassed}/${testsTotal} tests passed`);

    if (testsPassed === testsTotal) {
        console.log('🎉 All stripe search sanitization tests passed!');
        return true;
    }

    console.log('❌ Some stripe search sanitization tests failed');
    return false;
}

if (require.main === module) {
    runStripeSearchSanitizationTests().then(success => {
        process.exit(success ? 0 : 1);
    });
}

module.exports = { runStripeSearchSanitizationTests };
