import React, { useState } from 'react';
import { getFieldMeta } from '../fieldTypes';
import FieldPreview from './FieldPreview';

// ─── Generic form helpers ─────────────────────────────────────────────────────

function Field({ label, children }) {
  return (
    <div className="insp-field">
      <label className="insp-label">{label}</label>
      {children}
    </div>
  );
}

function TextInput({ value, onChange, placeholder }) {
  return (
    <input
      className="insp-input"
      value={value ?? ''}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder || ''}
    />
  );
}

function Toggle({ label, checked, onChange }) {
  return (
    <label className="insp-toggle-row">
      <span>{label}</span>
      <input type="checkbox" checked={!!checked} onChange={(e) => onChange(e.target.checked)} />
    </label>
  );
}

function NumberInput({ value, onChange, min, max, step = 1 }) {
  return (
    <input
      className="insp-input"
      type="number"
      value={value ?? ''}
      onChange={(e) => onChange(e.target.value === '' ? null : Number(e.target.value))}
      min={min}
      max={max}
      step={step}
    />
  );
}

// ─── Field-type-specific settings ─────────────────────────────────────────────

function AmountPillsSettings({ settings, onSettingChange }) {
  const [newPreset, setNewPreset] = useState('');
  const presets = settings.presets || [];

  function addPreset() {
    const v = Number(newPreset);
    if (!v || presets.includes(v)) return;
    onSettingChange({ presets: [...presets, v].sort((a, b) => a - b) });
    setNewPreset('');
  }

  function removePreset(v) {
    onSettingChange({ presets: presets.filter((p) => p !== v) });
  }

  return (
    <>
      <Field label="Currency">
        <select
          className="insp-input"
          value={settings.currency || 'USD'}
          onChange={(e) => onSettingChange({ currency: e.target.value })}
        >
          <option value="USD">USD ($)</option>
          <option value="CAD">CAD (C$)</option>
          <option value="EUR">EUR (€)</option>
          <option value="GBP">GBP (£)</option>
        </select>
      </Field>
      <Field label="Preset Amounts">
        <div className="insp-tags">
          {presets.map((p) => (
            <span key={p} className="insp-tag">
              ${p}
              <button onClick={() => removePreset(p)}>✕</button>
            </span>
          ))}
        </div>
        <div className="insp-row">
          <input
            className="insp-input"
            type="number"
            placeholder="Add amount…"
            value={newPreset}
            onChange={(e) => setNewPreset(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && addPreset()}
          />
          <button className="insp-btn-sm" onClick={addPreset}>
            Add
          </button>
        </div>
      </Field>
      <Toggle
        label="Allow custom amount"
        checked={settings.allowCustom}
        onChange={(v) => onSettingChange({ allowCustom: v })}
      />
    </>
  );
}

function CategorySettings({ settings, onSettingChange }) {
  const opts = settings.options || [];

  function updateOption(idx, key, value) {
    const newOpts = opts.map((o, i) => (i === idx ? { ...o, [key]: value } : o));
    onSettingChange({ options: newOpts });
  }

  function addOption() {
    onSettingChange({
      options: [...opts, { label: 'New Option', value: `opt_${opts.length + 1}` }],
    });
  }

  function removeOption(idx) {
    onSettingChange({ options: opts.filter((_, i) => i !== idx) });
  }

  return (
    <>
      <Field label="Input Style">
        <select
          className="insp-input"
          value={settings.inputMode || 'dropdown'}
          onChange={(e) => onSettingChange({ inputMode: e.target.value })}
        >
          <option value="dropdown">Dropdown</option>
          <option value="pills">Pills</option>
        </select>
      </Field>
      <Field label="Options">
        {opts.map((opt, idx) => (
          <div key={idx} className="insp-row insp-option-row">
            <input
              className="insp-input"
              value={opt.label}
              onChange={(e) => updateOption(idx, 'label', e.target.value)}
              placeholder="Label"
            />
            <input
              className="insp-input"
              value={opt.value}
              onChange={(e) => updateOption(idx, 'value', e.target.value)}
              placeholder="Value"
            />
            <button className="insp-btn-danger-sm" onClick={() => removeOption(idx)}>
              ✕
            </button>
          </div>
        ))}
        <button className="insp-btn-sm" onClick={addOption}>
          + Add Option
        </button>
      </Field>
    </>
  );
}

function FrequencySettings({ settings, onSettingChange }) {
  const opts = settings.options || [];

  function updateOption(idx, key, value) {
    const newOpts = opts.map((o, i) => (i === idx ? { ...o, [key]: value } : o));
    onSettingChange({ options: newOpts });
  }

  function addOption() {
    onSettingChange({ options: [...opts, { label: 'New', value: `freq_${opts.length + 1}` }] });
  }

  function removeOption(idx) {
    onSettingChange({ options: opts.filter((_, i) => i !== idx) });
  }

  return (
    <>
      <Field label="Default">
        <select
          className="insp-input"
          value={settings.defaultValue || ''}
          onChange={(e) => onSettingChange({ defaultValue: e.target.value })}
        >
          {opts.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Options">
        {opts.map((opt, idx) => (
          <div key={idx} className="insp-row insp-option-row">
            <input
              className="insp-input"
              value={opt.label}
              onChange={(e) => updateOption(idx, 'label', e.target.value)}
              placeholder="Label"
            />
            <input
              className="insp-input"
              value={opt.value}
              onChange={(e) => updateOption(idx, 'value', e.target.value)}
              placeholder="Value"
            />
            <button className="insp-btn-danger-sm" onClick={() => removeOption(idx)}>
              ✕
            </button>
          </div>
        ))}
        <button className="insp-btn-sm" onClick={addOption}>
          + Add Option
        </button>
      </Field>
    </>
  );
}

function CoverFeeSettings({ settings, onSettingChange }) {
  return (
    <>
      <Field label="Fee Percentage (%)">
        <NumberInput
          value={settings.feePercent}
          onChange={(v) => onSettingChange({ feePercent: v })}
          min={0}
          max={100}
          step={0.1}
        />
      </Field>
      <Field label="Fixed Fee ($)">
        <NumberInput
          value={settings.feeFixed}
          onChange={(v) => onSettingChange({ feeFixed: v })}
          min={0}
          step={0.01}
        />
      </Field>
      <Toggle
        label="Checked by default"
        checked={settings.defaultChecked}
        onChange={(v) => onSettingChange({ defaultChecked: v })}
      />
    </>
  );
}

function PaymentMethodSettings({ settings, onSettingChange }) {
  const allMethods = [
    { value: 'card', label: '💳 Card' },
    { value: 'ach', label: '🏦 ACH' },
    { value: 'apple_pay', label: ' Apple Pay' },
    { value: 'google_pay', label: '⬛ Google Pay' },
  ];
  const selected = settings.options || ['card'];

  function toggle(v) {
    const newOpts = selected.includes(v) ? selected.filter((o) => o !== v) : [...selected, v];
    if (newOpts.length === 0) return;
    onSettingChange({ options: newOpts });
  }

  return (
    <>
      <Field label="Available Methods">
        {allMethods.map((m) => (
          <Toggle
            key={m.value}
            label={m.label}
            checked={selected.includes(m.value)}
            onChange={() => toggle(m.value)}
          />
        ))}
      </Field>
    </>
  );
}

function AmountSettings({ settings, onSettingChange }) {
  return (
    <>
      <Field label="Currency">
        <select
          className="insp-input"
          value={settings.currency || 'USD'}
          onChange={(e) => onSettingChange({ currency: e.target.value })}
        >
          <option value="USD">USD</option>
          <option value="CAD">CAD</option>
          <option value="EUR">EUR</option>
          <option value="GBP">GBP</option>
        </select>
      </Field>
      <Field label="Fixed Amount (leave blank for user input)">
        <NumberInput
          value={settings.fixedAmount}
          onChange={(v) => onSettingChange({ fixedAmount: v })}
          min={0}
          step={0.01}
        />
      </Field>
      <Field label="Minimum ($)">
        <NumberInput
          value={settings.min}
          onChange={(v) => onSettingChange({ min: v })}
          min={0}
          step={1}
        />
      </Field>
      <Field label="Maximum ($)">
        <NumberInput
          value={settings.max}
          onChange={(v) => onSettingChange({ max: v })}
          min={0}
          step={1}
        />
      </Field>
    </>
  );
}

// ─── Field inspector ──────────────────────────────────────────────────────────

function FieldInspector({ field, pageIdx, dispatch }) {
  const meta = getFieldMeta(field.type);

  function update(updates) {
    dispatch({ type: 'UPDATE_FIELD', payload: { fieldId: field.id, updates } });
  }

  function onSettingChange(settings) {
    update({ settings });
  }

  const hasPlaceholder = [
    'text',
    'email',
    'phone',
    'textarea',
    'number',
    'zip_code',
    'amount',
  ].includes(field.type);
  const hasRequired = !['cover_fee', 'card_input', 'ach_input', 'billing_address'].includes(
    field.type
  );

  return (
    <div className="insp-section">
      <div className="insp-field-header">
        <span className="insp-field-icon">{meta.icon}</span>
        <span className="insp-field-type">{meta.label}</span>
      </div>

      <Field label="Label">
        <TextInput
          value={field.label}
          onChange={(v) => update({ label: v })}
          placeholder="Field label"
        />
      </Field>

      {hasPlaceholder && (
        <Field label="Placeholder">
          <TextInput
            value={field.placeholder}
            onChange={(v) => update({ placeholder: v })}
            placeholder="Placeholder text…"
          />
        </Field>
      )}

      {hasRequired && (
        <Toggle
          label="Required"
          checked={field.required}
          onChange={(v) => update({ required: v })}
        />
      )}

      <Toggle
        label="Visible"
        checked={field.enabled !== false}
        onChange={(v) => update({ enabled: v })}
      />

      {/* Type-specific settings */}
      {field.type === 'amount_pills' && (
        <AmountPillsSettings settings={field.settings} onSettingChange={onSettingChange} />
      )}
      {field.type === 'amount' && (
        <AmountSettings settings={field.settings} onSettingChange={onSettingChange} />
      )}
      {field.type === 'category' && (
        <CategorySettings settings={field.settings} onSettingChange={onSettingChange} />
      )}
      {field.type === 'donation_frequency' && (
        <FrequencySettings settings={field.settings} onSettingChange={onSettingChange} />
      )}
      {field.type === 'cover_fee' && (
        <CoverFeeSettings settings={field.settings} onSettingChange={onSettingChange} />
      )}
      {field.type === 'payment_method' && (
        <PaymentMethodSettings settings={field.settings} onSettingChange={onSettingChange} />
      )}
      {field.type === 'checkout' && (
        <Toggle
          label="Show middle name"
          checked={field.settings?.showMiddle}
          onChange={(v) => onSettingChange({ showMiddle: v })}
        />
      )}
      {field.type === 'full_name' && (
        <Toggle
          label="Show middle name"
          checked={field.settings?.showMiddle}
          onChange={(v) => onSettingChange({ showMiddle: v })}
        />
      )}
      {field.type === 'billing_address' && (
        <>
          <Toggle
            label="Show address line 2"
            checked={field.settings?.showAddress2}
            onChange={(v) => onSettingChange({ showAddress2: v })}
          />
          <Toggle
            label="Show country"
            checked={field.settings?.showCountry}
            onChange={(v) => onSettingChange({ showCountry: v })}
          />
        </>
      )}
      {field.type === 'checkbox' && (
        <Field label="Checkbox label">
          <TextInput
            value={field.settings?.checkboxLabel}
            onChange={(v) => onSettingChange({ checkboxLabel: v })}
            placeholder="I agree to…"
          />
        </Field>
      )}

      <div className="insp-separator" />
      <button
        className="insp-btn-danger"
        onClick={() => dispatch({ type: 'REMOVE_FIELD', payload: { pageIdx, fieldId: field.id } })}
      >
        Remove Field
      </button>
    </div>
  );
}

// ─── Global / form settings ────────────────────────────────────────────────────

function FormSettings({ state, dispatch }) {
  const { branding = {}, payment = {}, display = {} } = state;

  function updateBranding(updates) {
    dispatch({ type: 'UPDATE_SETTINGS', payload: { key: 'branding', updates } });
  }
  function updatePayment(updates) {
    dispatch({ type: 'UPDATE_SETTINGS', payload: { key: 'payment', updates } });
  }
  function updateDisplay(updates) {
    dispatch({ type: 'UPDATE_SETTINGS', payload: { key: 'display', updates } });
  }

  return (
    <div className="insp-section">
      <div className="insp-section-title">Branding</div>
      <Field label="Accent Color">
        <div className="insp-color-row">
          <input
            type="color"
            className="insp-color"
            value={branding.accentColor || '#bd2135'}
            onChange={(e) => updateBranding({ accentColor: e.target.value })}
          />
          <input
            className="insp-input"
            value={branding.accentColor || '#bd2135'}
            onChange={(e) =>
              /^#[0-9a-fA-F]{0,6}$/.test(e.target.value) &&
              updateBranding({ accentColor: e.target.value })
            }
          />
        </div>
      </Field>
      <Field label="Form Title">
        <TextInput
          value={branding.title}
          onChange={(v) => updateBranding({ title: v })}
          placeholder="Support Our Mission"
        />
      </Field>
      <Field label="Subtitle">
        <TextInput
          value={branding.subtitle}
          onChange={(v) => updateBranding({ subtitle: v })}
          placeholder="Your gift makes a difference."
        />
      </Field>
      <Field label="Logo URL">
        <TextInput
          value={branding.logoUrl}
          onChange={(v) => updateBranding({ logoUrl: v })}
          placeholder="https://…"
        />
      </Field>

      <div className="insp-separator" />
      <div className="insp-section-title">Display</div>
      <Field label="Form Mode">
        <select
          className="insp-input"
          value={display.mode || 'embedded'}
          onChange={(e) => updateDisplay({ mode: e.target.value })}
        >
          <option value="embedded">Embedded (inline)</option>
          <option value="modal">Modal popup</option>
        </select>
      </Field>

      <div className="insp-separator" />
      <div className="insp-section-title">Payment</div>
      <Field label="Currency">
        <select
          className="insp-input"
          value={payment.currency || 'USD'}
          onChange={(e) => updatePayment({ currency: e.target.value })}
        >
          <option value="USD">USD</option>
          <option value="CAD">CAD</option>
          <option value="EUR">EUR</option>
          <option value="GBP">GBP</option>
        </select>
      </Field>
      <Field label="Processing Fee %">
        <NumberInput
          value={payment.processingFeePercent}
          onChange={(v) => updatePayment({ processingFeePercent: v })}
          min={0}
          step={0.1}
        />
      </Field>
      <Field label="Processing Fee Fixed ($)">
        <NumberInput
          value={payment.processingFeeFixed}
          onChange={(v) => updatePayment({ processingFeeFixed: v })}
          min={0}
          step={0.01}
        />
      </Field>
    </div>
  );
}

function SitePreview({ state, page, previewMode, setPreviewMode }) {
  const accent = state.branding?.accentColor || '#bd2135';
  const title = state.branding?.title || 'Support Our Mission';
  const subtitle = state.branding?.subtitle || 'Your gift makes a difference.';
  const logoUrl = state.branding?.logoUrl || '';

  return (
    <div className="insp-section">
      <div className="insp-section-title">Site Preview</div>
      <div className="insp-preview-toolbar">
        <button
          className={`insp-preview-mode${previewMode === 'embedded' ? ' is-active' : ''}`}
          onClick={() => setPreviewMode('embedded')}
          type="button"
        >
          Embedded
        </button>
        <button
          className={`insp-preview-mode${previewMode === 'modal' ? ' is-active' : ''}`}
          onClick={() => setPreviewMode('modal')}
          type="button"
        >
          Modal
        </button>
      </div>

      <div className="insp-site-preview">
        <div className="insp-site-chrome">
          <div className="insp-site-brand">Sample Site</div>
          <button className="insp-site-donate" type="button" style={{ background: accent }}>
            Donate
          </button>
        </div>

        <div className="insp-site-content">
          <h4 style={{ color: accent }}>Support Refuge&apos;s ministry</h4>
          <p>Preview your live donation experience in-context before publishing.</p>
        </div>

        {previewMode === 'embedded' ? (
          <div className="insp-runtime-panel">
            <div className="insp-runtime-header">
              {logoUrl ? (
                <img src={logoUrl} alt="logo" />
              ) : (
                <div className="insp-runtime-logo-fallback" />
              )}
              <div>
                <div className="insp-runtime-title">{title}</div>
                <div className="insp-runtime-subtitle">{subtitle}</div>
              </div>
            </div>
            <div className="insp-runtime-body">
              {page?.rows?.length ? (
                page.rows.map((row) => (
                  <div key={row.id} className="insp-runtime-row">
                    {(row.columns || []).map((col) => {
                      const span = typeof col.width === 'number' && col.width > 0 ? col.width : 12;
                      return (
                        <div
                          key={col.id}
                          className="insp-runtime-col"
                          style={{ gridColumn: `span ${span}` }}
                        >
                          {col.field ? (
                            <>
                              <div className="insp-runtime-field-label">
                                {col.field.label || col.field.type}
                              </div>
                              <FieldPreview field={col.field} accent={accent} />
                            </>
                          ) : (
                            <div className="insp-runtime-empty">Empty field</div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                ))
              ) : (
                <div className="insp-runtime-empty">No fields on this page yet.</div>
              )}
            </div>
          </div>
        ) : (
          <div className="insp-modal-preview-shell">
            <button className="insp-modal-launch" type="button" style={{ background: accent }}>
              Open Donation Form
            </button>
            <div className="insp-modal-overlay">
              <div className="insp-modal-card">
                <div className="insp-runtime-header">
                  {logoUrl ? (
                    <img src={logoUrl} alt="logo" />
                  ) : (
                    <div className="insp-runtime-logo-fallback" />
                  )}
                  <div>
                    <div className="insp-runtime-title">{title}</div>
                    <div className="insp-runtime-subtitle">{subtitle}</div>
                  </div>
                </div>
                <div className="insp-runtime-body">
                  {page?.rows?.length ? (
                    page.rows.map((row) => (
                      <div key={row.id} className="insp-runtime-row">
                        {(row.columns || []).map((col) => {
                          const span =
                            typeof col.width === 'number' && col.width > 0 ? col.width : 12;
                          return (
                            <div
                              key={col.id}
                              className="insp-runtime-col"
                              style={{ gridColumn: `span ${span}` }}
                            >
                              {col.field ? (
                                <>
                                  <div className="insp-runtime-field-label">
                                    {col.field.label || col.field.type}
                                  </div>
                                  <FieldPreview field={col.field} accent={accent} />
                                </>
                              ) : (
                                <div className="insp-runtime-empty">Empty field</div>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    ))
                  ) : (
                    <div className="insp-runtime-empty">No fields on this page yet.</div>
                  )}
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Inspector root ───────────────────────────────────────────────────────────

export default function Inspector({ state, dispatch }) {
  const [tab, setTab] = useState('field');
  const [previewMode, setPreviewMode] = useState(state.display?.mode || 'embedded');

  const selectedField = (() => {
    if (!state.selectedFieldId) return null;
    for (let pi = 0; pi < state.pages.length; pi++) {
      const page = state.pages[pi];
      for (const row of page.rows) {
        for (const col of row.columns) {
          if (col.field?.id === state.selectedFieldId) return { field: col.field, pageIdx: pi };
        }
      }
    }
    return null;
  })();

  return (
    <aside className="vb-inspector">
      <div className="insp-tabs">
        <button
          className={`insp-tab${tab === 'field' ? ' is-active' : ''}`}
          onClick={() => setTab('field')}
        >
          {selectedField ? '✏ Field' : 'Field'}
        </button>
        <button
          className={`insp-tab${tab === 'settings' ? ' is-active' : ''}`}
          onClick={() => setTab('settings')}
        >
          ⚙ Settings
        </button>
        <button
          className={`insp-tab${tab === 'preview' ? ' is-active' : ''}`}
          onClick={() => {
            setPreviewMode(state.display?.mode || 'embedded');
            setTab('preview');
          }}
        >
          Preview
        </button>
      </div>

      <div className="insp-body">
        {tab === 'field' ? (
          selectedField ? (
            <FieldInspector
              field={selectedField.field}
              pageIdx={selectedField.pageIdx}
              dispatch={dispatch}
            />
          ) : (
            <div className="insp-empty">
              <span className="insp-empty-icon">☝</span>
              <p>Click a field on the canvas to edit its settings.</p>
            </div>
          )
        ) : tab === 'settings' ? (
          <FormSettings state={state} dispatch={dispatch} />
        ) : (
          <SitePreview
            state={state}
            page={state.pages[state.selectedPageIdx] || state.pages[0]}
            previewMode={previewMode}
            setPreviewMode={setPreviewMode}
          />
        )}
      </div>
    </aside>
  );
}
