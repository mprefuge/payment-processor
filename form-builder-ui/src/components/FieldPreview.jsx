import React from 'react';
import { formatMoney } from '../utils';

export default function FieldPreview({ field, accent = '#bd2135' }) {
  const { type, label, placeholder, settings = {} } = field;

  const fakeInput = (ph, type = 'text') => (
    <input className="fp-input" type={type} placeholder={ph || label || ''} readOnly tabIndex={-1} />
  );

  const fakeSelect = (opts) => (
    <select className="fp-input" readOnly tabIndex={-1} defaultValue="">
      <option value="" disabled>{label || 'Select…'}</option>
      {opts.map((o) => <option key={o.value ?? o} value={o.value ?? o}>{o.label ?? o}</option>)}
    </select>
  );

  const pill = (lbl, active) => (
    <span key={lbl} className={`fp-pill${active ? ' is-active' : ''}`} style={active ? { background: accent, color: '#fff', borderColor: accent } : {}}>
      {lbl}
    </span>
  );

  switch (type) {
    case 'text':
    case 'number':
      return fakeInput(placeholder || label);

    case 'email':
      return fakeInput(placeholder || 'you@example.com', 'email');

    case 'phone':
      return fakeInput(placeholder || '(555) 555-5555', 'tel');

    case 'textarea':
      return <textarea className="fp-input fp-textarea" placeholder={placeholder || label} readOnly tabIndex={-1} />;

    case 'checkbox':
      return (
        <label className="fp-checkbox-row">
          <input type="checkbox" readOnly tabIndex={-1} />
          <span>{settings.checkboxLabel || 'I agree'}</span>
        </label>
      );

    case 'full_name':
      return (
        <div className="fp-row">
          <input className="fp-input" placeholder="First name" readOnly tabIndex={-1} />
          {settings.showMiddle && <input className="fp-input" placeholder="Middle" readOnly tabIndex={-1} />}
          <input className="fp-input" placeholder="Last name" readOnly tabIndex={-1} />
        </div>
      );

    case 'billing_address':
      return (
        <div className="fp-stack">
          <input className="fp-input" placeholder="Street address" readOnly tabIndex={-1} />
          {settings.showAddress2 && <input className="fp-input" placeholder="Apt, suite…" readOnly tabIndex={-1} />}
          <div className="fp-row">
            <input className="fp-input" placeholder="City" readOnly tabIndex={-1} />
            <input className="fp-input fp-input-sm" placeholder="State" readOnly tabIndex={-1} />
            <input className="fp-input fp-input-sm" placeholder="ZIP" readOnly tabIndex={-1} />
          </div>
          {settings.showCountry && fakeSelect([{ label: 'United States', value: 'US' }])}
        </div>
      );

    case 'country':
      return fakeSelect([{ label: 'United States', value: 'US' }, { label: 'Canada', value: 'CA' }]);

    case 'zip_code':
      return fakeInput(placeholder || 'Postal code');

    case 'amount':
      return (
        <div className="fp-amount-row">
          <span className="fp-currency">{settings.currency || '$'}</span>
          <input className="fp-input" type="number" placeholder={settings.fixedAmount ?? '0.00'} readOnly tabIndex={-1} />
        </div>
      );

    case 'amount_pills': {
      const presets = settings.presets || [25, 50, 100, 250];
      return (
        <div className="fp-pills">
          {presets.map((amt, i) => pill(formatMoney(amt, settings.currency), i === 1))}
          {settings.allowCustom && pill('Custom', false)}
        </div>
      );
    }

    case 'donation_frequency': {
      const opts = settings.options || [
        { label: 'One-time', value: 'one_time' },
        { label: 'Monthly', value: 'monthly' },
      ];
      return (
        <div className="fp-pills">
          {opts.map((o, i) => pill(o.label, i === 0))}
        </div>
      );
    }

    case 'category': {
      const opts = settings.options || [];
      if (settings.inputMode === 'pills') {
        return <div className="fp-pills">{opts.map((o) => pill(o.label, false))}</div>;
      }
      return fakeSelect(opts);
    }

    case 'cover_fee':
      return (
        <div className="fp-cover-fee">
          <label className="fp-checkbox-row">
            <input type="checkbox" readOnly tabIndex={-1} defaultChecked={settings.defaultChecked} />
            <span>Cover the {settings.feePercent ?? 2.9}% + ${(settings.feeFixed ?? 0.3).toFixed(2)} processing fee</span>
          </label>
          <div className="fp-fee-breakdown">
            <span>Base: <strong>$100.00</strong></span>
            <span>Fee: <strong>+${(100 * (settings.feePercent ?? 2.9) / 100 + (settings.feeFixed ?? 0.3)).toFixed(2)}</strong></span>
          </div>
        </div>
      );

    case 'payment_method': {
      const opts = settings.options || ['card', 'ach'];
      const labels = { card: '💳 Card', ach: '🏦 ACH', apple_pay: ' Apple Pay', google_pay: '⬛ Google Pay' };
      return (
        <div className="fp-pills">
          {opts.map((o, i) => pill(labels[o] || o, i === 0))}
        </div>
      );
    }

    case 'card_input':
      return (
        <div className="fp-stack">
          <input className="fp-input" placeholder="Card number" readOnly tabIndex={-1} />
          <div className="fp-row">
            <input className="fp-input" placeholder="MM / YY" readOnly tabIndex={-1} />
            <input className="fp-input fp-input-sm" placeholder="CVC" readOnly tabIndex={-1} />
          </div>
        </div>
      );

    case 'ach_input':
      return (
        <div className="fp-stack">
          <input className="fp-input" placeholder="Routing number" readOnly tabIndex={-1} />
          <input className="fp-input" placeholder="Account number" readOnly tabIndex={-1} />
          <select className="fp-input" readOnly tabIndex={-1} defaultValue="">
            <option value="" disabled>Account type</option>
            <option>Checking</option>
            <option>Savings</option>
          </select>
        </div>
      );

    default:
      return <div className="fp-placeholder">{label || type}</div>;
  }
}
