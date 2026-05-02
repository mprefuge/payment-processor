const DEFAULT_PROCESS_DONATION_API =
  'https://payment-processing-function.azurewebsites.net/api/transaction';

const DEFAULT_LIVE_PUBLISHABLE_KEY = 'pk_live_fJSacHhPB2h0mJfsFowRm8lQ';
const DEFAULT_TEST_PUBLISHABLE_KEY = 'pk_test_y47nraQZ5IFgnTMlwbDvfj8D';

function getDefaultDonationFormConfig() {
  return {
    version: 1,
    name: 'Donation Form',
    branding: {
      organizationName: 'Refuge International',
      title: 'Support Refuge International',
      description: 'Build a hosted Stripe checkout flow with the fields and order you need.',
      logoUrl:
        'https://images.squarespace-cdn.com/content/v1/5af0bc3a96d45593d7d7e55b/c8c56eb8-9c50-4540-822a-5da3f5d0c268/refuge-logo-edit+%28circle+with+horizontal+RI+name%29+-+small.png',
      accentColor: '#BD2135',
      submitLabel: 'Donate now',
    },
    display: {
      mode: 'embedded',
      modalTriggerLabel: 'Open donation form',
    },
    endpoints: {
      processDonationApi: DEFAULT_PROCESS_DONATION_API,
    },
    stripe: {
      livePublishableKey: DEFAULT_LIVE_PUBLISHABLE_KEY,
      testPublishableKey: DEFAULT_TEST_PUBLISHABLE_KEY,
    },
    options: {
      allowRecurring: true,
      allowOrganizationGiving: true,
      collectAddress: true,
      enableTribute: true,
      enableFeeCoverage: true,
    },
    payment: {
      defaultFrequency: 'onetime',
      amountPresets: [500, 100, 50, 25, 10],
      categories: [
        'General Giving',
        'Immigrant Legal Services Center',
        'TNND Camp Payment',
        'Cooking and Culture Payment',
        'Volunteer Application Payment',
        'Other (specify)',
      ],
    },
    sections: [
      {
        id: 'hero',
        label: 'Hero',
        description: 'Logo, title, and description.',
        enabled: true,
      },
      {
        id: 'amount',
        label: 'Donation Details',
        description: 'Amount, frequency, and category selection.',
        enabled: true,
      },
      {
        id: 'donor',
        label: 'Donor Information',
        description: 'Name, email, and phone collection.',
        enabled: true,
      },
      {
        id: 'address',
        label: 'Address',
        description: 'Mailing address fields.',
        enabled: true,
      },
      {
        id: 'tribute',
        label: 'Tribute',
        description: 'Honor or memory gift details.',
        enabled: true,
      },
      {
        id: 'fees',
        label: 'Processing Fees',
        description: 'Cover-fee checkbox and payment method selector.',
        enabled: true,
      },
      {
        id: 'submit',
        label: 'Submit',
        description: 'Summary, disclaimer, and call to action.',
        enabled: true,
      },
    ],
  };
}

module.exports = {
  DEFAULT_LIVE_PUBLISHABLE_KEY,
  DEFAULT_PROCESS_DONATION_API,
  DEFAULT_TEST_PUBLISHABLE_KEY,
  getDefaultDonationFormConfig,
};
