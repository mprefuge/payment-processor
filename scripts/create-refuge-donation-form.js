/**
 * Creates a Refuge International donation form in the form builder,
 * replicating the form structure at https://www.refugeintl.org/#donate
 *
 * Usage: node scripts/create-refuge-donation-form.js
 * Requires the Azure Functions host to be running on port 7075.
 */

const BASE = 'http://127.0.0.1:7075/api';

let _counter = 0;
function createId(prefix = 'id') {
  _counter += 1;
  return `${prefix}_${Date.now().toString(36)}_${_counter}_${Math.random().toString(36).slice(2, 6)}`;
}

function col(field, width = 12) {
  return { id: createId('col'), width, field };
}

function row(...cols) {
  return { id: createId('row'), columns: cols };
}

// ─── Form pages ───────────────────────────────────────────────────────────────

const pages = [
  // ── Page 1: Donation Details ───────────────────────────────────────────────
  {
    id: createId('page'),
    name: 'Donation Details',
    nextLabel: 'Next',
    prevLabel: '',
    showProgress: true,
    rows: [
      // Giving frequency
      row(col({
        id: createId('field'),
        type: 'donation_frequency',
        label: 'Giving Frequency',
        placeholder: '',
        settings: {
          style: 'pills',
          options: [
            { label: 'One-Time',  value: 'one_time'  },
            { label: 'Monthly',   value: 'monthly'   },
          ],
        },
        conditions: [],
        salesforce: {},
      })),

      // Donation amount
      row(col({
        id: createId('field'),
        type: 'amount_pills',
        label: 'Select Amount',
        placeholder: '',
        settings: {
          currency: 'USD',
          presets: [500, 100, 50, 25, 10],
          allowCustom: true,
          defaultValue: 50,
        },
        conditions: [],
        salesforce: {},
      })),

      // Fund / category
      row(col({
        id: createId('field'),
        type: 'dropdown',
        label: 'Fund',
        placeholder: '',
        settings: {
          placeholder: 'Where Needed Most (General Fund)',
          options: [
            { label: 'Where Needed Most (General Fund)',  value: 'general'           },
            { label: 'ESL Ministry',                      value: 'esl'               },
            { label: 'Refugee Support',                   value: 'refugee_support'   },
            { label: 'English Mentoring',                 value: 'english_mentoring' },
            { label: 'The Nations Next Door',             value: 'tnnd'              },
            { label: 'Immigrant Legal Services',          value: 'legal_services'    },
          ],
        },
        conditions: [],
        salesforce: {},
      })),

      // Calculated total
      row(col({
        id: createId('field'),
        type: 'order_summary',
        label: 'Total',
        placeholder: '',
        settings: {},
        conditions: [],
        salesforce: {},
      })),
    ],
  },

  // ── Page 2: Your Information ───────────────────────────────────────────────
  {
    id: createId('page'),
    name: 'Your Information',
    nextLabel: 'Continue to Billing',
    prevLabel: 'Back',
    showProgress: true,
    rows: [
      // Section header
      row(col({
        id: createId('field'),
        type: 'paragraph',
        label: '',
        placeholder: '',
        settings: {
          text: 'Please enter your contact information so we can send your tax receipt.',
          align: 'left',
        },
        conditions: [],
        salesforce: {},
      })),

      // Full name
      row(col({
        id: createId('field'),
        type: 'full_name',
        label: 'Full Name',
        placeholder: '',
        settings: {
          showPrefix: false,
          showMiddle: false,
          showSuffix: false,
          required: true,
        },
        conditions: [],
        salesforce: {},
      })),

      // Email (6) + Phone (6)
      row(
        col({
          id: createId('field'),
          type: 'email',
          label: 'Email Address',
          placeholder: 'you@example.com',
          settings: { required: true },
          conditions: [],
          salesforce: {},
        }, 6),
        col({
          id: createId('field'),
          type: 'phone',
          label: 'Phone',
          placeholder: '(555) 555-5555',
          settings: { required: false },
          conditions: [],
          salesforce: {},
        }, 6),
      ),

      // Organization (optional)
      row(col({
        id: createId('field'),
        type: 'organization',
        label: 'Organization / Company',
        placeholder: 'Optional — leave blank for individual gift',
        settings: { required: false },
        conditions: [],
        salesforce: {},
      })),
    ],
  },

  // ── Page 3: Billing & Payment ──────────────────────────────────────────────
  {
    id: createId('page'),
    name: 'Billing & Payment',
    nextLabel: 'Complete Donation',
    prevLabel: 'Back',
    showProgress: true,
    rows: [
      // Billing address
      row(col({
        id: createId('field'),
        type: 'billing_address',
        label: 'Billing Address',
        placeholder: '',
        settings: {
          showAddress2: true,
          showState: true,
          showCountry: false,
          required: true,
        },
        conditions: [],
        salesforce: {},
      })),

      // Stripe payment element
      row(col({
        id: createId('field'),
        type: 'stripe_payment_element',
        label: 'Payment',
        placeholder: '',
        settings: {
          paymentMethods: ['card', 'us_bank_account'],
        },
        conditions: [],
        salesforce: {},
      })),

      // Cover processing fee
      row(col({
        id: createId('field'),
        type: 'cover_fee',
        label: 'Cover Processing Fee',
        placeholder: '',
        settings: {
          feePercent: 2.9,
          feeFixed: 0.30,
          defaultChecked: false,
        },
        conditions: [],
        salesforce: {},
      })),

      // Terms
      row(col({
        id: createId('field'),
        type: 'terms_acceptance',
        label: 'Terms',
        placeholder: '',
        settings: {
          text: 'I agree to the',
          linkText: 'Terms & Conditions',
          linkUrl: 'https://www.refugeintl.org',
          required: true,
        },
        conditions: [],
        salesforce: {},
      })),
    ],
  },
];

// ─── Confirmation page ────────────────────────────────────────────────────────

const confirmationPage = {
  message:
    'Thank you for your generous gift! Refuge International, Inc. is a registered 501(c)(3) organization (EIN: 45-3161988). ' +
    'Your donation is tax-deductible to the full extent allowed by law. A receipt will be emailed to you shortly.',
};

// ─── Full config ──────────────────────────────────────────────────────────────

const config = {
  name: 'Refuge International — Donate',
  branding: {
    title:      'Support Refuge International',
    subtitle:   'Refuge International exists to glorify God by partnering with local churches to love refugees & immigrants.',
    logoUrl:    'https://images.squarespace-cdn.com/content/v1/5af0bc3a96d45593d7d7e55b/c8c56eb8-9c50-4540-822a-5da3f5d0c268/refuge-logo-edit+%28circle+with+horizontal+RI+name%29+-+small.png',
    accentColor: '#bd2135',
  },
  display: {
    mode: 'modal',
  },
  pages,
  confirmationPage,
};

// ─── POST to form builder API ─────────────────────────────────────────────────

async function main() {
  console.log('\nCreating Refuge International donation form…');
  console.log(`  Endpoint : POST ${BASE}/form-builder/configs`);
  console.log(`  Pages    : ${pages.length}`);

  let res;
  try {
    res = await fetch(`${BASE}/form-builder/configs`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ config }),
    });
  } catch (err) {
    console.error(`\n✘ Network error — is the Azure Functions host running on port 7075?\n  ${err.message}`);
    process.exit(1);
  }

  if (res.status === 200 || res.status === 201) {
    const body = await res.json();
    const id = body?.id ?? body?.record?.id ?? 'unknown';
    console.log(`\n✔ Form created!`);
    console.log(`  ID   : ${id}`);
    console.log(`  Open : http://localhost:5173/?load=${id}`);
    console.log(`         (Vite dev server must be running)`);
  } else {
    const text = await res.text().catch(() => '');
    console.error(`\n✘ Server returned ${res.status}:\n  ${text}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
