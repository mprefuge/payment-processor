/**
 * ContactMatcher Tests
 * 
 * Basic tests to verify core functionality of the ContactMatcher service
 */

const { ContactMatcher, JaroWinkler } = require('../services/contactMatcher');
const { loadConfig } = require('../config/contactMatching');

// Simple test runner since we don't have a testing framework installed
function runTests() {
    console.log('🧪 Running ContactMatcher Tests\n');
    
    let testsPassed = 0;
    let testsTotal = 0;
    
    function test(name, testFn) {
        testsTotal++;
        try {
            testFn();
            console.log(`✅ ${name}`);
            testsPassed++;
        } catch (error) {
            console.log(`❌ ${name}: ${error.message}`);
        }
    }
    
    function assertEqual(actual, expected, message = '') {
        if (actual !== expected) {
            throw new Error(`Expected ${expected}, got ${actual}. ${message}`);
        }
    }
    
    function assertGreaterThan(actual, threshold, message = '') {
        if (actual <= threshold) {
            throw new Error(`Expected ${actual} to be greater than ${threshold}. ${message}`);
        }
    }
    
    function assertTrue(condition, message = '') {
        if (!condition) {
            throw new Error(`Expected condition to be true. ${message}`);
        }
    }
    
    // Test JaroWinkler distance
    test('JaroWinkler exact match', () => {
        assertEqual(JaroWinkler.distance('John', 'John'), 1);
    });
    
    test('JaroWinkler similar names', () => {
        const distance = JaroWinkler.distance('John', 'Jon');
        assertGreaterThan(distance, 0.8, 'Similar names should have high similarity');
    });
    
    test('JaroWinkler different names', () => {
        const distance = JaroWinkler.distance('John', 'Mary');
        assertTrue(distance < 0.5, 'Different names should have low similarity');
    });
    
    // Test ContactMatcher initialization
    test('ContactMatcher initialization with defaults', () => {
        const matcher = new ContactMatcher();
        assertEqual(matcher.config.thresholds.high, 0.90);
        assertEqual(matcher.config.thresholds.low, 0.60);
    });
    
    test('ContactMatcher initialization with custom config', () => {
        const customConfig = { thresholds: { high: 0.95, low: 0.70 } };
        const matcher = new ContactMatcher(customConfig);
        assertEqual(matcher.config.thresholds.high, 0.95);
        assertEqual(matcher.config.thresholds.low, 0.70);
    });
    
    // Test normalization
    test('Email normalization - basic', () => {
        const matcher = new ContactMatcher();
        const normalized = matcher.normalize({ email: '  JOHN.DOE@EXAMPLE.COM  ' });
        assertEqual(normalized.email, 'john.doe@example.com');
    });
    
    test('Email normalization - plus tag removal', () => {
        const matcher = new ContactMatcher();
        const normalized = matcher.normalize({ email: 'user+tag@example.com' });
        assertEqual(normalized.email, 'user@example.com');
    });
    
    test('Phone normalization - US format', () => {
        const matcher = new ContactMatcher();
        const normalized = matcher.normalize({ phone: '(555) 123-4567' });
        assertEqual(normalized.phone, '15551234567');
    });
    
    test('Phone normalization - already formatted', () => {
        const matcher = new ContactMatcher();
        const normalized = matcher.normalize({ phone: '15551234567' });
        assertEqual(normalized.phone, '15551234567');
    });
    
    test('Name normalization', () => {
        const matcher = new ContactMatcher();
        const normalized = matcher.normalize({ 
            firstName: '  john  ', 
            lastName: '  DOE  ' 
        });
        assertEqual(normalized.firstName, 'John');
        assertEqual(normalized.lastName, 'Doe');
        assertEqual(normalized.fullName, 'John Doe');
    });
    
    // Test scoring
    test('Candidate scoring - exact email match', () => {
        const matcher = new ContactMatcher();
        const normalized = { email: 'john@example.com' };
        const candidate = { Email: 'john@example.com' };
        
        const scores = matcher.scoreCandidate(candidate, normalized);
        assertEqual(scores.email, 0.7); // default weight
        assertEqual(scores.breakdown.email, 'exact');
    });
    
    test('Candidate scoring - exact name match', () => {
        const matcher = new ContactMatcher();
        const normalized = { firstName: 'John', lastName: 'Doe' };
        const candidate = { FirstName: 'John', LastName: 'Doe' };
        
        const scores = matcher.scoreCandidate(candidate, normalized);
        assertEqual(scores.name, 0.5); // default weight
        assertEqual(scores.breakdown.name, 'exact');
    });
    
    test('Candidate scoring - phone match', () => {
        const matcher = new ContactMatcher();
        const normalized = { phone: '15551234567' };
        const candidate = { Phone: '15551234567' };
        
        const scores = matcher.scoreCandidate(candidate, normalized);
        assertEqual(scores.phone, 0.6); // default weight
        assertEqual(scores.breakdown.phone, 'exact');
    });
    
    // Test decision making
    test('Decision making - high confidence', () => {
        const matcher = new ContactMatcher();
        const candidatesWithScores = [{
            candidate: { Id: '123', FirstName: 'John', LastName: 'Doe' },
            scores: { total: 0.95 }
        }];
        
        const decision = matcher.decide(candidatesWithScores, {});
        assertEqual(decision.action, 'associate');
        assertEqual(decision.confidence, 'high');
        assertEqual(decision.reviewRequired, false);
    });
    
    test('Decision making - medium confidence', () => {
        const matcher = new ContactMatcher();
        const candidatesWithScores = [{
            candidate: { Id: '123', FirstName: 'John', LastName: 'Doe' },
            scores: { total: 0.75 }
        }];
        
        const decision = matcher.decide(candidatesWithScores, {});
        assertEqual(decision.action, 'review');
        assertEqual(decision.confidence, 'medium');
        assertEqual(decision.reviewRequired, true);
    });
    
    test('Decision making - low confidence', () => {
        const matcher = new ContactMatcher();
        const candidatesWithScores = [{
            candidate: { Id: '123', FirstName: 'John', LastName: 'Doe' },
            scores: { total: 0.30 }
        }];
        
        const decision = matcher.decide(candidatesWithScores, {});
        assertEqual(decision.action, 'review');
        assertEqual(decision.confidence, 'low');
        assertEqual(decision.reviewRequired, true);
    });
    
    test('Decision making - no candidates', () => {
        const matcher = new ContactMatcher();
        const decision = matcher.decide([], {});
        assertEqual(decision.action, 'review');
        assertEqual(decision.reason, 'no_viable_candidates');
        assertEqual(decision.reviewRequired, true);
    });
    
    // Summary
    console.log(`\n📊 Test Results: ${testsPassed}/${testsTotal} tests passed`);
    
    if (testsPassed === testsTotal) {
        console.log('🎉 All tests passed!');
        return true;
    } else {
        console.log('❌ Some tests failed');
        return false;
    }
}

// Run tests if this file is executed directly
if (require.main === module) {
    const success = runTests();
    process.exit(success ? 0 : 1);
}

module.exports = { runTests };