/**
 * Pledge Write-Off Endpoint
 * 
 * POST /pledges/:id/write-off - Write off remaining pledge balance
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
    context.log('Pledge write-off request:', req.params.pledgeId);

    try {
        const pledgeId = req.params.pledgeId;
        const { reason } = req.body || {};

        if (!pledgeId) {
            context.res = {
                status: 400,
                body: {
                    error: 'Pledge ID is required'
                }
            };
            return;
        }

        if (!reason) {
            context.res = {
                status: 400,
                body: {
                    error: 'Write-off reason is required'
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

        // Write off the pledge
        const updatedPledge = await pledgeService.writeOffPledge(pledgeId, reason);

        context.res = {
            status: 200,
            body: {
                success: true,
                pledge: updatedPledge,
                message: 'Pledge written off successfully'
            }
        };

    } catch (error) {
        context.log.error('Error writing off pledge:', error);
        context.res = {
            status: error.message.includes('not found') ? 404 : 
                    error.message.includes('Cannot write off') ? 400 : 500,
            body: {
                error: error.message,
                timestamp: new Date().toISOString()
            }
        };
    }
};
