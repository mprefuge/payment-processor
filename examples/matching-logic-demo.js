/**
 * Demonstration of New Matching Logic
 * 
 * This script demonstrates the new matching behavior:
 * 1. Email + Phone + Name all match → Update existing contact
 * 2. Email + Phone match but Name differs → Create review task + Create new contact
 * 3. Name matches but Email or Phone differ → Create review task + Create new contact
 * 4. Otherwise → Create new contact (no review)
 */

const { ContactMatcher } = require('../services/contactMatcher');

console.log('='.repeat(80));
console.log('NEW MATCHING LOGIC DEMONSTRATION');
console.log('='.repeat(80));

const matcher = new ContactMatcher();

// Mock existing contacts in database
const existingContacts = [
    {
        Id: 'contact_001',
        FirstName: 'John',
        LastName: 'Doe',
        Email: 'john.doe@example.com',
        Phone: '15551234567'
    },
    {
        Id: 'contact_002',
        FirstName: 'Jane',
        LastName: 'Smith',
        Email: 'jane.smith@example.com',
        Phone: '15559876543'
    }
];

console.log('\n📋 EXISTING CONTACTS IN DATABASE:');
existingContacts.forEach((c, i) => {
    console.log(`   ${i + 1}. ${c.FirstName} ${c.LastName} - ${c.Email} - ${c.Phone}`);
});

// Helper function to process a transaction
function processTransaction(scenario, transactionData) {
    console.log('\n' + '='.repeat(80));
    console.log(`SCENARIO ${scenario.num}: ${scenario.name}`);
    console.log('='.repeat(80));
    
    console.log('\n📝 Transaction Data:');
    console.log(`   Name: ${transactionData.firstName} ${transactionData.lastName}`);
    console.log(`   Email: ${transactionData.email}`);
    console.log(`   Phone: ${transactionData.phone}`);
    
    // Score all candidates
    const candidatesWithScores = existingContacts.map(candidate => ({
        candidate,
        scores: matcher.scoreCandidate(candidate, {
            email: matcher._normalizeEmail(transactionData.email),
            phone: matcher._normalizePhone(transactionData.phone),
            firstName: matcher._normalizeName(transactionData.firstName),
            lastName: matcher._normalizeName(transactionData.lastName)
        })
    }));
    
    // Make decision
    const decision = matcher.decide(candidatesWithScores, {});
    
    console.log('\n🔍 Matching Results:');
    candidatesWithScores.forEach((c, i) => {
        const isSelected = c.candidate.Id === decision.contactId;
        console.log(`   ${isSelected ? '→' : ' '} Contact ${i + 1}: ${c.candidate.FirstName} ${c.candidate.LastName}`);
        console.log(`     Score: ${c.scores.total.toFixed(2)}`);
        console.log(`     Email Match: ${c.scores.breakdown.email || 'none'}`);
        console.log(`     Phone Match: ${c.scores.breakdown.phone || 'none'}`);
        console.log(`     Name Match: ${c.scores.breakdown.name || 'none'}`);
    });
    
    console.log('\n✅ DECISION:');
    console.log(`   Action: ${decision.action.toUpperCase()}`);
    console.log(`   Reason: ${decision.reason}`);
    console.log(`   Review Required: ${decision.reviewRequired ? 'YES' : 'NO'}`);
    
    console.log('\n📊 OUTCOME:');
    if (decision.action === 'associate') {
        console.log(`   ✓ UPDATE existing contact: ${decision.candidate.FirstName} ${decision.candidate.LastName} (${decision.candidate.Id})`);
        console.log('   ✓ Transaction linked to existing contact');
    } else if (decision.action === 'review') {
        console.log('   ✓ CREATE new contact (prevent data overwrite)');
        console.log('   ✓ CREATE review task for manual verification');
        console.log('   ✓ Transaction linked to new contact');
    } else if (decision.action === 'create') {
        console.log('   ✓ CREATE new contact');
        console.log('   ✓ Transaction linked to new contact');
        console.log('   ✓ No review needed');
    }
}

// Scenario 1: Exact match on all fields
processTransaction(
    { num: 1, name: 'Exact Match - All Fields Match' },
    {
        firstName: 'John',
        lastName: 'Doe',
        email: 'john.doe@example.com',
        phone: '(555) 123-4567'
    }
);

// Scenario 2: Email and Phone match, but Name differs
processTransaction(
    { num: 2, name: 'Partial Match - Email+Phone Match, Name Differs (REVIEW)' },
    {
        firstName: 'Johnny',
        lastName: 'Doe',
        email: 'john.doe@example.com',
        phone: '15551234567'
    }
);

// Scenario 3: Name matches, but Email differs
processTransaction(
    { num: 3, name: 'Partial Match - Name Matches, Email Differs (REVIEW)' },
    {
        firstName: 'John',
        lastName: 'Doe',
        email: 'john.new@example.com',
        phone: '15551234567'
    }
);

// Scenario 4: Name matches, but Phone differs
processTransaction(
    { num: 4, name: 'Partial Match - Name Matches, Phone Differs (REVIEW)' },
    {
        firstName: 'John',
        lastName: 'Doe',
        email: 'john.doe@example.com',
        phone: '15559999999'
    }
);

// Scenario 5: Only Email matches
processTransaction(
    { num: 5, name: 'Insufficient Match - Only Email Matches (CREATE)' },
    {
        firstName: 'Bob',
        lastName: 'Johnson',
        email: 'john.doe@example.com',
        phone: '15558888888'
    }
);

// Scenario 6: Only Phone matches
processTransaction(
    { num: 6, name: 'Insufficient Match - Only Phone Matches (CREATE)' },
    {
        firstName: 'Bob',
        lastName: 'Johnson',
        email: 'bob.johnson@example.com',
        phone: '15551234567'
    }
);

// Scenario 7: Completely new person
processTransaction(
    { num: 7, name: 'No Match - Completely New Person (CREATE)' },
    {
        firstName: 'Alice',
        lastName: 'Williams',
        email: 'alice.williams@example.com',
        phone: '15557777777'
    }
);

console.log('\n' + '='.repeat(80));
console.log('SUMMARY');
console.log('='.repeat(80));
console.log('\n✅ The new matching logic ensures:');
console.log('   1. Exact matches on ALL three fields (email, phone, name) → Update existing contact');
console.log('   2. Email+Phone match but name differs → Review + Create new contact');
console.log('   3. Name matches but email/phone differ → Review + Create new contact');
console.log('   4. Other cases → Create new contact without review');
console.log('\n✅ Benefits:');
console.log('   - Prevents accidental data overwrite');
console.log('   - Creates review tasks only when necessary');
console.log('   - Ensures data integrity');
console.log('   - Reduces manual review overhead');
console.log('\n' + '='.repeat(80));
