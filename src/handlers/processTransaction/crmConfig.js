const DEFAULT_SALESFORCE_CONTACT_LEAD_SOURCE = 'Online Transaction';

/** Returns true if the value is a non-empty, non-whitespace string. */
const isNonEmptyString = (val) => typeof val === 'string' && val.trim().length > 0;

const createCrmConfigResolver = ({ logger }) => {
  const getCrmConfig = () => {
    const configuredProvider = process.env.CRM_PROVIDER;
    const hasSalesforceCredentials =
      isNonEmptyString(process.env.SF_CLIENT_ID) && isNonEmptyString(process.env.SF_CLIENT_SECRET);

    const provider = isNonEmptyString(configuredProvider)
      ? configuredProvider
      : hasSalesforceCredentials
        ? 'salesforce'
        : null;

    if (!provider) {
      logger.info('No CRM provider configured, skipping CRM integration');
      return null;
    }

    switch (provider.toLowerCase()) {
      case 'salesforce': {
        const contactLeadSource =
          process.env.SALESFORCE_CONTACT_LEAD_SOURCE ?? DEFAULT_SALESFORCE_CONTACT_LEAD_SOURCE;

        return {
          provider: 'salesforce',
          config: {
            clientId: process.env.SF_CLIENT_ID,
            clientSecret: process.env.SF_CLIENT_SECRET,
            loginUrl: process.env.SF_LOGIN_URL || 'https://login.salesforce.com',
            contactLeadSource,
          },
        };
      }

      default:
        logger.error(`Unsupported CRM provider: ${provider}`);
        return null;
    }
  };

  return {
    getCrmConfig,
  };
};

module.exports = {
  createCrmConfigResolver,
};
