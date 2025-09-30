/**
 * Pledges API Endpoint
 * 
 * Handles pledge CRUD operations:
 * - POST /pledges - Create new pledge
 * - GET /pledges/:id - Get pledge details
 * - PATCH /pledges/:id - Update pledge
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
    context.log('Pledges API request:', req.method, req.params.pledgeId);

    try {
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

        // Route based on method and pledgeId
        const method = req.method.toUpperCase();
        const pledgeId = req.params.pledgeId;

        if (method === 'POST' && !pledgeId) {
            // Create new pledge
            return await handleCreatePledge(context, req, pledgeService);
        } else if (method === 'GET' && pledgeId) {
            // Get pledge details
            return await handleGetPledge(context, req, pledgeService, pledgeId);
        } else if (method === 'PATCH' && pledgeId) {
            // Update pledge
            return await handleUpdatePledge(context, req, pledgeService, pledgeId);
        } else {
            context.res = {
                status: 400,
                body: {
                    error: 'Invalid request. Use POST /pledges to create, GET /pledges/:id to retrieve, or PATCH /pledges/:id to update.'
                }
            };
        }

    } catch (error) {
        context.log.error('Error processing pledges request:', error);
        context.res = {
            status: error.message.includes('not found') ? 404 : 500,
            body: {
                error: error.message,
                timestamp: new Date().toISOString()
            }
        };
    }
};

/**
 * Handle POST /pledges - Create new pledge
 */
async function handleCreatePledge(context, req, pledgeService) {
    const pledgeData = req.body;

    // Validate required fields
    if (!pledgeData || !pledgeData.contactId || !pledgeData.totalAmount) {
        context.res = {
            status: 400,
            body: {
                error: 'Missing required fields: contactId, totalAmount, fundCategory, startDate, numberOfInstallments'
            }
        };
        return;
    }

    context.log('Creating pledge:', {
        contactId: pledgeData.contactId,
        totalAmount: pledgeData.totalAmount,
        numberOfInstallments: pledgeData.numberOfInstallments
    });

    const result = await pledgeService.createPledge(pledgeData);

    context.res = {
        status: 201,
        body: {
            success: true,
            pledge: result.pledge,
            installments: result.installments,
            message: `Pledge created successfully with ${result.installments.length} installments`
        }
    };
}

/**
 * Handle GET /pledges/:id - Get pledge details
 */
async function handleGetPledge(context, req, pledgeService, pledgeId) {
    context.log('Retrieving pledge:', pledgeId);

    const pledge = await pledgeService.getPledge(pledgeId);
    const summary = await pledgeService.getPledgeSummary(pledgeId);

    context.res = {
        status: 200,
        body: {
            success: true,
            pledge,
            summary
        }
    };
}

/**
 * Handle PATCH /pledges/:id - Update pledge
 */
async function handleUpdatePledge(context, req, pledgeService, pledgeId) {
    const updates = req.body;

    if (!updates || Object.keys(updates).length === 0) {
        context.res = {
            status: 400,
            body: {
                error: 'No update data provided'
            }
        };
        return;
    }

    context.log('Updating pledge:', pledgeId, updates);

    const updatedPledge = await pledgeService.updatePledge(pledgeId, updates);

    context.res = {
        status: 200,
        body: {
            success: true,
            pledge: updatedPledge,
            message: 'Pledge updated successfully'
        }
    };
}
