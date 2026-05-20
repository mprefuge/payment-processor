// All supported field types, grouped by category
export const FIELD_CATEGORIES = [
  {
    id: 'content',
    label: 'Content',
    icon: '✦',
    fields: [
      { type: 'heading', label: 'Heading', icon: 'H', desc: 'Section heading (H1–H4)' },
      { type: 'paragraph', label: 'Paragraph', icon: '¶', desc: 'Body text block' },
      { type: 'image', label: 'Image', icon: '🖼', desc: 'Image with URL' },
      { type: 'divider', label: 'Divider', icon: '—', desc: 'Horizontal rule' },
      { type: 'spacer', label: 'Spacer', icon: '↕', desc: 'Vertical whitespace' },
      { type: 'html_embed', label: 'HTML', icon: '<>', desc: 'Embed custom HTML' },
    ],
  },
  {
    id: 'basic',
    label: 'Basic Fields',
    icon: '◻',
    fields: [
      { type: 'text', label: 'Text', icon: 'T', desc: 'Single-line text input' },
      { type: 'email', label: 'Email', icon: '✉', desc: 'Email address' },
      { type: 'phone', label: 'Phone', icon: '☎', desc: 'Phone number' },
      { type: 'textarea', label: 'Text Area', icon: '❡', desc: 'Multi-line text' },
      { type: 'number', label: 'Number', icon: '#', desc: 'Numeric input' },
      { type: 'date', label: 'Date', icon: '📅', desc: 'Date picker' },
      { type: 'time', label: 'Time', icon: '🕐', desc: 'Time picker' },
      { type: 'url', label: 'URL', icon: '🔗', desc: 'Website URL input' },
      { type: 'hidden', label: 'Hidden', icon: '◌', desc: 'Hidden field with value' },
    ],
  },
  {
    id: 'selection',
    label: 'Selection',
    icon: '☑',
    fields: [
      { type: 'checkbox', label: 'Checkbox', icon: '☑', desc: 'Single checkbox' },
      { type: 'checkbox_group', label: 'Checkboxes', icon: '☑', desc: 'Multiple checkboxes' },
      { type: 'radio', label: 'Radio', icon: '◉', desc: 'Radio button group' },
      { type: 'dropdown', label: 'Dropdown', icon: '▼', desc: 'Select dropdown' },
      { type: 'toggle', label: 'Toggle', icon: '⬤', desc: 'On/off toggle switch' },
      { type: 'star_rating', label: 'Star Rating', icon: '★', desc: 'Rate 1–5 stars' },
      { type: 'range_slider', label: 'Slider', icon: '◈', desc: 'Numeric range slider' },
      { type: 'likert', label: 'Likert Scale', icon: '≡', desc: 'Agree–disagree scale' },
    ],
  },
  {
    id: 'personal',
    label: 'Personal Info',
    icon: '👤',
    fields: [
      { type: 'full_name', label: 'Full Name', icon: '👤', desc: 'First + Last name' },
      { type: 'billing_address', label: 'Address', icon: '🏠', desc: 'Full address block' },
      { type: 'country', label: 'Country', icon: '🌍', desc: 'Country dropdown' },
      { type: 'zip_code', label: 'ZIP Code', icon: '📮', desc: 'Postal code' },
      { type: 'date_of_birth', label: 'Date of Birth', icon: '🎂', desc: 'Birthday field' },
      { type: 'organization', label: 'Organization', icon: '🏢', desc: 'Company / org name' },
    ],
  },
  {
    id: 'advanced',
    label: 'Advanced',
    icon: '⚙',
    fields: [
      { type: 'file_upload', label: 'File Upload', icon: '📎', desc: 'Upload a file' },
      { type: 'signature', label: 'Signature', icon: '✍', desc: 'Digital signature pad' },
      { type: 'terms_acceptance', label: 'Terms', icon: '📜', desc: 'Terms & conditions link' },
      { type: 'section_header', label: 'Section', icon: '▬', desc: 'Named section divider' },
    ],
  },
  {
    id: 'payment',
    label: 'Payment',
    icon: '$',
    fields: [
      { type: 'amount', label: 'Amount', icon: '$', desc: 'Fixed or custom amount' },
      { type: 'amount_pills', label: 'Amount Pills', icon: '💊', desc: 'Preset amount buttons' },
      { type: 'donation_frequency', label: 'Frequency', icon: '🔄', desc: 'One-time / monthly / yearly' },
      { type: 'category', label: 'Fund / Category', icon: '🏷', desc: 'Fund / designation' },
      { type: 'cover_fee', label: 'Cover Fee', icon: '🧾', desc: 'Processing fee toggle' },
      { type: 'payment_method', label: 'Payment Method', icon: '💳', desc: 'Card / ACH / wallet' },
      { type: 'stripe_payment_element', label: 'Stripe Element', icon: '⚡', desc: 'Stripe unified payment UI' },
      { type: 'card_input', label: 'Card Input', icon: '💳', desc: 'Card number, exp, CVC' },
      { type: 'ach_input', label: 'ACH Input', icon: '🏦', desc: 'Bank account input' },
      { type: 'order_summary', label: 'Order Summary', icon: '📋', desc: 'Display total before submit' },
    ],
  },
];

export function getFieldMeta(type) {
  for (const cat of FIELD_CATEGORIES) {
    const found = cat.fields.find((f) => f.type === type);
    if (found) return found;
  }
  return { type, label: type, icon: '□', desc: '' };
}

// Default Salesforce mapping suggestions per field type
export const SF_SUGGESTIONS = {
  text: [
    { object: 'Contact', field: 'Description', label: 'Contact Description' },
    { object: 'Lead', field: 'Description', label: 'Lead Description' },
  ],
  email: [
    { object: 'Contact', field: 'Email', label: 'Contact Email' },
    { object: 'Lead', field: 'Email', label: 'Lead Email' },
  ],
  phone: [
    { object: 'Contact', field: 'Phone', label: 'Contact Phone' },
    { object: 'Contact', field: 'MobilePhone', label: 'Mobile Phone' },
    { object: 'Lead', field: 'Phone', label: 'Lead Phone' },
  ],
  full_name: [
    { object: 'Contact', field: 'FirstName+LastName', label: 'Contact First+Last Name' },
    { object: 'Lead', field: 'FirstName+LastName', label: 'Lead First+Last Name' },
  ],
  organization: [
    { object: 'Contact', field: 'Account.Name', label: 'Account Name' },
    { object: 'Lead', field: 'Company', label: 'Lead Company' },
  ],
  billing_address: [
    { object: 'Contact', field: 'MailingStreet+City+State+Zip+Country', label: 'Contact Mailing Address' },
    { object: 'Lead', field: 'Street+City+State+PostalCode+Country', label: 'Lead Address' },
  ],
  amount: [
    { object: 'Transaction__c', field: 'Amount__c', label: 'Transaction Amount' },
    { object: 'Opportunity', field: 'Amount', label: 'Opportunity Amount' },
  ],
  donation_frequency: [
    { object: 'Transaction__c', field: 'Recurring_Type__c', label: 'Recurring Type' },
  ],
  category: [
    { object: 'Transaction__c', field: 'Campaign__c', label: 'Campaign (lookup)' },
    { object: 'Transaction__c', field: 'Fund__c', label: 'Fund' },
  ],
  date_of_birth: [
    { object: 'Contact', field: 'Birthdate', label: 'Contact Birthdate' },
  ],
  checkbox: [
    { object: 'Contact', field: 'Email_Opt_In__c', label: 'Email Opt-in' },
    { object: 'Lead', field: 'Email_Opt_In__c', label: 'Lead Email Opt-in' },
  ],
};

/**
 * Returns which Salesforce field types are compatible with a given form field type.
 * Used to filter the field list when the user picks a Salesforce object.
 */
export function getSfCompatibleTypes(fieldType) {
  switch (fieldType) {
    case 'text':
    case 'hidden':
    case 'section_header':
      return ['string', 'textarea', 'url', 'id', 'reference', 'picklist', 'combobox'];
    case 'textarea':
      return ['string', 'textarea'];
    case 'email':
      return ['email', 'string'];
    case 'phone':
      return ['phone', 'string'];
    case 'url':
      return ['url', 'string'];
    case 'number':
    case 'amount':
    case 'amount_pills':
    case 'range_slider':
      return ['double', 'integer', 'long', 'currency', 'percent'];
    case 'date':
    case 'date_of_birth':
      return ['date', 'datetime'];
    case 'time':
      return ['time', 'datetime', 'string'];
    case 'checkbox':
    case 'toggle':
    case 'terms_acceptance':
      return ['boolean'];
    case 'dropdown':
    case 'radio':
    case 'donation_frequency':
      return ['picklist', 'string', 'combobox'];
    case 'checkbox_group':
    case 'likert':
      return ['multipicklist', 'string'];
    case 'full_name':
    case 'organization':
      return ['string', 'textarea'];
    case 'billing_address':
      return ['string', 'textarea'];
    case 'country':
    case 'zip_code':
      return ['string', 'picklist', 'combobox'];
    case 'category':
      return ['picklist', 'string', 'id', 'reference'];
    case 'file_upload':
      return ['base64', 'string'];
    default:
      // Content-only fields (heading, paragraph, divider, spacer, html_embed, image)
      return null; // null = not mappable
  }
}

export function createDefaultField(type) {
  const meta = getFieldMeta(type);
  const base = {
    type,
    label: meta.label,
    placeholder: '',
    required: false,
    enabled: true,
    settings: {},
    salesforce: { object: '', field: '', transform: '' },
    conditions: [],
  };

  switch (type) {
    // ── Content ──────────────────────────────────────────────────────────
    case 'heading':
      base.label = 'Section Heading';
      base.settings = { level: 'h2', text: 'Section Heading', align: 'left' };
      base.required = false;
      break;
    case 'paragraph':
      base.label = 'Paragraph';
      base.settings = { text: 'Add your description or supporting copy here.', align: 'left' };
      base.required = false;
      break;
    case 'image':
      base.label = 'Image';
      base.settings = { src: '', alt: '', width: '100%', align: 'center' };
      base.required = false;
      break;
    case 'divider':
      base.label = 'Divider';
      base.settings = { style: 'solid', color: '#e5e0da', marginTop: 8, marginBottom: 8 };
      base.required = false;
      break;
    case 'spacer':
      base.label = 'Spacer';
      base.settings = { height: 24 };
      base.required = false;
      break;
    case 'html_embed':
      base.label = 'Custom HTML';
      base.settings = { html: '<p>Custom HTML here</p>' };
      base.required = false;
      break;
    case 'section_header':
      base.label = 'Section';
      base.settings = { title: 'Section Title', subtitle: '', showLine: true };
      base.required = false;
      break;

    // ── Basic ────────────────────────────────────────────────────────────
    case 'email':
      base.label = 'Email Address';
      base.required = true;
      base.placeholder = 'you@example.com';
      base.salesforce = { object: 'Contact', field: 'Email', transform: '' };
      break;
    case 'phone':
      base.label = 'Phone Number';
      base.placeholder = '(555) 555-5555';
      base.salesforce = { object: 'Contact', field: 'Phone', transform: '' };
      break;
    case 'date':
      base.label = 'Date';
      base.settings = { dateFormat: 'YYYY-MM-DD', minDate: '', maxDate: '' };
      break;
    case 'time':
      base.label = 'Time';
      base.settings = { format: '12h' };
      break;
    case 'url':
      base.label = 'Website URL';
      base.placeholder = 'https://';
      break;
    case 'hidden':
      base.label = 'Hidden Field';
      base.settings = { value: '', populateFrom: 'static' }; // static | url_param | cookie
      base.required = false;
      break;

    // ── Selection ────────────────────────────────────────────────────────
    case 'checkbox':
      base.settings = { checkboxLabel: 'I agree to the terms and conditions' };
      break;
    case 'checkbox_group':
      base.label = 'Select All That Apply';
      base.settings = {
        options: [
          { label: 'Option A', value: 'a' },
          { label: 'Option B', value: 'b' },
          { label: 'Option C', value: 'c' },
        ],
        minSelect: 0,
        maxSelect: null,
        layout: 'vertical',
      };
      break;
    case 'radio':
      base.label = 'Choose One';
      base.settings = {
        options: [
          { label: 'Option A', value: 'a' },
          { label: 'Option B', value: 'b' },
          { label: 'Option C', value: 'c' },
        ],
        layout: 'vertical',
        defaultValue: '',
      };
      break;
    case 'dropdown':
      base.label = 'Select an Option';
      base.settings = {
        options: [
          { label: 'Option A', value: 'a' },
          { label: 'Option B', value: 'b' },
          { label: 'Option C', value: 'c' },
        ],
        placeholder: 'Choose…',
        defaultValue: '',
      };
      break;
    case 'toggle':
      base.label = 'Toggle Option';
      base.settings = { toggleLabel: 'Enable this option', defaultChecked: false };
      break;
    case 'star_rating':
      base.label = 'Rating';
      base.settings = { maxStars: 5, defaultRating: 0, allowHalf: false };
      break;
    case 'range_slider':
      base.label = 'Select a Value';
      base.settings = { min: 0, max: 100, step: 1, defaultValue: 50, showValue: true, prefix: '', suffix: '' };
      break;
    case 'likert':
      base.label = 'Likert Scale';
      base.settings = {
        question: 'How do you feel about this?',
        scale: [
          { label: 'Strongly Disagree', value: '1' },
          { label: 'Disagree', value: '2' },
          { label: 'Neutral', value: '3' },
          { label: 'Agree', value: '4' },
          { label: 'Strongly Agree', value: '5' },
        ],
      };
      break;

    // ── Personal Info ────────────────────────────────────────────────────
    case 'full_name':
      base.label = 'Full Name';
      base.required = true;
      base.settings = { showMiddle: false, showPrefix: false, showSuffix: false };
      base.salesforce = { object: 'Contact', field: 'FirstName+LastName', transform: '' };
      break;
    case 'billing_address':
      base.label = 'Billing Address';
      base.settings = { showAddress2: true, showCountry: true, showState: true };
      base.salesforce = { object: 'Contact', field: 'MailingStreet+City+State+Zip+Country', transform: '' };
      break;
    case 'date_of_birth':
      base.label = 'Date of Birth';
      base.settings = { format: 'MM/DD/YYYY' };
      base.salesforce = { object: 'Contact', field: 'Birthdate', transform: '' };
      break;
    case 'organization':
      base.label = 'Organization';
      base.placeholder = 'Company or organization name';
      base.salesforce = { object: 'Contact', field: 'Account.Name', transform: '' };
      break;

    // ── Advanced ─────────────────────────────────────────────────────────
    case 'file_upload':
      base.label = 'Upload File';
      base.settings = { accept: '.pdf,.jpg,.png', maxSizeMb: 10, multiple: false };
      break;
    case 'signature':
      base.label = 'Signature';
      base.settings = { penColor: '#1f1c1c', bgColor: '#f8f6f2', height: 120 };
      base.required = true;
      break;
    case 'terms_acceptance':
      base.label = 'Terms & Conditions';
      base.settings = {
        text: 'I agree to the',
        linkText: 'Terms and Conditions',
        linkUrl: 'https://example.com/terms',
        required: true,
      };
      base.required = true;
      break;

    // ── Payment ──────────────────────────────────────────────────────────
    case 'amount_pills':
      base.label = 'Select Amount';
      base.required = true;
      base.settings = { presets: [25, 50, 100, 250], allowCustom: true, currency: 'USD' };
      break;
    case 'amount':
      base.label = 'Donation Amount';
      base.required = true;
      base.settings = { currency: 'USD', min: 1, max: null, fixedAmount: null };
      break;
    case 'category':
      base.label = 'Fund / Designation';
      base.settings = {
        inputMode: 'dropdown',
        options: [
          { label: 'General Fund', value: 'general' },
          { label: 'Building Fund', value: 'building' },
          { label: 'Scholarship Fund', value: 'scholarship' },
        ],
      };
      base.salesforce = { object: 'Transaction__c', field: 'Campaign__c', transform: '' };
      break;
    case 'cover_fee':
      base.label = 'Cover Processing Fee';
      base.settings = { feePercent: 2.9, feeFixed: 0.3, defaultChecked: false };
      break;
    case 'payment_method':
      base.label = 'Payment Method';
      base.settings = {
        options: ['card', 'ach', 'apple_pay', 'google_pay'],
        defaultMethod: 'card',
        allowMultiple: false,
      };
      break;
    case 'stripe_payment_element':
      base.label = 'Payment';
      base.settings = {
        layout: 'tabs', // tabs | accordion | auto
        paymentMethods: ['card', 'us_bank_account', 'link'],
        showSaveCard: true,
      };
      base.required = true;
      break;
    case 'donation_frequency':
      base.label = 'Giving Frequency';
      base.settings = {
        options: [
          { label: 'One-time', value: 'one_time' },
          { label: 'Monthly', value: 'monthly' },
          { label: 'Quarterly', value: 'quarterly' },
          { label: 'Yearly', value: 'yearly' },
        ],
        defaultValue: 'one_time',
        style: 'pills', // pills | dropdown | radio
      };
      base.salesforce = { object: 'Transaction__c', field: 'Recurring_Type__c', transform: '' };
      break;
    case 'order_summary':
      base.label = 'Order Summary';
      base.settings = {
        showFee: true,
        showFrequency: true,
        showFund: true,
        submitLabel: 'Complete Donation',
      };
      base.required = false;
      break;
    case 'card_input':
      base.label = 'Card Details';
      base.required = true;
      break;
    case 'ach_input':
      base.label = 'Bank Account';
      base.required = true;
      break;
    default:
      break;
  }

  return base;
}
