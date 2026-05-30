import React, { useState, useEffect, useCallback, useRef } from 'react';
import { createPortal } from 'react-dom';
import { formatMoney } from '../utils';

// ─── Condition evaluator ───────────────────────────────────────────────────────

/**
 * Evaluate a single condition rule against the current form values.
 * Returns true if the condition passes.
 */
function evalCondition(cond, values) {
  if (!cond.fieldId) return true;
  const raw = values[cond.fieldId];
  const fieldVal = Array.isArray(raw) ? raw.join(',') : raw == null ? '' : String(raw);
  const compare = String(cond.value ?? '');

  switch (cond.operator) {
    case 'equals':
      return fieldVal === compare;
    case 'not_equals':
      return fieldVal !== compare;
    case 'contains':
      return fieldVal.toLowerCase().includes(compare.toLowerCase());
    case 'is_empty':
      return fieldVal.trim() === '';
    case 'is_not_empty':
      return fieldVal.trim() !== '';
    case 'greater_than':
      return parseFloat(fieldVal) > parseFloat(compare);
    case 'less_than':
      return parseFloat(fieldVal) < parseFloat(compare);
    default:
      return true;
  }
}

/**
 * Given a field and the current values, return { visible, required }.
 * Default assumption: field is visible unless any "hide" condition passes,
 * and not required-by-logic unless a "require" condition passes.
 */
function evalFieldVisibility(field, values) {
  const conditions = field.conditions || [];
  if (conditions.length === 0) return { visible: true, required: !!field.settings?.required };

  let visible = true;
  let required = !!field.settings?.required;

  for (const cond of conditions) {
    const passes = evalCondition(cond, values);
    if (passes) {
      if (cond.action === 'hide') visible = false;
      if (cond.action === 'show') visible = true;
      if (cond.action === 'require') required = true;
    }
  }

  return { visible, required };
}

// ─── Individual interactive field renderers ────────────────────────────────────

function PreviewField({
  field,
  value,
  onChange,
  accent,
  required,
  isPreview,
  allValues,
  onNext,
  isLast,
  nextLabel,
  submitLabel,
  validationMsg,
}) {
  const [specifyText, setSpecifyText] = useState('');
  const { type, label, placeholder, settings = {} } = field;
  const currency = settings.currency === 'USD' ? '$' : settings.currency || '$';

  // Helper shorthand
  const inp = (ph, inputType = 'text', extraProps = {}) => (
    <input
      className="pvw-input"
      type={inputType}
      placeholder={ph || label || ''}
      value={value ?? ''}
      onChange={(e) => onChange(e.target.value)}
      {...extraProps}
    />
  );

  switch (type) {
    // ── Content-only (read-only) ──────────────────────────────────────────────
    case 'heading': {
      const Tag = settings.level || 'h2';
      return (
        <Tag
          className={`pvw-heading pvw-heading-${Tag}`}
          style={{ textAlign: settings.align || 'left', color: settings.color || undefined }}
        >
          {settings.text || label}
        </Tag>
      );
    }

    case 'paragraph':
      return (
        <p className="pvw-paragraph" style={{ textAlign: settings.align || 'left' }}>
          {settings.text || 'Paragraph text…'}
        </p>
      );

    case 'image':
      return settings.src ? (
        <img
          src={settings.src}
          alt={settings.alt || ''}
          className="pvw-image"
          style={{ width: settings.width || '100%' }}
        />
      ) : (
        <div className="pvw-image-placeholder">
          <span>🖼</span>
        </div>
      );

    case 'divider':
      return <hr className="pvw-divider" style={{ borderColor: settings.color || '#e5e0da' }} />;

    case 'spacer':
      return <div style={{ height: settings.height ?? 24 }} />;

    case 'html_embed':
      return (
        <div
          className="pvw-html-embed"
          // eslint-disable-next-line react/no-danger
          dangerouslySetInnerHTML={{ __html: settings.html || '<p>Custom HTML block</p>' }}
        />
      );

    case 'section_header':
      return (
        <div className="pvw-section-header">
          <div className="pvw-section-title">{settings.title || 'Section Title'}</div>
          {settings.subtitle && <div className="pvw-section-subtitle">{settings.subtitle}</div>}
          {settings.showLine !== false && (
            <div className="pvw-section-line" style={{ background: accent }} />
          )}
        </div>
      );

    case 'hidden':
      // Hidden field — don't render anything visible
      return null;

    // ── Basic inputs ──────────────────────────────────────────────────────────
    case 'text':
    case 'url':
    case 'organization':
      return inp(placeholder || label);

    case 'number':
    case 'amount':
      return (
        <div className="pvw-amount-row">
          <span className="pvw-currency">{currency}</span>
          {inp(placeholder || '0.00', 'number')}
        </div>
      );

    case 'email':
      return inp(placeholder || 'you@example.com', 'email');

    case 'phone':
      return inp(placeholder || '(555) 555-5555', 'tel');

    case 'textarea':
      return (
        <textarea
          className="pvw-input pvw-textarea"
          placeholder={placeholder || label}
          value={value ?? ''}
          onChange={(e) => onChange(e.target.value)}
        />
      );

    case 'date':
    case 'date_of_birth':
      return inp(placeholder, 'date');

    case 'time':
      return inp(placeholder, 'time');

    case 'zip_code':
      return inp(placeholder || 'Postal code');

    case 'country': {
      const countries = [
        { label: 'United States', value: 'US' },
        { label: 'Canada', value: 'CA' },
        { label: 'United Kingdom', value: 'GB' },
      ];
      return (
        <select
          className="pvw-input"
          value={value ?? ''}
          onChange={(e) => onChange(e.target.value)}
        >
          <option value="">Select country…</option>
          {countries.map((c) => (
            <option key={c.value} value={c.value}>
              {c.label}
            </option>
          ))}
        </select>
      );
    }

    // ── Selection & choice ────────────────────────────────────────────────────
    case 'checkbox':
      return (
        <label className="pvw-checkbox-row">
          <input type="checkbox" checked={!!value} onChange={(e) => onChange(e.target.checked)} />
          <span>{settings.checkboxLabel || 'I agree'}</span>
        </label>
      );

    case 'toggle':
      return (
        <label className="pvw-toggle-row" onClick={() => onChange(!value)}>
          <div
            className={`pvw-toggle-track${value ? ' is-on' : ''}`}
            style={value ? { background: accent } : {}}
          >
            <div className="pvw-toggle-thumb" />
          </div>
          <span>{settings.toggleLabel || 'Enable this option'}</span>
        </label>
      );

    case 'terms_acceptance':
      return (
        <label className="pvw-checkbox-row">
          <input type="checkbox" checked={!!value} onChange={(e) => onChange(e.target.checked)} />
          <span>
            {settings.text || 'I agree to the'}{' '}
            <a
              href={settings.linkUrl || '#'}
              target="_blank"
              rel="noreferrer"
              style={{ color: accent }}
            >
              {settings.linkText || 'Terms and Conditions'}
            </a>
          </span>
        </label>
      );

    case 'checkbox_group': {
      const opts = settings.options || [];
      const selected = Array.isArray(value) ? value : [];
      const layout = settings.layout || 'vertical';
      return (
        <div className={`pvw-options-list${layout === 'horizontal' ? ' pvw-options-horiz' : ''}`}>
          {opts.map((o) => (
            <label key={o.value} className="pvw-checkbox-row">
              <input
                type="checkbox"
                checked={selected.includes(o.value)}
                onChange={(e) => {
                  const next = e.target.checked
                    ? [...selected, o.value]
                    : selected.filter((v) => v !== o.value);
                  onChange(next);
                }}
              />
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
        <div className={`pvw-options-list${layout === 'horizontal' ? ' pvw-options-horiz' : ''}`}>
          {opts.map((o) => (
            <label key={o.value} className="pvw-radio-row">
              <input
                type="radio"
                name={`pvw-radio-${field.id}`}
                value={o.value}
                checked={value === o.value}
                onChange={() => onChange(o.value)}
              />
              <span>{o.label}</span>
            </label>
          ))}
        </div>
      );
    }

    case 'dropdown': {
      const opts = settings.options || [];
      const isOtherSpec =
        typeof value === 'string' &&
        value.toLowerCase().includes('other') &&
        value.toLowerCase().includes('specify');
      return (
        <div>
          <select
            className="pvw-input"
            value={value ?? ''}
            onChange={(e) => onChange(e.target.value)}
          >
            <option value="">{settings.placeholder || 'Choose…'}</option>
            {opts.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
          {isOtherSpec && (
            <input
              className="pvw-input"
              style={{ marginTop: 8 }}
              type="text"
              placeholder="Specify"
              value={specifyText}
              onChange={(e) => setSpecifyText(e.target.value)}
            />
          )}
        </div>
      );
    }

    case 'category': {
      const opts = settings.options || [];
      if (settings.inputMode === 'pills') {
        return (
          <div className="pvw-pills">
            {opts.map((o) => (
              <button
                key={o.value}
                type="button"
                className={`pvw-pill${value === o.value ? ' is-active' : ''}`}
                style={value === o.value ? { background: accent, borderColor: accent } : {}}
                onClick={() => onChange(value === o.value ? '' : o.value)}
              >
                {o.label}
              </button>
            ))}
          </div>
        );
      }
      return (
        <select
          className="pvw-input"
          value={value ?? ''}
          onChange={(e) => onChange(e.target.value)}
        >
          <option value="">Select…</option>
          {opts.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      );
    }

    case 'star_rating': {
      const max = settings.maxStars || 5;
      const cur = value ?? 0;
      return (
        <div className="pvw-stars">
          {Array.from({ length: max }).map((_, i) => (
            <button
              key={i}
              type="button"
              className={`pvw-star${i < cur ? ' is-active' : ''}`}
              style={i < cur ? { color: accent } : {}}
              onClick={() => onChange(i + 1)}
            >
              ★
            </button>
          ))}
        </div>
      );
    }

    case 'range_slider': {
      const min = settings.min ?? 0;
      const max = settings.max ?? 100;
      const cur = value ?? settings.defaultValue ?? 50;
      return (
        <div className="pvw-slider-wrap">
          <input
            type="range"
            className="pvw-slider"
            min={min}
            max={max}
            step={settings.step ?? 1}
            value={cur}
            onChange={(e) => onChange(Number(e.target.value))}
            style={{ '--accent': accent }}
          />
          <span className="pvw-slider-value">
            {settings.prefix || ''}
            {cur}
            {settings.suffix || ''}
          </span>
        </div>
      );
    }

    case 'likert': {
      const scale = settings.scale || [];
      const cur = value ?? null;
      return (
        <div className="pvw-likert">
          {scale.map((s) => (
            <button
              key={s.value}
              type="button"
              className={`pvw-likert-item${cur === s.value ? ' is-active' : ''}`}
              style={
                cur === s.value ? { background: accent, color: '#fff', borderColor: accent } : {}
              }
              onClick={() => onChange(s.value)}
            >
              <div className="pvw-likert-dot" />
              <span>{s.label}</span>
            </button>
          ))}
        </div>
      );
    }

    // ── Donor type toggle ─────────────────────────────────────────────────────
    case 'donor_type': {
      const opts = settings.options || [
        { value: 'individual', label: 'Individual' },
        { value: 'organization', label: 'Organization' },
      ];
      const cur = value ?? 'individual';
      return (
        <div className="pvw-pills pvw-freq-row">
          {opts.map((o) => (
            <button
              key={o.value}
              type="button"
              className={`pvw-pill pvw-freq-pill${cur === o.value ? ' is-active' : ''}`}
              style={cur === o.value ? { background: accent, borderColor: accent } : {}}
              onClick={() => onChange(o.value)}
            >
              {o.label}
            </button>
          ))}
        </div>
      );
    }

    // ── Personal info ─────────────────────────────────────────────────────────
    case 'full_name': {
      const obj = value && typeof value === 'object' ? value : {};
      const set = (k, v) => onChange({ ...obj, [k]: v });
      return (
        <div className="pvw-name-row">
          {settings.showPrefix && (
            <input
              className="pvw-input pvw-input-xs"
              placeholder="Mr/Ms"
              value={obj.prefix ?? ''}
              onChange={(e) => set('prefix', e.target.value)}
            />
          )}
          <input
            className="pvw-input"
            placeholder="First name"
            value={obj.first ?? ''}
            onChange={(e) => set('first', e.target.value)}
          />
          {settings.showMiddle && (
            <input
              className="pvw-input pvw-input-sm"
              placeholder="Middle"
              value={obj.middle ?? ''}
              onChange={(e) => set('middle', e.target.value)}
            />
          )}
          <input
            className="pvw-input"
            placeholder="Last name"
            value={obj.last ?? ''}
            onChange={(e) => set('last', e.target.value)}
          />
          {settings.showSuffix && (
            <input
              className="pvw-input pvw-input-xs"
              placeholder="Jr./Sr."
              value={obj.suffix ?? ''}
              onChange={(e) => set('suffix', e.target.value)}
            />
          )}
        </div>
      );
    }

    case 'billing_address': {
      const obj = value && typeof value === 'object' ? value : {};
      const set = (k, v) => onChange({ ...obj, [k]: v });
      return (
        <div className="pvw-stack">
          <input
            className="pvw-input"
            placeholder="Street address"
            value={obj.line1 ?? ''}
            onChange={(e) => set('line1', e.target.value)}
          />
          {settings.showAddress2 && (
            <input
              className="pvw-input"
              placeholder="Apt, suite, unit…"
              value={obj.line2 ?? ''}
              onChange={(e) => set('line2', e.target.value)}
            />
          )}
          <div className="pvw-city-row">
            <input
              className="pvw-input"
              placeholder="City"
              value={obj.city ?? ''}
              onChange={(e) => set('city', e.target.value)}
            />
            {settings.showState !== false && (
              <input
                className="pvw-input pvw-input-sm"
                placeholder="State"
                value={obj.state ?? ''}
                onChange={(e) => set('state', e.target.value)}
              />
            )}
            <input
              className="pvw-input pvw-input-sm"
              placeholder="ZIP"
              value={obj.zip ?? ''}
              onChange={(e) => set('zip', e.target.value)}
            />
          </div>
          {settings.showCountry && (
            <select
              className="pvw-input"
              value={obj.country ?? ''}
              onChange={(e) => set('country', e.target.value)}
            >
              <option value="">Country…</option>
              <option value="US">United States</option>
              <option value="CA">Canada</option>
            </select>
          )}
        </div>
      );
    }

    // ── Amount / donation ─────────────────────────────────────────────────────
    case 'amount_pills': {
      const presets = settings.presets || [25, 50, 100, 250];
      const customLabel = settings.presetLabel || 'Other';
      const allBtns = [...presets, ...(settings.allowCustom ? [customLabel] : [])];
      // Split into rows of 3  matching the real form layout
      const rowSize = 3;
      const btnRows = [];
      for (let i = 0; i < allBtns.length; i += rowSize) btnRows.push(allBtns.slice(i, i + rowSize));
      const custom =
        value != null &&
        value !== '' &&
        (value === '__other__' || !presets.includes(Number(value)));
      return (
        <div className="pvw-pills-stack">
          {btnRows.map((rowItems, ri) => (
            <div key={ri} className="pvw-pills pvw-pills-row">
              {rowItems.map((item) => {
                const isCustomBtn = item === customLabel;
                const isActive = isCustomBtn ? custom : value === item;
                return (
                  <button
                    key={String(item)}
                    type="button"
                    className={`pvw-pill pvw-amount-pill${isActive ? ' is-active' : ''}`}
                    style={isActive ? { background: accent, borderColor: accent } : {}}
                    onClick={() => onChange(isCustomBtn ? '__other__' : item)}
                  >
                    {isCustomBtn ? customLabel : formatMoney(item, settings.currency)}
                  </button>
                );
              })}
            </div>
          ))}
          {settings.allowCustom && custom && (
            <div className="pvw-amount-row" style={{ marginTop: 8 }}>
              <span className="pvw-currency">{currency}</span>
              <input
                className="pvw-input"
                type="number"
                placeholder="Enter custom amount"
                value={value === '__other__' ? '' : (value ?? '')}
                onChange={(e) =>
                  onChange(e.target.value === '' ? '__other__' : Number(e.target.value))
                }
                autoFocus
              />
            </div>
          )}
        </div>
      );
    }

    case 'donation_frequency': {
      const opts = settings.options || [
        { label: 'One-time', value: 'one_time' },
        { label: 'Monthly', value: 'monthly' },
      ];
      const style = settings.style || 'pills';
      // Normalize value to object form { mode, period }
      const freq = !value
        ? { mode: opts[0]?.value || 'one_time' }
        : typeof value === 'string'
          ? { mode: value }
          : value;
      const isRecurring = freq.mode === 'recurring';
      const periods = [
        { value: 'year', label: 'Yearly' },
        { value: 'month', label: 'Monthly' },
        { value: 'biweek', label: 'Bi-Weekly' },
        { value: 'week', label: 'Weekly' },
      ];
      const periodIdx = isRecurring
        ? periods.findIndex((p) => p.value === (freq.period || 'month'))
        : 1;
      const safePeriodIdx = periodIdx < 0 ? 1 : periodIdx;
      if (style === 'pills') {
        return (
          <div>
            <div className="pvw-pills pvw-freq-row">
              {opts.map((o) => (
                <button
                  key={o.value}
                  type="button"
                  className={`pvw-pill pvw-freq-pill${freq.mode === o.value ? ' is-active' : ''}`}
                  style={freq.mode === o.value ? { background: accent, borderColor: accent } : {}}
                  onClick={() => {
                    if (o.value === 'recurring')
                      onChange({ mode: 'recurring', period: freq.period || 'month' });
                    else onChange({ mode: o.value });
                  }}
                >
                  {o.label}
                </button>
              ))}
            </div>
            {isRecurring && (
              <div className="pvw-recurring-stepper">
                <button
                  type="button"
                  className="pvw-stepper-btn"
                  style={{ color: accent, borderColor: accent }}
                  disabled={safePeriodIdx === 0}
                  onClick={() =>
                    onChange({ mode: 'recurring', period: periods[safePeriodIdx - 1].value })
                  }
                >
                  −
                </button>
                <span className="pvw-stepper-display">{periods[safePeriodIdx].label}</span>
                <button
                  type="button"
                  className="pvw-stepper-btn"
                  style={{ color: accent, borderColor: accent }}
                  disabled={safePeriodIdx === periods.length - 1}
                  onClick={() =>
                    onChange({ mode: 'recurring', period: periods[safePeriodIdx + 1].value })
                  }
                >
                  +
                </button>
              </div>
            )}
          </div>
        );
      }
      if (style === 'dropdown') {
        return (
          <select
            className="pvw-input"
            value={freq.mode}
            onChange={(e) => onChange({ mode: e.target.value })}
          >
            {opts.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        );
      }
      return (
        <div className="pvw-options-list">
          {opts.map((o) => (
            <label key={o.value} className="pvw-radio-row">
              <input
                type="radio"
                name={`pvw-freq-${field.id}`}
                value={o.value}
                checked={freq.mode === o.value}
                onChange={() => onChange({ mode: o.value })}
              />
              <span>{o.label}</span>
            </label>
          ))}
        </div>
      );
    }

    case 'cover_fee': {
      const checked = value != null ? !!value : !!settings.defaultChecked;
      const base = 100; // demo amount
      const fee = (
        (base * (settings.feePercent ?? 2.9)) / 100 +
        (settings.feeFixed ?? 0.3)
      ).toFixed(2);
      return (
        <div className="pvw-cover-fee">
          <label className="pvw-checkbox-row">
            <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
            <span>
              Cover the {settings.feePercent ?? 2.9}% + ${(settings.feeFixed ?? 0.3).toFixed(2)}{' '}
              processing fee
            </span>
          </label>
          <div className="pvw-fee-breakdown">
            <span>
              Base: <strong>$100.00</strong>
            </span>
            <span>
              Fee: <strong>+${fee}</strong>
            </span>
          </div>
        </div>
      );
    }

    case 'payment_method': {
      const opts = settings.options || ['card', 'ach'];
      const labels = {
        card: '💳 Card',
        ach: '🏦 ACH',
        apple_pay: ' Apple Pay',
        google_pay: '⬛ Google Pay',
      };
      const cur = value ?? opts[0] ?? 'card';
      return (
        <div className="pvw-pills">
          {opts.map((o) => (
            <button
              key={o}
              type="button"
              className={`pvw-pill${cur === o ? ' is-active' : ''}`}
              style={cur === o ? { background: accent, borderColor: accent } : {}}
              onClick={() => onChange(o)}
            >
              {labels[o] || o}
            </button>
          ))}
        </div>
      );
    }

    case 'stripe_payment_element':
      return (
        <div className="pvw-stripe-element">
          <div className="pvw-stripe-tabs">
            {(settings.paymentMethods || ['card', 'us_bank_account']).map((m, i) => {
              const n = { card: 'Card', us_bank_account: 'Bank', link: 'Link' }[m] || m;
              return (
                <span
                  key={m}
                  className={`pvw-stripe-tab${i === 0 ? ' is-active' : ''}`}
                  style={i === 0 ? { borderBottomColor: accent, color: accent } : {}}
                >
                  {n}
                </span>
              );
            })}
          </div>
          <div className="pvw-stripe-demo">
            <div className="pvw-stripe-notice">🔒 Stripe payment element (live only)</div>
          </div>
        </div>
      );

    case 'card_input':
    case 'ach_input':
    case 'file_upload':
    case 'signature':
      return (
        <div className="pvw-demo-notice">
          <span>{label || type}</span>
          <span className="pvw-demo-badge">Live only</span>
        </div>
      );

    case 'order_summary': {
      let total = 0;
      let recurringPeriod = null;
      if (allValues) {
        for (const v of Object.values(allValues)) {
          if (v && typeof v === 'object' && !Array.isArray(v) && v.mode === 'recurring') {
            recurringPeriod = v.period || 'month';
          }
          const n = typeof v === 'number' ? v : typeof v === 'string' ? parseFloat(v) : NaN;
          if (!isNaN(n) && n > 0 && total === 0) total = n;
        }
      }
      const periodMap = {
        year: 'every year',
        month: 'every month',
        biweek: 'every 2 weeks',
        week: 'every week',
      };
      const periodText = recurringPeriod ? ` ${periodMap[recurringPeriod] || ''}` : '';
      const formatted = new Intl.NumberFormat('en-US', {
        style: 'currency',
        currency: 'USD',
      }).format(total);
      return (
        <>
          {validationMsg && <div className="pvw-validation-msg">{validationMsg}</div>}
          <div className="pvw-order-summary">
            <div className="pvw-total-amount">
              Total: {formatted}
              {periodText}
            </div>
            {onNext && (
              <button
                type="button"
                className="pvw-next-btn pvw-next-inline"
                style={{ background: accent }}
                onClick={onNext}
              >
                {isLast ? submitLabel : nextLabel}
              </button>
            )}
          </div>
        </>
      );
    }

    default:
      return inp(placeholder || label || type);
  }
}

// ─── Page renderer ─────────────────────────────────────────────────────────────

function PreviewPage({
  page,
  values,
  setValues,
  accent,
  onNext,
  isLast,
  nextLabel,
  submitLabel,
  validationMsg,
}) {
  return (
    <div className="pvw-page-body">
      {page?.rows?.map((row) => (
        <div
          key={row.id}
          className="pvw-row"
          style={{ gridTemplateColumns: `repeat(12, minmax(0, 1fr))` }}
        >
          {(row.columns || []).map((col) => {
            if (!col.field) return null;
            const field = col.field;
            const { visible, required } = evalFieldVisibility(field, values);
            if (!visible) return null;
            const span = typeof col.width === 'number' && col.width > 0 ? col.width : 12;
            const isContentOnly = [
              'heading',
              'paragraph',
              'image',
              'divider',
              'spacer',
              'html_embed',
              'section_header',
              'hidden',
              'order_summary',
              'donor_type',
            ].includes(field.type);
            return (
              <div key={col.id} className="pvw-col" style={{ gridColumn: `span ${span}` }}>
                {!isContentOnly && (
                  <label className="pvw-field-label">
                    {field.label || field.type}
                    {required && <span className="pvw-required"> *</span>}
                  </label>
                )}
                <PreviewField
                  field={field}
                  value={values[field.id]}
                  onChange={(v) => setValues((prev) => ({ ...prev, [field.id]: v }))}
                  accent={accent}
                  required={required}
                  allValues={values}
                  onNext={field.type === 'order_summary' ? onNext : undefined}
                  isLast={isLast}
                  nextLabel={nextLabel}
                  submitLabel={submitLabel}
                  validationMsg={field.type === 'order_summary' ? validationMsg : undefined}
                />
                {field.settings?.hint && (
                  <div className="pvw-field-hint">{field.settings.hint}</div>
                )}
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}

// ─── Progress bar ──────────────────────────────────────────────────────────────

function ProgressBar({ current, total, accent }) {
  if (total <= 1) return null;
  const pct = Math.round(((current + 1) / total) * 100);
  return (
    <div className="pvw-progress-wrap">
      <div className="pvw-progress-bar" style={{ width: `${pct}%`, background: accent }} />
    </div>
  );
}

// ─── Form card ─────────────────────────────────────────────────────────────────

function PreviewFormCard({ state, onClose }) {
  const accent = state.branding?.accentColor || '#bd2135';
  const title = state.branding?.title || 'Support Our Mission';
  const subtitle = state.branding?.subtitle || 'Your gift makes a difference.';
  const logoUrl = state.branding?.logoUrl || '';
  const pages = state.pages || [];

  const [pageIdx, setPageIdx] = useState(0);
  const [values, setValues] = useState({});
  const [submitted, setSubmitted] = useState(false);
  const [validationMsg, setValidationMsg] = useState(null);

  const currentPage = pages[pageIdx];
  const isFirst = pageIdx === 0;
  const isLast = pageIdx === pages.length - 1;

  const prevLabel = currentPage?.prevLabel || 'Back';
  const nextLabel = currentPage?.nextLabel || 'Continue';
  const submitLabel = pages[pages.length - 1]?.nextLabel || 'Complete Donation';
  const showProgress = currentPage?.showProgress !== false && pages.length > 1;

  const hasOrderSummary = currentPage?.rows?.some((row) =>
    row.columns?.some((col) => col.field?.type === 'order_summary')
  );

  const handleNext = () => {
    let errorMsg = null;
    for (const row of currentPage?.rows || []) {
      for (const col of row.columns || []) {
        const f = col.field;
        if (f?.type === 'amount_pills') {
          const v = values[f.id];
          if (v == null || v === '' || v === '__other__') {
            errorMsg = 'Please select a donation amount.';
          }
        }
      }
    }
    if (errorMsg) {
      setValidationMsg(errorMsg);
      return;
    }
    setValidationMsg(null);
    if (isLast) setSubmitted(true);
    else setPageIdx((i) => i + 1);
  };

  if (submitted) {
    const msg =
      state.confirmationPage?.message ||
      'Thank you for your generous gift! You will receive a confirmation email shortly.';
    return (
      <div className="pvw-card">
        {onClose && (
          <button className="pvw-modal-close" type="button" onClick={onClose}>
            ✕
          </button>
        )}
        <div className="pvw-card-header" style={{ borderBottomColor: `${accent}33` }}>
          {logoUrl ? (
            <img src={logoUrl} alt="logo" className="pvw-logo" />
          ) : (
            <div className="pvw-logo-fallback" />
          )}
          <div>
            <div className="pvw-card-title">{title}</div>
            <div className="pvw-card-subtitle">{subtitle}</div>
          </div>
        </div>
        <div className="pvw-confirmation">
          <div className="pvw-confirmation-icon" style={{ color: accent }}>
            ✓
          </div>
          <p className="pvw-confirmation-message">{msg}</p>
          <button
            className="pvw-next-btn"
            style={{ background: accent }}
            type="button"
            onClick={() => {
              setPageIdx(0);
              setValues({});
              setSubmitted(false);
            }}
          >
            Fill out again (preview)
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="pvw-card">
      {/* Compact header: logo centered, thick brand-color bottom border — matching real form header */}
      <div
        className="pvw-card-header pvw-card-header-compact"
        style={{ borderBottomColor: accent }}
      >
        {!isFirst && (
          <button
            type="button"
            className="pvw-back-btn pvw-back-btn-header"
            onClick={() => setPageIdx((i) => i - 1)}
          >
            ←
          </button>
        )}
        {logoUrl ? (
          <img src={logoUrl} alt="logo" className="pvw-logo" />
        ) : (
          <div className="pvw-logo-fallback" />
        )}
        {onClose && (
          <button className="pvw-modal-close" type="button" onClick={onClose}>
            ✕
          </button>
        )}
      </div>

      {/* Step dots */}
      {pages.length > 1 && (
        <div className="pvw-page-indicator">
          {pages.map((p, i) => (
            <span
              key={p.id}
              className={`pvw-page-dot${i === pageIdx ? ' is-active' : ''}${i < pageIdx ? ' is-done' : ''}`}
              style={
                i === pageIdx ? { background: accent } : i < pageIdx ? { background: '#000' } : {}
              }
              title={p.name}
            />
          ))}
        </div>
      )}

      {/* Page title inside body, matching "dp-title" style on the real form */}
      {currentPage?.name && <div className="pvw-page-title">{currentPage.name}</div>}

      <PreviewPage
        page={currentPage}
        values={values}
        setValues={setValues}
        accent={accent}
        onNext={handleNext}
        isLast={isLast}
        nextLabel={nextLabel}
        submitLabel={submitLabel}
        validationMsg={validationMsg}
      />

      {!hasOrderSummary && (
        <div className="pvw-card-footer">
          <button
            type="button"
            className="pvw-next-btn"
            style={{ background: accent }}
            onClick={handleNext}
          >
            {isLast ? submitLabel : nextLabel}
          </button>
        </div>
      )}
    </div>
  );
}

// ─── Exported component ────────────────────────────────────────────────────────

export default function InteractivePreview({ state }) {
  const [mode, setMode] = useState(state.display?.mode || 'embedded');
  const [modalOpen, setModalOpen] = useState(false);
  const accent = state.branding?.accentColor || '#bd2135';

  // Reset modal on mode switch
  useEffect(() => {
    setModalOpen(false);
  }, [mode]);

  // Lock body scroll when modal is open
  useEffect(() => {
    if (modalOpen) document.body.style.overflow = 'hidden';
    else document.body.style.overflow = '';
    return () => {
      document.body.style.overflow = '';
    };
  }, [modalOpen]);

  const modalPortal =
    modalOpen &&
    createPortal(
      <div
        className="pvw-modal-overlay"
        onClick={(e) => {
          if (e.target === e.currentTarget) setModalOpen(false);
        }}
      >
        <div className="pvw-modal-inner">
          <PreviewFormCard state={state} onClose={() => setModalOpen(false)} />
        </div>
      </div>,
      document.body
    );

  return (
    <div className="pvw-root">
      {/* Mode toggle */}
      <div className="pvw-mode-toggle">
        <button
          type="button"
          className={`pvw-mode-btn${mode === 'embedded' ? ' is-active' : ''}`}
          style={mode === 'embedded' ? { '--accent': accent } : {}}
          onClick={() => setMode('embedded')}
        >
          Embedded
        </button>
        <button
          type="button"
          className={`pvw-mode-btn${mode === 'modal' ? ' is-active' : ''}`}
          style={mode === 'modal' ? { '--accent': accent } : {}}
          onClick={() => setMode('modal')}
        >
          Modal Pop-up
        </button>
      </div>

      {/* Fake site chrome */}
      <div className="pvw-site-wrap">
        <div className="pvw-site-chrome">
          <span className="pvw-site-brand">Sample Site</span>
          <button
            type="button"
            className="pvw-site-donate"
            style={{ background: accent }}
            onClick={() => {
              if (mode === 'modal') setModalOpen(true);
            }}
            title={mode === 'modal' ? 'Click to open the form' : undefined}
          >
            Donate
          </button>
        </div>
        <div className="pvw-site-content">
          <strong>Support our mission</strong>
          <span>Preview your form exactly as donors will see it.</span>
        </div>

        {mode === 'embedded' && (
          <div className="pvw-embedded-wrap">
            <PreviewFormCard state={state} />
          </div>
        )}

        {mode === 'modal' && !modalOpen && (
          <div className="pvw-modal-hint">
            Click <strong>Donate</strong> above to open the form preview.
          </div>
        )}
      </div>

      {modalPortal}
    </div>
  );
}
