import React from 'react';
import { formatMoney } from '../utils';

export default function FieldPreview({ field, accent = '#bd2135' }) {
  const { type, label, placeholder, settings = {} } = field;

  const fakeInput = (ph, inputType = 'text') => (
    <input className="fp-input" type={inputType} placeholder={ph || label || ''} readOnly tabIndex={-1} />
  );

  const fakeSelect = (opts, ph) => (
    <select className="fp-input" readOnly tabIndex={-1} defaultValue="">
      <option value="" disabled>{ph || label || 'Select…'}</option>
      {(opts || []).map((o) => (
        <option key={o.value ?? o} value={o.value ?? o}>{o.label ?? o}</option>
      ))}
    </select>
  );

  const pill = (lbl, active, key) => (
    <span
      key={key ?? lbl}
      className={`fp-pill${active ? ' is-active' : ''}`}
      style={active ? { background: accent, color: '#fff', borderColor: accent } : {}}
    >
      {lbl}
    </span>
  );

  switch (type) {
    // â”€â”€ Content â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    case 'heading': {
      const Tag = settings.level || 'h2';
      return (
        <div className={`fp-heading fp-heading-${Tag}`} style={{ textAlign: settings.align || 'left' }}>
          {settings.text || label}
        </div>
      );
    }

    case 'paragraph':
      return (
        <p className="fp-paragraph" style={{ textAlign: settings.align || 'left' }}>
          {settings.text || 'Paragraph text…'}
        </p>
      );

    case 'image':
      return settings.src ? (
        <img src={settings.src} alt={settings.alt || ''} className="fp-image" style={{ width: settings.width || '100%' }} />
      ) : (
        <div className="fp-image-placeholder">
          <span>🖼</span>
          <span>Image</span>
        </div>
      );

    case 'divider':
      return <hr className="fp-divider" style={{ borderColor: settings.color || '#e5e0da', borderStyle: settings.style || 'solid', marginTop: settings.marginTop ?? 8, marginBottom: settings.marginBottom ?? 8 }} />;

    case 'spacer':
      return <div className="fp-spacer" style={{ height: settings.height ?? 24 }} />;

    case 'html_embed':
      return (
        <div className="fp-html-badge">
          <span className="fp-html-icon">&lt;/&gt;</span>
          <span>Custom HTML</span>
        </div>
      );

    case 'section_header':
      return (
        <div className="fp-section-header">
          <div className="fp-section-title">{settings.title || 'Section Title'}</div>
          {settings.subtitle && <div className="fp-section-subtitle">{settings.subtitle}</div>}
          {settings.showLine !== false && <div className="fp-section-line" style={{ background: accent }} />}
        </div>
      );

    // â”€â”€ Basic â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    case 'text':
    case 'number':
    case 'url':
    case 'organization':
      return fakeInput(placeholder || label);

    case 'email':
      return fakeInput(placeholder || 'you@example.com', 'email');

    case 'phone':
      return fakeInput(placeholder || '(555) 555-5555', 'tel');

    case 'textarea':
      return (
        <textarea className="fp-input fp-textarea" placeholder={placeholder || label} readOnly tabIndex={-1} />
      );

    case 'date':
    case 'date_of_birth':
      return fakeInput('MM / DD / YYYY', 'text');

    case 'time':
      return fakeInput('HH : MM', 'text');

    case 'hidden':
      return (
        <div className="fp-hidden-badge">
          <span>◌</span>
          <span>Hidden field: {settings.value || '…'}</span>
        </div>
      );

    // â”€â”€ Selection â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    case 'checkbox':
      return (
        <label className="fp-checkbox-row">
          <input type="checkbox" readOnly tabIndex={-1} />
          <span>{settings.checkboxLabel || 'I agree'}</span>
        </label>
      );

    case 'checkbox_group': {
      const opts = settings.options || [];
      const layout = settings.layout || 'vertical';
      return (
        <div className={`fp-options-list${layout === 'horizontal' ? ' fp-options-horiz' : ''}`}>
          {opts.map((o) => (
            <label key={o.value} className="fp-checkbox-row">
              <input type="checkbox" readOnly tabIndex={-1} />
              <span>{o.label}</span>
            </label>
          ))}
        </div>
      );
    }

    case 'radio': {
      const opts = settings.options || [];
      const layout = settings.layout || 'vertical';
      return (
        <div className={`fp-options-list${layout === 'horizontal' ? ' fp-options-horiz' : ''}`}>
          {opts.map((o, i) => (
            <label key={o.value} className="fp-radio-row">
              <input type="radio" readOnly tabIndex={-1} defaultChecked={i === 0} />
              <span>{o.label}</span>
            </label>
          ))}
        </div>
      );
    }

    case 'dropdown':
      return fakeSelect(settings.options || [], settings.placeholder || 'Choose…');

    case 'toggle':
      return (
        <label className="fp-toggle-row">
          <div className="fp-toggle-track" style={{ background: accent }}>
            <div className="fp-toggle-thumb" />
          </div>
          <span>{settings.toggleLabel || 'Enable this option'}</span>
        </label>
      );

    case 'star_rating': {
      const max = settings.maxStars || 5;
      const def = settings.defaultRating || 0;
      return (
        <div className="fp-stars">
          {Array.from({ length: max }).map((_, i) => (
            <span key={i} className={`fp-star${i < def ? ' is-active' : ''}`} style={i < def ? { color: accent } : {}}>â˜…</span>
          ))}
        </div>
      );
    }

    case 'range_slider':
      return (
        <div className="fp-slider-wrap">
          <input type="range" className="fp-slider" min={settings.min ?? 0} max={settings.max ?? 100} defaultValue={settings.defaultValue ?? 50} readOnly tabIndex={-1} />
          {settings.showValue && (
            <span className="fp-slider-value">{settings.prefix || ''}{settings.defaultValue ?? 50}{settings.suffix || ''}</span>
          )}
        </div>
      );

    case 'likert': {
      const scale = settings.scale || [];
      return (
        <div className="fp-likert">
          {scale.map((s, i) => (
            <div key={s.value} className="fp-likert-item">
              <div className={`fp-likert-dot${i === 2 ? ' is-active' : ''}`} style={i === 2 ? { background: accent } : {}} />
              <span>{s.label}</span>
            </div>
          ))}
        </div>
      );
    }

    // â”€â”€ Personal Info â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    case 'full_name':
      return (
        <div className="fp-row">
          {settings.showPrefix && <input className="fp-input fp-input-xs" placeholder="Mr/Ms" readOnly tabIndex={-1} />}
          <input className="fp-input" placeholder="First name" readOnly tabIndex={-1} />
          {settings.showMiddle && <input className="fp-input fp-input-sm" placeholder="Middle" readOnly tabIndex={-1} />}
          <input className="fp-input" placeholder="Last name" readOnly tabIndex={-1} />
          {settings.showSuffix && <input className="fp-input fp-input-xs" placeholder="Jr./Sr." readOnly tabIndex={-1} />}
        </div>
      );

    case 'billing_address':
      return (
        <div className="fp-stack">
          <input className="fp-input" placeholder="Street address" readOnly tabIndex={-1} />
          {settings.showAddress2 && <input className="fp-input" placeholder="Apt, suite, unit…" readOnly tabIndex={-1} />}
          <div className="fp-row">
            <input className="fp-input" placeholder="City" readOnly tabIndex={-1} />
            {settings.showState !== false && <input className="fp-input fp-input-sm" placeholder="State" readOnly tabIndex={-1} />}
            <input className="fp-input fp-input-sm" placeholder="ZIP" readOnly tabIndex={-1} />
          </div>
          {settings.showCountry && fakeSelect([{ label: 'United States', value: 'US' }])}
        </div>
      );

    case 'country':
      return fakeSelect([{ label: 'United States', value: 'US' }, { label: 'Canada', value: 'CA' }]);

    case 'zip_code':
      return fakeInput(placeholder || 'Postal code');

    // â”€â”€ Advanced â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    case 'file_upload':
      return (
        <div className="fp-file-upload">
          <span className="fp-file-icon">📎</span>
          <span>Click to upload or drag &amp; drop</span>
          <span className="fp-file-hint">{settings.accept || 'Any file'} – max {settings.maxSizeMb || 10} MB</span>
        </div>
      );

    case 'signature':
      return (
        <div className="fp-signature" style={{ background: settings.bgColor || '#f8f6f2', height: settings.height || 120 }}>
          <span>Sign here</span>
        </div>
      );

    case 'terms_acceptance':
      return (
        <label className="fp-checkbox-row">
          <input type="checkbox" readOnly tabIndex={-1} />
          <span>
            {settings.text || 'I agree to the'}{' '}
            <span className="fp-terms-link" style={{ color: accent }}>{settings.linkText || 'Terms and Conditions'}</span>
          </span>
        </label>
      );

    // â”€â”€ Payment â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    case 'amount':
      return (
        <div className="fp-amount-row">
          <span className="fp-currency">{settings.currency === 'USD' ? '$' : settings.currency || '$'}</span>
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
      const opts = settings.options || [{ label: 'One-time', value: 'one_time' }, { label: 'Monthly', value: 'monthly' }];
      if ((settings.style || 'pills') === 'pills') {
        return <div className="fp-pills">{opts.map((o, i) => pill(o.label, i === 0))}</div>;
      }
      if (settings.style === 'dropdown') return fakeSelect(opts);
      return (
        <div className="fp-options-list">
          {opts.map((o, i) => (
            <label key={o.value} className="fp-radio-row">
              <input type="radio" readOnly tabIndex={-1} defaultChecked={i === 0} />
              <span>{o.label}</span>
            </label>
          ))}
        </div>
      );
    }

    case 'category': {
      const opts = settings.options || [];
      if (settings.inputMode === 'pills') return <div className="fp-pills">{opts.map((o) => pill(o.label, false))}</div>;
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
            <span>Fee: <strong>+${((100 * (settings.feePercent ?? 2.9)) / 100 + (settings.feeFixed ?? 0.3)).toFixed(2)}</strong></span>
          </div>
        </div>
      );

    case 'payment_method': {
      const opts = settings.options || ['card', 'ach'];
      const labels = { card: '💳 Card', ach: '🏦 ACH', apple_pay: ' Apple Pay', google_pay: '⬛ Google Pay' };
      return <div className="fp-pills">{opts.map((o, i) => pill(labels[o] || o, i === 0))}</div>;
    }

    case 'stripe_payment_element':
      return (
        <div className="fp-stripe-element">
          <div className="fp-stripe-tabs">
            {(settings.paymentMethods || ['card', 'us_bank_account']).map((m, i) => {
              const n = { card: 'Card', us_bank_account: 'Bank', link: 'Link' }[m] || m;
              return <span key={m} className={`fp-stripe-tab${i === 0 ? ' is-active' : ''}`} style={i === 0 ? { borderBottomColor: accent, color: accent } : {}}>{n}</span>;
            })}
          </div>
          <div className="fp-stack" style={{ marginTop: 8 }}>
            <input className="fp-input" placeholder="Card number" readOnly tabIndex={-1} />
            <div className="fp-row">
              <input className="fp-input" placeholder="MM / YY" readOnly tabIndex={-1} />
              <input className="fp-input fp-input-sm" placeholder="CVC" readOnly tabIndex={-1} />
            </div>
          </div>
          {settings.showSaveCard && (
            <label className="fp-checkbox-row" style={{ marginTop: 8 }}>
              <input type="checkbox" readOnly tabIndex={-1} />
              <span>Save this card for future gifts</span>
            </label>
          )}
        </div>
      );

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

    case 'order_summary':
      return (
        <div className="fp-order-summary">
          <div className="fp-order-row"><span>Amount</span><strong>$100.00</strong></div>
          {settings.showFee && <div className="fp-order-row"><span>Processing fee</span><strong>$3.20</strong></div>}
          {settings.showFrequency && <div className="fp-order-row"><span>Frequency</span><strong>One-time</strong></div>}
          {settings.showFund && <div className="fp-order-row"><span>Fund</span><strong>General Fund</strong></div>}
          <div className="fp-order-total"><span>Total</span><strong style={{ color: accent }}>$103.20</strong></div>
          <button className="fp-submit-btn" style={{ background: accent }}>{settings.submitLabel || 'Complete Donation'}</button>
        </div>
      );

    default:
      return <div className="fp-placeholder">{label || type}</div>;
  }
}
