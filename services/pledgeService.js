/**
 * PledgeService
 * 
 * Manages pledge lifecycle:
 * - Create pledges with installment schedules
 * - Update pledge status and details
 * - Write-off and cancellation
 * - Allocate payments to installments
 * - Query pledge and installment data
 */

const { loadPledgeConfig, calculateDueDates, calculateInstallmentAmounts, formatCurrency } = require('../config/pledgeConfig');

class PledgeService {
    constructor(crmService, config = null) {
        this.crmService = crmService;
        this.config = config || loadPledgeConfig();
    }

    /**
     * Create a new pledge with installment schedule
     * @param {Object} pledgeData - Pledge information
     * @returns {Promise<Object>} Created pledge with installments
     */
    async createPledge(pledgeData) {
        const {
            contactId,
            fundCategory,
            totalAmount,
            currency = 'USD',
            startDate,
            scheduleType = 'Monthly',
            numberOfInstallments,
            endDate = null,
            notes = '',
            customDates = null
        } = pledgeData;

        // Validate required fields
        this.validatePledgeData({
            contactId,
            fundCategory,
            totalAmount,
            currency,
            startDate,
            scheduleType,
            numberOfInstallments
        });

        // Validate total amount
        if (totalAmount < this.config.validation.minTotalAmount || totalAmount > this.config.validation.maxTotalAmount) {
            throw new Error(`Total amount must be between ${this.config.validation.minTotalAmount} and ${this.config.validation.maxTotalAmount}`);
        }

        // Validate currency
        if (!this.config.validation.allowedCurrencies.includes(currency)) {
            throw new Error(`Currency ${currency} is not allowed. Allowed: ${this.config.validation.allowedCurrencies.join(', ')}`);
        }

        // Validate start date
        const start = new Date(startDate);
        if (!this.config.schedule.allowPastStartDate && start < new Date()) {
            throw new Error('Start date cannot be in the past');
        }

        // Validate number of installments
        if (numberOfInstallments < this.config.validation.minInstallments || numberOfInstallments > this.config.schedule.maxInstallments) {
            throw new Error(`Number of installments must be between ${this.config.validation.minInstallments} and ${this.config.schedule.maxInstallments}`);
        }

        console.log(`Creating pledge for contact ${contactId}: ${formatCurrency(totalAmount, currency)} over ${numberOfInstallments} installments`);

        // Generate installment schedule
        const installments = this.generateInstallmentSchedule({
            totalAmount,
            startDate,
            scheduleType,
            numberOfInstallments,
            customDates
        });

        // Create pledge in CRM
        const pledge = await this.crmService.createPledge({
            contactId,
            fundCategory,
            totalAmount,
            currency,
            balanceRemaining: totalAmount,
            startDate,
            endDate: endDate || installments[installments.length - 1].dueDate,
            scheduleType,
            numberOfInstallments,
            status: 'Active',
            notes
        });

        console.log(`Created pledge ${pledge.Id} in CRM`);

        // Create installments in CRM
        const createdInstallments = await this.crmService.createPledgeInstallments(
            pledge.Id,
            installments
        );

        console.log(`Created ${createdInstallments.length} installments for pledge ${pledge.Id}`);

        return {
            pledge,
            installments: createdInstallments
        };
    }

    /**
     * Generate installment schedule
     * @param {Object} scheduleData - Schedule parameters
     * @returns {Array<Object>} Array of installment objects
     */
    generateInstallmentSchedule({ totalAmount, startDate, scheduleType, numberOfInstallments, customDates = null }) {
        // Calculate due dates
        const dueDates = calculateDueDates(startDate, scheduleType, numberOfInstallments, customDates);

        // Calculate amounts with proper rounding
        const amounts = calculateInstallmentAmounts(totalAmount, numberOfInstallments);

        // Build installment objects
        const installments = dueDates.map((dueDate, index) => ({
            sequenceNumber: index + 1,
            dueDate: dueDate instanceof Date ? dueDate.toISOString().split('T')[0] : dueDate,
            amountDue: amounts[index],
            amountPaid: 0,
            status: 'Unpaid',
            notes: ''
        }));

        return installments;
    }

    /**
     * Get pledge by ID with installments
     * @param {string} pledgeId - Pledge ID
     * @returns {Promise<Object>} Pledge with installments
     */
    async getPledge(pledgeId) {
        const pledge = await this.crmService.getPledge(pledgeId);
        const installments = await this.crmService.getPledgeInstallments(pledgeId);

        return {
            ...pledge,
            installments
        };
    }

    /**
     * Update pledge details
     * Only allows updating future installments and notes
     * @param {string} pledgeId - Pledge ID
     * @param {Object} updates - Fields to update
     * @returns {Promise<Object>} Updated pledge
     */
    async updatePledge(pledgeId, updates) {
        const allowed = ['notes', 'status'];
        const updateData = {};

        for (const key of allowed) {
            if (updates[key] !== undefined) {
                updateData[key] = updates[key];
            }
        }

        if (Object.keys(updateData).length === 0) {
            throw new Error('No valid fields to update');
        }

        console.log(`Updating pledge ${pledgeId}:`, updateData);

        const updatedPledge = await this.crmService.updatePledge(pledgeId, updateData);

        return updatedPledge;
    }

    /**
     * Write off remaining pledge balance
     * @param {string} pledgeId - Pledge ID
     * @param {string} reason - Reason for write-off
     * @returns {Promise<Object>} Updated pledge
     */
    async writeOffPledge(pledgeId, reason) {
        if (!reason || reason.trim().length === 0) {
            throw new Error('Write-off reason is required');
        }

        console.log(`Writing off pledge ${pledgeId}: ${reason}`);

        const pledge = await this.getPledge(pledgeId);

        if (pledge.status === 'Fulfilled') {
            throw new Error('Cannot write off a fulfilled pledge');
        }

        if (pledge.status === 'Written-Off') {
            throw new Error('Pledge is already written off');
        }

        const updatedPledge = await this.crmService.updatePledge(pledgeId, {
            status: 'Written-Off',
            writeOffDate: new Date().toISOString().split('T')[0],
            writeOffReason: reason
        });

        console.log(`Pledge ${pledgeId} written off successfully`);

        return updatedPledge;
    }

    /**
     * Cancel a pledge
     * @param {string} pledgeId - Pledge ID
     * @param {string} reason - Reason for cancellation
     * @returns {Promise<Object>} Updated pledge
     */
    async cancelPledge(pledgeId, reason) {
        console.log(`Canceling pledge ${pledgeId}: ${reason || 'No reason provided'}`);

        const pledge = await this.getPledge(pledgeId);

        if (pledge.status === 'Fulfilled') {
            throw new Error('Cannot cancel a fulfilled pledge');
        }

        if (pledge.status === 'Canceled') {
            throw new Error('Pledge is already canceled');
        }

        const updatedPledge = await this.crmService.updatePledge(pledgeId, {
            status: 'Canceled',
            notes: `${pledge.notes || ''}\n\nCanceled: ${reason || 'No reason provided'}\nDate: ${new Date().toISOString()}`.trim()
        });

        console.log(`Pledge ${pledgeId} canceled successfully`);

        return updatedPledge;
    }

    /**
     * Allocate a payment to pledge installments using FIFO
     * @param {Object} transaction - Transaction object
     * @param {string} pledgeId - Pledge ID to allocate to
     * @param {Object} options - Allocation options
     * @returns {Promise<Object>} Allocation result
     */
    async allocatePaymentToPledge(transaction, pledgeId, options = {}) {
        const { manualAllocation = false, appliedBy = null } = options;

        console.log(`Allocating payment ${transaction.id} (${formatCurrency(transaction.amount / 100, transaction.currency)}) to pledge ${pledgeId}`);

        // Get pledge with installments
        const pledge = await this.getPledge(pledgeId);

        if (pledge.status !== 'Active' && pledge.status !== 'Paused') {
            throw new Error(`Cannot allocate to pledge with status: ${pledge.status}`);
        }

        // Verify contact matches
        if (transaction.contactId !== pledge.contactId) {
            console.warn(`Warning: Transaction contact (${transaction.contactId}) does not match pledge contact (${pledge.contactId})`);
        }

        // Get unpaid/partial installments sorted by due date
        const unpaidInstallments = pledge.installments
            .filter(inst => inst.status === 'Unpaid' || inst.status === 'Partial' || inst.status === 'Overdue')
            .sort((a, b) => new Date(a.dueDate) - new Date(b.dueDate));

        if (unpaidInstallments.length === 0) {
            throw new Error('Pledge has no unpaid installments');
        }

        // Calculate amount to allocate (in dollars)
        let remainingAmount = transaction.amount / 100; // Convert cents to dollars
        const allocations = [];

        // Apply FIFO allocation
        for (const installment of unpaidInstallments) {
            if (remainingAmount <= 0) {
                break;
            }

            const installmentBalance = installment.amountDue - (installment.amountPaid || 0);

            // Check prepayment policy
            if (this.config.prepayment.policy === 'balance_only' && allocations.length > 0) {
                // Only apply to first installment unless prepaying is allowed
                break;
            }

            // Determine amount to apply to this installment
            const amountToApply = Math.min(remainingAmount, installmentBalance);

            if (amountToApply > 0) {
                allocations.push({
                    transactionId: transaction.id,
                    pledgeId: pledge.Id,
                    installmentId: installment.Id,
                    amountApplied: amountToApply,
                    allocationDate: new Date().toISOString(),
                    appliedBy: appliedBy,
                    isAutomatic: !manualAllocation
                });

                remainingAmount -= amountToApply;

                console.log(`  Allocated ${formatCurrency(amountToApply, transaction.currency)} to installment ${installment.sequenceNumber} (balance: ${formatCurrency(installmentBalance, transaction.currency)})`);
            }

            // Stop if we've reached max prepay installments
            if (allocations.length >= this.config.prepayment.maxPrepayInstallments) {
                break;
            }
        }

        // Handle overpayment
        let overpaymentAmount = 0;
        if (remainingAmount > 0.01) { // More than 1 cent remaining
            console.log(`  Overpayment of ${formatCurrency(remainingAmount, transaction.currency)} detected`);

            if (this.config.prepayment.allowOverpayment) {
                overpaymentAmount = remainingAmount;
                console.log(`  Overpayment will be treated as non-pledge payment`);
            } else {
                throw new Error(`Overpayment of ${formatCurrency(remainingAmount, transaction.currency)} is not allowed`);
            }
        }

        // Create allocation records in CRM
        const createdAllocations = await this.crmService.createPledgeAllocations(allocations);

        console.log(`Created ${createdAllocations.length} allocation records`);

        // Update pledge balance and status
        const newBalance = pledge.balanceRemaining - (transaction.amount / 100 - overpaymentAmount);
        const pledgeStatus = newBalance <= 0.01 ? 'Fulfilled' : pledge.status;

        await this.crmService.updatePledge(pledgeId, {
            balanceRemaining: Math.max(0, newBalance),
            status: pledgeStatus
        });

        console.log(`Updated pledge balance to ${formatCurrency(Math.max(0, newBalance), transaction.currency)}, status: ${pledgeStatus}`);

        return {
            success: true,
            allocations: createdAllocations,
            overpaymentAmount,
            pledgeBalance: Math.max(0, newBalance),
            pledgeStatus
        };
    }

    /**
     * Validate pledge data
     */
    validatePledgeData(data) {
        const required = ['contactId', 'fundCategory', 'totalAmount', 'currency', 'startDate', 'numberOfInstallments'];

        for (const field of required) {
            if (!data[field]) {
                throw new Error(`Missing required field: ${field}`);
            }
        }

        if (data.totalAmount <= 0) {
            throw new Error('Total amount must be positive');
        }

        if (data.numberOfInstallments <= 0) {
            throw new Error('Number of installments must be positive');
        }
    }

    /**
     * Get all active pledges for a contact
     * @param {string} contactId - Contact ID
     * @returns {Promise<Array>} Array of active pledges
     */
    async getActivePledgesForContact(contactId) {
        return await this.crmService.getActivePledgesForContact(contactId);
    }

    /**
     * Get pledge summary statistics
     * @param {string} pledgeId - Pledge ID
     * @returns {Promise<Object>} Summary statistics
     */
    async getPledgeSummary(pledgeId) {
        const pledge = await this.getPledge(pledgeId);

        const totalPaid = pledge.totalAmount - pledge.balanceRemaining;
        const paidInstallments = pledge.installments.filter(i => i.status === 'Paid').length;
        const overdueInstallments = pledge.installments.filter(i => i.status === 'Overdue').length;
        const nextDue = pledge.installments.find(i => i.status === 'Unpaid' || i.status === 'Partial');

        return {
            pledgeId: pledge.Id,
            contactId: pledge.contactId,
            fundCategory: pledge.fundCategory,
            totalAmount: pledge.totalAmount,
            balanceRemaining: pledge.balanceRemaining,
            totalPaid,
            percentPaid: (totalPaid / pledge.totalAmount) * 100,
            status: pledge.status,
            numberOfInstallments: pledge.numberOfInstallments,
            paidInstallments,
            overdueInstallments,
            nextDueDate: nextDue ? nextDue.dueDate : null,
            nextDueAmount: nextDue ? nextDue.amountDue - (nextDue.amountPaid || 0) : 0
        };
    }
}

module.exports = PledgeService;
