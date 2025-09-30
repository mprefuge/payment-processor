/**
 * Manual Pledge Allocation Endpoint
 * 
 * POST /transactions/:id/apply-to-pledge - Manually allocate transaction to pledge
 * Used for manual review workflow
 */

const CrmFactory = require('../services/crm/crmFactory');
const PledgeService = require('../services/pledgeService');
const { loadPledgeConfig, validatePledgeConfig } = require('../config/pledgeConfig');

// Get CRM configuration from environment variables
const getCrmConfig = () => {
    const provider = process.env.CRM_PROVIDER;
    
    if (!provider) {
        throw new Error('CRM_PROVIDER environment variable is required');
    }

    switch (provider.toLowerCase()) {
        case 'salesforce':
            return {
                provider: 'salesforce',
                config: {
                    username: process.env.SALESFORCE_USERNAME,
                    password: process.env.SALESFORCE_PASSWORD,
                    securityToken: process.env.SALESFORCE_SECURITY_TOKEN,
                    loginUrl: process.env.SALESFORCE_LOGIN_URL || 'https://login.salesforce.com'
                }
            };
        default:
            throw new Error(`Unsupported CRM provider: ${provider}`);
    }
};

module.exports = async function (context, req) {
    context.log('Manual pledge allocation request:', req.params.transactionId);

    try {
        const transactionId = req.params.transactionId;
        const { pledgeId, appliedBy } = req.body || {};

        if (!transactionId) {
            context.res = {
                status: 400,
                body: {
                    error: 'Transaction ID is required'
                }
            };
            return;
        }

        if (!pledgeId) {
            context.res = {
                status: 400,
                body: {
                    error: 'Pledge ID is required in request body'
                }
            };
            return;
        }

        // Load and validate configuration
        const pledgeConfig = loadPledgeConfig();
        validatePledgeConfig(pledgeConfig);

        // Get CRM configuration
        const crmConfig = getCrmConfig();

        // Validate CRM configuration
        const validation = CrmFactory.validateConfig(crmConfig.provider, crmConfig.config);
        if (!validation.isValid) {
            throw new Error(`CRM configuration invalid: ${validation.error}`);
        }

        // Create services
        const crmService = CrmFactory.createCrmService(crmConfig.provider, crmConfig.config);
        const pledgeService = new PledgeService(crmService, pledgeConfig);

        // Get transaction from CRM
        const crmTransaction = await crmService.findTransactionByStripeId(transactionId);
        
        if (!crmTransaction) {
            context.res = {
                status: 404,
                body: {
                    error: `Transaction ${transactionId} not found in CRM`
                }
            };
            return;
        }

        // Build transaction object for allocation
        const transaction = {
            id: crmTransaction.Id,
            contactId: crmTransaction.Contact__c,
            amount: crmTransaction.Amount__c * 100, // Convert dollars to cents
            currency: crmTransaction.Currency__c || 'USD',
            timestamp: crmTransaction.Transaction_Date__c || crmTransaction.CreatedDate,
            description: crmTransaction.Description__c || '',
            category: crmTransaction.Category__c
        };

        context.log('Manually allocating transaction to pledge:', {
            transactionId: transaction.id,
            pledgeId,
            amount: transaction.amount / 100,
            appliedBy: appliedBy || 'System'
        });

        // Allocate payment to pledge (manual allocation)
        const result = await pledgeService.allocatePaymentToPledge(
            transaction,
            pledgeId,
            {
                manualAllocation: true,
                appliedBy: appliedBy || null
            }
        );

        // Update the transaction record to link it to the pledge
        await crmService.updateTransaction(crmTransaction.Id, {
            pledgeId: pledgeId
        });

        context.res = {
            status: 200,
            body: {
                success: true,
                transaction: {
                    id: transaction.id,
                    amount: transaction.amount / 100,
                    currency: transaction.currency
                },
                allocation: {
                    pledgeId,
                    allocations: result.allocations,
                    overpaymentAmount: result.overpaymentAmount,
                    pledgeBalance: result.pledgeBalance,
                    pledgeStatus: result.pledgeStatus
                },
                message: `Transaction manually allocated to pledge. ${result.allocations.length} installment(s) paid.`
            }
        };

    } catch (error) {
        context.log.error('Error applying transaction to pledge:', error);
        context.res = {
            status: error.message.includes('not found') ? 404 : 
                    error.message.includes('Cannot allocate') ? 400 : 500,
            body: {
                error: error.message,
                timestamp: new Date().toISOString()
            }
        };
    }
};
