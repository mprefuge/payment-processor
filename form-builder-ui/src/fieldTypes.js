// All supported field types, grouped by category
export const FIELD_CATEGORIES = [
  {
    id: 'basic',
    label: 'Basic Fields',
    fields: [
      { type: 'text', label: 'Text', icon: '𝐓', desc: 'Single-line text input' },
      { type: 'email', label: 'Email', icon: '✉', desc: 'Email address' },
      { type: 'phone', label: 'Phone', icon: '☎', desc: 'Phone number' },
      { type: 'textarea', label: 'Text Area', icon: '¶', desc: 'Multi-line text' },
      { type: 'number', label: 'Number', icon: '#', desc: 'Numeric input' },
      { type: 'checkbox', label: 'Checkbox', icon: '☑', desc: 'Single checkbox' },
    ],
  },
  {
    id: 'billing',
    label: 'Billing',
    fields: [
      { type: 'full_name', label: 'Full Name', icon: '👤', desc: 'First + Last name' },
      { type: 'billing_address', label: 'Billing Address', icon: '🏠', desc: 'Full address block' },
      { type: 'country', label: 'Country', icon: '🌍', desc: 'Country dropdown' },
      { type: 'zip_code', label: 'ZIP Code', icon: '📮', desc: 'Postal code' },
    ],
  },
  {
    id: 'payment',
    label: 'Payment',
    fields: [
      { type: 'amount', label: 'Amount', icon: '$', desc: 'Fixed or custom amount' },
      { type: 'amount_pills', label: 'Amount Pills', icon: '💊', desc: 'Preset amount buttons' },
      {
        type: 'donation_frequency',
        label: 'Frequency',
        icon: '🔄',
        desc: 'One-time / monthly / yearly',
      },
      { type: 'category', label: 'Category', icon: '🏷', desc: 'Fund / designation' },
      { type: 'cover_fee', label: 'Cover Fee', icon: '🧾', desc: 'Processing fee toggle' },
      { type: 'payment_method', label: 'Payment Method', icon: '💳', desc: 'Card / ACH / wallet' },
      { type: 'card_input', label: 'Card Input', icon: '💳', desc: 'Card number, exp, CVC' },
      { type: 'ach_input', label: 'ACH Input', icon: '🏦', desc: 'Bank account input' },
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

export function createDefaultField(type) {
  const meta = getFieldMeta(type);
  const base = {
    type,
    label: meta.label,
    placeholder: '',
    required: false,
    settings: {},
  };

  switch (type) {
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
      base.settings = {
        inputMode: 'dropdown',
        options: [
          { label: 'General Fund', value: 'general' },
          { label: 'Building Fund', value: 'building' },
          { label: 'Scholarship Fund', value: 'scholarship' },
        ],
      };
      break;
    case 'cover_fee':
      base.label = 'Cover Processing Fee';
      base.settings = { feePercent: 2.9, feeFixed: 0.3, defaultChecked: false };
      break;
    case 'payment_method':
      base.label = 'Payment Method';
      base.settings = { options: ['card', 'ach', 'apple_pay', 'google_pay'], allowMultiple: false };
      break;
    case 'donation_frequency':
      base.label = 'Giving Frequency';
      base.settings = {
        options: [
          { label: 'One-time', value: 'one_time' },
          { label: 'Monthly', value: 'monthly' },
          { label: 'Yearly', value: 'yearly' },
        ],
        defaultValue: 'one_time',
      };
      break;
    case 'full_name':
      base.label = 'Full Name';
      base.required = true;
      base.settings = { showMiddle: false };
      break;
    case 'billing_address':
      base.label = 'Billing Address';
      base.settings = { showAddress2: true, showCountry: true };
      break;
    case 'checkbox':
      base.settings = { checkboxLabel: 'I agree to the terms and conditions' };
      break;
    case 'email':
      base.label = 'Email';
      base.required = true;
      base.placeholder = 'you@example.com';
      break;
    case 'phone':
      base.label = 'Phone';
      base.placeholder = '(555) 555-5555';
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
