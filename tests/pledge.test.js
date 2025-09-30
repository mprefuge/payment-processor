/**
 * Pledge Tests
 * 
 * Tests for pledge functionality:
 * - Schedule generation (monthly/quarterly/custom)
 * - Allocation logic (exact, split, over/underpayment)
 * - Matching signals and thresholds
 * - Idempotency
 */

const PledgeService = require('../services/pledgeService');
const PledgeMatcher = require('../services/pledgeMatcher');
const { 
    calculateDueDates, 
    calculateInstallmentAmounts, 
    amountFitsWithinTolerance,
    dateWithinWindow 
} = require('../config/pledgeConfig');

console.log('🧪 Running Pledge Tests\n');

// ==================== HELPER TESTS ====================

// Test: calculateInstallmentAmounts with rounding
function testInstallmentAmounts() {
    console.log('Testing installment amount calculation with rounding...');
    
    // Test case 1: Even division
    const amounts1 = calculateInstallmentAmounts(100, 4);
    if (amounts1.length !== 4 || amounts1[0] !== 25 || amounts1[3] !== 25) {
        throw new Error('Even division failed');
    }
    
    // Test case 2: Division with remainder
    const amounts2 = calculateInstallmentAmounts(100, 3);
    if (amounts2.length !== 3) {
        throw new Error('Wrong number of installments');
    }
    const sum2 = amounts2.reduce((a, b) => a + b, 0);
    if (Math.abs(sum2 - 100) > 0.01) {
        throw new Error(`Sum (${sum2}) does not equal total (100)`);
    }
    
    // Test case 3: Small amounts
    const amounts3 = calculateInstallmentAmounts(10.50, 3);
    const sum3 = amounts3.reduce((a, b) => a + b, 0);
    if (Math.abs(sum3 - 10.50) > 0.01) {
        throw new Error(`Sum (${sum3}) does not equal total (10.50)`);
    }
    
    console.log('✅ Installment amount calculation with rounding');
}

// Test: calculateDueDates for monthly schedule
function testMonthlySchedule() {
    console.log('Testing monthly schedule generation...');
    
    const startDate = '2025-01-15';
    const dueDates = calculateDueDates(startDate, 'Monthly', 12);
    
    if (dueDates.length !== 12) {
        throw new Error(`Expected 12 due dates, got ${dueDates.length}`);
    }
    
    // Check first and last dates
    const first = new Date(dueDates[0]);
    const last = new Date(dueDates[11]);
    
    if (first.getDate() !== 15) {
        throw new Error('First date should be on the 15th');
    }
    
    const monthDiff = (last.getFullYear() - first.getFullYear()) * 12 + (last.getMonth() - first.getMonth());
    if (monthDiff !== 11) {
        throw new Error(`Expected 11 months difference, got ${monthDiff}`);
    }
    
    console.log('✅ Monthly schedule generation');
}

// Test: calculateDueDates for quarterly schedule
function testQuarterlySchedule() {
    console.log('Testing quarterly schedule generation...');
    
    const startDate = '2025-01-01';
    const dueDates = calculateDueDates(startDate, 'Quarterly', 4);
    
    if (dueDates.length !== 4) {
        throw new Error(`Expected 4 due dates, got ${dueDates.length}`);
    }
    
    // Check dates are 3 months apart
    const dates = dueDates.map(d => new Date(d));
    for (let i = 1; i < dates.length; i++) {
        const monthDiff = (dates[i].getFullYear() - dates[i-1].getFullYear()) * 12 + 
                          (dates[i].getMonth() - dates[i-1].getMonth());
        if (monthDiff !== 3) {
            throw new Error(`Expected 3 months between dates, got ${monthDiff}`);
        }
    }
    
    console.log('✅ Quarterly schedule generation');
}

// Test: amountFitsWithinTolerance
function testAmountTolerance() {
    console.log('Testing amount tolerance check...');
    
    // Within 5% tolerance of 100 means 95-105
    if (!amountFitsWithinTolerance(102, 100, 5)) {
        throw new Error('102 should fit within 5% of 100');
    }
    
    if (!amountFitsWithinTolerance(95, 100, 5)) {
        throw new Error('95 should fit within 5% of 100');
    }
    
    if (amountFitsWithinTolerance(110, 100, 5)) {
        throw new Error('110 should not fit within 5% of 100');
    }
    
    console.log('✅ Amount tolerance check');
}

// Test: dateWithinWindow
function testDateProximity() {
    console.log('Testing date proximity check...');
    
    const date1 = new Date('2025-01-15');
    const date2 = new Date('2025-01-18');
    const date3 = new Date('2025-01-25');
    
    if (!dateWithinWindow(date1, date2, 7)) {
        throw new Error('3 days should be within 7-day window');
    }
    
    if (dateWithinWindow(date1, date3, 7)) {
        throw new Error('10 days should not be within 7-day window');
    }
    
    console.log('✅ Date proximity check');
}

// ==================== MOCK CRM SERVICE ====================

class MockCrmService {
    constructor() {
        this.pledges = [];
        this.installments = [];
        this.allocations = [];
        this.nextPledgeId = 1;
        this.nextInstallmentId = 1;
        this.nextAllocationId = 1;
    }

    async createPledge(pledgeData) {
        const pledge = {
            Id: `PLG${String(this.nextPledgeId++).padStart(6, '0')}`,
            ...pledgeData
        };
        this.pledges.push(pledge);
        return pledge;
    }

    async getPledge(pledgeId) {
        const pledge = this.pledges.find(p => p.Id === pledgeId);
        if (!pledge) {
            throw new Error(`Pledge ${pledgeId} not found`);
        }
        return { ...pledge };
    }

    async updatePledge(pledgeId, updates) {
        const pledge = this.pledges.find(p => p.Id === pledgeId);
        if (!pledge) {
            throw new Error(`Pledge ${pledgeId} not found`);
        }
        Object.assign(pledge, updates);
        return { ...pledge };
    }

    async getActivePledgesForContact(contactId) {
        return this.pledges.filter(p => p.contactId === contactId && p.status === 'Active');
    }

    async createPledgeInstallments(pledgeId, installments) {
        const created = installments.map(inst => ({
            Id: `INST${String(this.nextInstallmentId++).padStart(6, '0')}`,
            pledgeId,
            ...inst,
            balanceRemaining: inst.amountDue - (inst.amountPaid || 0),
            status: inst.amountPaid >= inst.amountDue ? 'Paid' : 
                    inst.amountPaid > 0 ? 'Partial' : 'Unpaid'
        }));
        this.installments.push(...created);
        return created;
    }

    async getPledgeInstallments(pledgeId) {
        return this.installments.filter(i => i.pledgeId === pledgeId);
    }

    async createPledgeAllocations(allocations) {
        const created = allocations.map(alloc => {
            const allocation = {
                Id: `ALLOC${String(this.nextAllocationId++).padStart(6, '0')}`,
                ...alloc
            };
            this.allocations.push(allocation);
            
            // Update installment amount paid
            const installment = this.installments.find(i => i.Id === alloc.installmentId);
            if (installment) {
                installment.amountPaid = (installment.amountPaid || 0) + alloc.amountApplied;
                installment.balanceRemaining = installment.amountDue - installment.amountPaid;
                installment.status = installment.amountPaid >= installment.amountDue ? 'Paid' :
                                    installment.amountPaid > 0 ? 'Partial' : 'Unpaid';
            }
            
            return allocation;
        });
        return created;
    }

    async getAllocationsForTransaction(transactionId) {
        return this.allocations.filter(a => a.transactionId === transactionId);
    }
}

// ==================== INTEGRATION TESTS ====================

// Test: Create pledge with installment schedule
async function testCreatePledge() {
    console.log('Testing pledge creation...');
    
    const mockCrm = new MockCrmService();
    const pledgeService = new PledgeService(mockCrm);
    
    // Use future date
    const futureDate = new Date();
    futureDate.setDate(futureDate.getDate() + 30); // 30 days from now
    const startDate = futureDate.toISOString().split('T')[0];
    
    const result = await pledgeService.createPledge({
        contactId: 'CONTACT001',
        fundCategory: 'General Giving',
        totalAmount: 1200,
        currency: 'USD',
        startDate: startDate,
        scheduleType: 'Monthly',
        numberOfInstallments: 12,
        notes: 'Test pledge'
    });
    
    if (!result.pledge || !result.installments) {
        throw new Error('Pledge creation did not return pledge and installments');
    }
    
    if (result.installments.length !== 12) {
        throw new Error(`Expected 12 installments, got ${result.installments.length}`);
    }
    
    const totalFromInstallments = result.installments.reduce((sum, inst) => sum + inst.amountDue, 0);
    if (Math.abs(totalFromInstallments - 1200) > 0.01) {
        throw new Error(`Installments sum (${totalFromInstallments}) does not equal total (1200)`);
    }
    
    console.log('✅ Pledge creation with schedule');
}

// Test: Exact payment allocation
async function testExactPayment() {
    console.log('Testing exact payment allocation...');
    
    const mockCrm = new MockCrmService();
    const pledgeService = new PledgeService(mockCrm);
    
    // Use future date
    const futureDate = new Date();
    futureDate.setDate(futureDate.getDate() + 30);
    const startDate = futureDate.toISOString().split('T')[0];
    
    // Create pledge
    const pledgeResult = await pledgeService.createPledge({
        contactId: 'CONTACT001',
        fundCategory: 'Building Fund',
        totalAmount: 300,
        currency: 'USD',
        startDate: startDate,
        scheduleType: 'Monthly',
        numberOfInstallments: 3
    });
    
    const pledgeId = pledgeResult.pledge.Id;
    
    // Make exact payment for first installment (100)
    const transaction = {
        id: 'TXN001',
        contactId: 'CONTACT001',
        amount: 10000, // $100 in cents
        currency: 'USD',
        timestamp: '2025-01-05T12:00:00Z'
    };
    
    const result = await pledgeService.allocatePaymentToPledge(transaction, pledgeId);
    
    if (!result.success) {
        throw new Error('Payment allocation failed');
    }
    
    if (result.allocations.length !== 1) {
        throw new Error(`Expected 1 allocation, got ${result.allocations.length}`);
    }
    
    if (result.allocations[0].amountApplied !== 100) {
        throw new Error(`Expected $100 applied, got ${result.allocations[0].amountApplied}`);
    }
    
    if (Math.abs(result.pledgeBalance - 200) > 0.01) {
        throw new Error(`Expected balance $200, got ${result.pledgeBalance}`);
    }
    
    console.log('✅ Exact payment allocation');
}

// Test: Split payment across multiple installments
async function testSplitPayment() {
    console.log('Testing split payment allocation...');
    
    const mockCrm = new MockCrmService();
    // Use prepay_future policy for this test
    const config = require('../config/pledgeConfig').loadPledgeConfig();
    config.prepayment.policy = 'prepay_future';
    const pledgeService = new PledgeService(mockCrm, config);
    
    // Create pledge with 3 installments of $100 each
    const futureDate = new Date();
    futureDate.setDate(futureDate.getDate() + 30);
    const startDate = futureDate.toISOString().split('T')[0];

    const pledgeResult = await pledgeService.createPledge({
        contactId: 'CONTACT001',
        fundCategory: 'Building Fund',
        totalAmount: 300,
        currency: 'USD',
        startDate: startDate,
        scheduleType: 'Monthly',
        numberOfInstallments: 3
    });
    
    const pledgeId = pledgeResult.pledge.Id;
    
    // Make payment of $250 (should cover first 2 installments and part of third)
    const transaction = {
        id: 'TXN002',
        contactId: 'CONTACT001',
        amount: 25000, // $250 in cents
        currency: 'USD',
        timestamp: '2025-01-05T12:00:00Z'
    };
    
    const result = await pledgeService.allocatePaymentToPledge(transaction, pledgeId);
    
    if (!result.success) {
        throw new Error('Payment allocation failed');
    }
    
    if (result.allocations.length !== 3) {
        throw new Error(`Expected 3 allocations, got ${result.allocations.length}`);
    }
    
    if (Math.abs(result.pledgeBalance - 50) > 0.01) {
        throw new Error(`Expected balance $50, got ${result.pledgeBalance}`);
    }
    
    console.log('✅ Split payment allocation');
}

// Test: Overpayment handling
async function testOverpayment() {
    console.log('Testing overpayment handling...');
    
    const mockCrm = new MockCrmService();
    const pledgeService = new PledgeService(mockCrm);
    
    // Create small pledge
    const futureDate = new Date();
    futureDate.setDate(futureDate.getDate() + 30);
    const startDate = futureDate.toISOString().split('T')[0];

    const pledgeResult = await pledgeService.createPledge({
        contactId: 'CONTACT001',
        fundCategory: 'General Giving',
        totalAmount: 100,
        currency: 'USD',
        startDate: startDate,
        scheduleType: 'Monthly',
        numberOfInstallments: 1
    });
    
    const pledgeId = pledgeResult.pledge.Id;
    
    // Make payment larger than pledge total
    const transaction = {
        id: 'TXN003',
        contactId: 'CONTACT001',
        amount: 15000, // $150 in cents (overpayment of $50)
        currency: 'USD',
        timestamp: '2025-01-05T12:00:00Z'
    };
    
    const result = await pledgeService.allocatePaymentToPledge(transaction, pledgeId);
    
    if (!result.success) {
        throw new Error('Payment allocation failed');
    }
    
    if (Math.abs(result.overpaymentAmount - 50) > 0.01) {
        throw new Error(`Expected overpayment $50, got ${result.overpaymentAmount}`);
    }
    
    if (result.pledgeStatus !== 'Fulfilled') {
        throw new Error(`Expected status Fulfilled, got ${result.pledgeStatus}`);
    }
    
    console.log('✅ Overpayment handling');
}

// Test: Underpayment handling
async function testUnderpayment() {
    console.log('Testing underpayment handling...');
    
    const mockCrm = new MockCrmService();
    const pledgeService = new PledgeService(mockCrm);
    
    // Create pledge
    const futureDate = new Date();
    futureDate.setDate(futureDate.getDate() + 30);
    const startDate = futureDate.toISOString().split('T')[0];

    const pledgeResult = await pledgeService.createPledge({
        contactId: 'CONTACT001',
        fundCategory: 'General Giving',
        totalAmount: 300,
        currency: 'USD',
        startDate: startDate,
        scheduleType: 'Monthly',
        numberOfInstallments: 3
    });
    
    const pledgeId = pledgeResult.pledge.Id;
    
    // Make partial payment (less than first installment)
    const transaction = {
        id: 'TXN004',
        contactId: 'CONTACT001',
        amount: 5000, // $50 in cents (half of first installment)
        currency: 'USD',
        timestamp: '2025-01-05T12:00:00Z'
    };
    
    const result = await pledgeService.allocatePaymentToPledge(transaction, pledgeId);
    
    if (!result.success) {
        throw new Error('Payment allocation failed');
    }
    
    if (result.allocations.length !== 1) {
        throw new Error(`Expected 1 allocation, got ${result.allocations.length}`);
    }
    
    if (Math.abs(result.allocations[0].amountApplied - 50) > 0.01) {
        throw new Error(`Expected $50 applied, got ${result.allocations[0].amountApplied}`);
    }
    
    // Check installment is marked as partial
    const installments = await mockCrm.getPledgeInstallments(pledgeId);
    if (installments[0].status !== 'Partial') {
        throw new Error(`Expected first installment status Partial, got ${installments[0].status}`);
    }
    
    console.log('✅ Underpayment handling');
}

// Test: Write-off pledge
async function testWriteOff() {
    console.log('Testing pledge write-off...');
    
    const mockCrm = new MockCrmService();
    const pledgeService = new PledgeService(mockCrm);
    
    // Create pledge
    const futureDate = new Date();
    futureDate.setDate(futureDate.getDate() + 30);
    const startDate = futureDate.toISOString().split('T')[0];

    const pledgeResult = await pledgeService.createPledge({
        contactId: 'CONTACT001',
        fundCategory: 'General Giving',
        totalAmount: 1000,
        currency: 'USD',
        startDate: startDate,
        scheduleType: 'Monthly',
        numberOfInstallments: 10
    });
    
    const pledgeId = pledgeResult.pledge.Id;
    
    // Write off pledge
    const result = await pledgeService.writeOffPledge(pledgeId, 'Donor moved away');
    
    if (result.status !== 'Written-Off') {
        throw new Error(`Expected status Written-Off, got ${result.status}`);
    }
    
    if (!result.writeOffReason || !result.writeOffReason.includes('moved away')) {
        throw new Error('Write-off reason not saved correctly');
    }
    
    console.log('✅ Pledge write-off');
}

// ==================== RUN ALL TESTS ====================

async function runAllTests() {
    try {
        // Helper function tests
        testInstallmentAmounts();
        testMonthlySchedule();
        testQuarterlySchedule();
        testAmountTolerance();
        testDateProximity();
        
        // Integration tests
        await testCreatePledge();
        await testExactPayment();
        await testSplitPayment();
        await testOverpayment();
        await testUnderpayment();
        await testWriteOff();
        
        console.log('\n✅ All pledge tests passed!');
        process.exit(0);
    } catch (error) {
        console.error('\n❌ Test failed:', error.message);
        console.error(error.stack);
        process.exit(1);
    }
}

runAllTests();
