const createAddressData = (customerData) =>
  customerData.address && typeof customerData.address === 'object'
    ? {
        line1: customerData.address.line1,
        city: customerData.address.city,
        state: customerData.address.state,
        postal_code: customerData.address.postal_code,
        country: 'US',
      }
    : {
        line1: customerData.address,
        city: customerData.city,
        state: customerData.state,
        postal_code: customerData.zipcode,
        country: 'US',
      };

const createCrmContactWorkflow = ({ CrmFactory, logger, getCrmConfig, ensureSalesforceIdOnCustomer }) => {
  const syncContactToCrm = async (context, stripe, customerData) => {
    try {
      const crmConfig = getCrmConfig();

      if (!crmConfig) {
        console.log('CRM integration disabled - skipping contact sync');
        return null;
      }

      const validation = CrmFactory.validateConfig(crmConfig.provider, crmConfig.config);
      if (!validation.isValid) {
        console.log(`CRM configuration invalid: ${validation.error}`);
        return null;
      }

      const crmService = CrmFactory.createCrmService(crmConfig.provider, crmConfig.config);
      if (typeof crmService.authenticate === 'function') {
        await crmService.authenticate();
      }

      const searchCriteria = {
        email: customerData.email,
        firstName: customerData.firstname,
        lastName: customerData.lastname,
        phone: customerData.phone,
        stripeCustomerId: customerData.stripeCustomerId || null,
      };

      console.log('Searching for existing contact in CRM...');
      const existingContacts = await crmService.searchContact(searchCriteria);

      let contact = null;

      if (existingContacts && existingContacts.length > 0) {
        if (searchCriteria.stripeCustomerId) {
          const stripeIdMatch = existingContacts.find(
            (candidate) => candidate.Stripe_Customer_ID__c === searchCriteria.stripeCustomerId
          );

          if (stripeIdMatch) {
            contact = stripeIdMatch;
            console.log(
              `Found contact by Stripe Customer ID: ${contact.FirstName} ${contact.LastName} (${contact.Email})`
            );

            const updateData = {
              email: customerData.email,
              firstName: customerData.firstname,
              lastName: customerData.lastname,
              phone: customerData.phone,
              address: createAddressData(customerData),
            };

            try {
              const updatedContact = await crmService.updateContact(contact.Id, updateData);
              if (updatedContact) {
                contact = updatedContact;
                console.log(
                  `Updated contact from Stripe data: ${contact.FirstName} ${contact.LastName}`
                );
              }
            } catch (error) {
              console.log(`Failed to update contact: ${error.message}`);
            }

            return contact;
          }
        }

        const matchingContact = existingContacts.find((candidate) => {
          const firstNameMatch =
            candidate.FirstName &&
            candidate.FirstName.toLowerCase() === searchCriteria.firstName.toLowerCase();
          const lastNameMatch =
            candidate.LastName && candidate.LastName.toLowerCase() === searchCriteria.lastName.toLowerCase();
          return firstNameMatch && lastNameMatch;
        });

        if (matchingContact) {
          contact = matchingContact;
          console.log(
            `Found existing contact with matching name: ${contact.FirstName} ${contact.LastName} (${contact.Email})`
          );

          const updateData = {};
          const addressData = createAddressData(customerData);

          if (addressData.line1 || addressData.city || addressData.state || addressData.postal_code) {
            updateData.address = addressData;
          }

          if (
            searchCriteria.stripeCustomerId &&
            (!contact.Stripe_Customer_ID__c || contact.Stripe_Customer_ID__c.trim() === '')
          ) {
            updateData.stripeCustomerId = searchCriteria.stripeCustomerId;
            console.log(
              `Adding Stripe Customer ID to existing contact: ${searchCriteria.stripeCustomerId}`
            );
          }

          if (Object.keys(updateData).length > 0) {
            try {
              const updatedContact = await crmService.updateContact(contact.Id, updateData);
              if (updatedContact) {
                contact = updatedContact;
                console.log(`Updated contact: ${contact.FirstName} ${contact.LastName}`);
              }
            } catch (error) {
              console.log(`Failed to update contact: ${error.message}`);
            }
          }
        } else {
          console.log(
            'Found contacts by email/phone but name does not match. Creating new contact...'
          );
          contact = null;
        }
      }

      if (!contact) {
        console.log('No existing contact found, creating new contact...');

        const contactData = {
          email: customerData.email,
          firstName: customerData.firstname,
          lastName: customerData.lastname,
          phone: customerData.phone,
          stripeCustomerId: searchCriteria.stripeCustomerId || null,
          address: createAddressData(customerData),
        };

        contact = await crmService.createContact(contactData);
        console.log(
          `Created new contact: ${contact.FirstName} ${contact.LastName} (${contact.Email})`
        );
      }

      if (customerData.stripeCustomerId && contact && contact.Id) {
        const metadataLogger =
          typeof context?.log === 'function'
            ? context.log.bind(context)
            : typeof logger?.info === 'function'
              ? logger.info.bind(logger)
              : () => {};

        await ensureSalesforceIdOnCustomer(
          stripe,
          customerData.stripeCustomerId,
          contact.Id,
          metadataLogger
        );
      }

      return contact;
    } catch (error) {
      console.log(`Error syncing contact to CRM: ${error.message}`);
      logger.error('CRM sync error details:', error);
      return null;
    }
  };

  return {
    syncContactToCrm,
  };
};

module.exports = {
  createCrmContactWorkflow,
};