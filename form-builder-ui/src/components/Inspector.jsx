import React, { useState } from 'react';
import { getFieldMeta, SF_SUGGESTIONS } from '../fieldTypes';
import FieldPreview from './FieldPreview';

// ─── Generic form helpers ─────────────────────────────────────────────────────

function Field({ label, hint, children }) {
  return (
    <div className="insp-field">
      <label className="insp-label">{label}</label>
      {hint && <div className="insp-hint">{hint}</div>}
      {children}
    </div>
  );
}

function TextInput({ value, onChange, placeholder, type = 'text' }) {
  return (
    <input
      className="insp-input"
      type={type}
      value={value ?? ''}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder || ''}
    />
  );
}

function TextArea({ value, onChange, placeholder, rows = 3 }) {
  return (
    <textarea
      className="insp-input insp-textarea"
      value={value ?? ''}
      rows={rows}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder || ''}
    />
  );
}

function Toggle({ label, checked, onChange }) {
  return (
    <label className="insp-toggle-row">
      <span>{label}</span>
      <div
        className={`insp-toggle-track${checked ? ' is-on' : ''}`}
        onClick={() => onChange(!checked)}
        role="switch"
        aria-checked={!!checked}
        tabIndex={0}
        onKeyDown={(e) => (e.key === ' ' || e.key === 'Enter') && onChange(!checked)}
      >
        <div className="insp-toggle-thumb" />
      </div>
    </label>
  );
}

function NumberInput({ value, onChange, min, max, step = 1, placeholder }) {
  return (
    <input
      className="insp-input"
      type="number"
      value={value ?? ''}
      onChange={(e) => onChange(e.target.value === '' ? null : Number(e.target.value))}
      min={min}
      max={max}
      step={step}
      placeholder={placeholder}
    />
  );
}

function Select({ value, onChange, children }) {
  return (
    <select className="insp-input" value={value ?? ''} onChange={(e) => onChange(e.target.value)}>
      {children}
    </select>
  );
}

function SectionTitle({ children }) {
  return <div className="insp-section-title">{children}</div>;
}

function Separator() {
  return <div className="insp-separator" />;
}

// ─── Options list editor ──────────────────────────────────────────────────────

function OptionsList({ options = [], onChange }) {
  function updateOption(idx, key, val) {
    onChange(options.map((o, i) => (i === idx ? { ...o, [key]: val } : o)));
  }
  function addOption() {
    onChange([...options, { label: 'New Option', value: `opt_${options.length + 1}` }]);
  }
  function removeOption(idx) {
    onChange(options.filter((_, i) => i !== idx));
  }
  return (
    <div className="insp-options-list">
      {options.map((opt, idx) => (
        <div key={idx} className="insp-option-row">
          <input className="insp-input insp-input-sm" value={opt.label} onChange={(e) => updateOption(idx, 'label', e.target.value)} placeholder="Label" />
          <input className="insp-input insp-input-sm" value={opt.value} onChange={(e) => updateOption(idx, 'value', e.target.value)} placeholder="Value" />
          <button className="insp-btn-icon-danger" onClick={() => removeOption(idx)} title="Remove">✕</button>
        </div>
      ))}
      <button className="insp-btn-sm" onClick={addOption}>+ Add Option</button>
    </div>
  );
}

// ─── Field-type-specific settings ─────────────────────────────────────────────

function HeadingSettings({ settings, onChange }) {
  return (
    <>
      <Field label="Text"><TextInput value={settings.text} onChange={(v) => onChange({ text: v })} placeholder="Section Heading" /></Field>
      <Field label="Level">
        <Select value={settings.level || 'h2'} onChange={(v) => onChange({ level: v })}>
          {['h1','h2','h3','h4'].map((h) => <option key={h} value={h}>{h.toUpperCase()}</option>)}
        </Select>
      </Field>
      <Field label="Alignment">
        <Select value={settings.align || 'left'} onChange={(v) => onChange({ align: v })}>
          <option value="left">Left</option><option value="center">Center</option><option value="right">Right</option>
        </Select>
      </Field>
    </>
  );
}

function ParagraphSettings({ settings, onChange }) {
  return (
    <>
      <Field label="Text"><TextArea value={settings.text} onChange={(v) => onChange({ text: v })} placeholder="Body copy…" rows={4} /></Field>
      <Field label="Alignment">
        <Select value={settings.align || 'left'} onChange={(v) => onChange({ align: v })}>
          <option value="left">Left</option><option value="center">Center</option><option value="right">Right</option>
        </Select>
      </Field>
    </>
  );
}

function ImageSettings({ settings, onChange }) {
  return (
    <>
      <Field label="Image URL"><TextInput value={settings.src} onChange={(v) => onChange({ src: v })} placeholder="https://…" /></Field>
      <Field label="Alt text"><TextInput value={settings.alt} onChange={(v) => onChange({ alt: v })} placeholder="Describe the image" /></Field>
      <Field label="Width"><TextInput value={settings.width} onChange={(v) => onChange({ width: v })} placeholder="100%" /></Field>
    </>
  );
}

function DividerSettings({ settings, onChange }) {
  return (
    <>
      <Field label="Style">
        <Select value={settings.style || 'solid'} onChange={(v) => onChange({ style: v })}>
          <option value="solid">Solid</option><option value="dashed">Dashed</option><option value="dotted">Dotted</option>
        </Select>
      </Field>
      <Field label="Color">
        <div className="insp-color-row">
          <input type="color" className="insp-color" value={settings.color || '#e5e0da'} onChange={(e) => onChange({ color: e.target.value })} />
          <TextInput value={settings.color || '#e5e0da'} onChange={(v) => onChange({ color: v })} />
        </div>
      </Field>
    </>
  );
}

function SpacerSettings({ settings, onChange }) {
  return (
    <Field label="Height (px)">
      <NumberInput value={settings.height ?? 24} onChange={(v) => onChange({ height: v })} min={4} max={200} step={4} />
    </Field>
  );
}

function HtmlEmbedSettings({ settings, onChange }) {
  return (
    <Field label="HTML Code" hint="Rendered at runtime only">
      <TextArea value={settings.html} onChange={(v) => onChange({ html: v })} rows={6} placeholder="<p>Your HTML</p>" />
    </Field>
  );
}

function SectionHeaderSettings({ settings, onChange }) {
  return (
    <>
      <Field label="Title"><TextInput value={settings.title} onChange={(v) => onChange({ title: v })} placeholder="Section Title" /></Field>
      <Field label="Subtitle"><TextInput value={settings.subtitle} onChange={(v) => onChange({ subtitle: v })} placeholder="Optional subtitle" /></Field>
      <Toggle label="Show divider line" checked={settings.showLine !== false} onChange={(v) => onChange({ showLine: v })} />
    </>
  );
}

function AmountSettings({ settings, onChange }) {
  return (
    <>
      <Field label="Currency">
        <Select value={settings.currency || 'USD'} onChange={(v) => onChange({ currency: v })}>
          <option value="USD">USD ($)</option><option value="CAD">CAD</option><option value="EUR">EUR</option><option value="GBP">GBP</option>
        </Select>
      </Field>
      <Field label="Fixed Amount (blank = open input)"><NumberInput value={settings.fixedAmount} onChange={(v) => onChange({ fixedAmount: v })} min={0} step={0.01} placeholder="e.g. 25.00" /></Field>
      <Field label="Minimum ($)"><NumberInput value={settings.min} onChange={(v) => onChange({ min: v })} min={0} /></Field>
      <Field label="Maximum ($)"><NumberInput value={settings.max} onChange={(v) => onChange({ max: v })} min={0} /></Field>
    </>
  );
}

function AmountPillsSettings({ settings, onChange }) {
  const [newPreset, setNewPreset] = useState('');
  const presets = settings.presets || [];
  function addPreset() {
    const v = Number(newPreset);
    if (!v || presets.includes(v)) return;
    onChange({ presets: [...presets, v].sort((a, b) => a - b) });
    setNewPreset('');
  }
  return (
    <>
      <Field label="Currency">
        <Select value={settings.currency || 'USD'} onChange={(v) => onChange({ currency: v })}>
          <option value="USD">USD ($)</option><option value="CAD">CAD</option><option value="EUR">EUR</option><option value="GBP">GBP</option>
        </Select>
      </Field>
      <Field label="Preset Amounts">
        <div className="insp-tags">
          {presets.map((p) => (
            <span key={p} className="insp-tag">${p}<button onClick={() => onChange({ presets: presets.filter((x) => x !== p) })}>✕</button></span>
          ))}
        </div>
        <div className="insp-row">
          <input className="insp-input" type="number" placeholder="Add amount…" value={newPreset} onChange={(e) => setNewPreset(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && addPreset()} />
          <button className="insp-btn-sm" onClick={addPreset}>Add</button>
        </div>
      </Field>
      <Toggle label="Allow custom amount" checked={settings.allowCustom} onChange={(v) => onChange({ allowCustom: v })} />
    </>
  );
}

function FrequencySettings({ settings, onChange }) {
  return (
    <>
      <Field label="Options"><OptionsList options={settings.options || []} onChange={(opts) => onChange({ options: opts })} /></Field>
      <Field label="Default">
        <Select value={settings.defaultValue || ''} onChange={(v) => onChange({ defaultValue: v })}>
          <option value="">— none —</option>
          {(settings.options || []).map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </Select>
      </Field>
    </>
  );
}

function CategorySettings({ settings, onChange }) {
  return (
    <>
      <Field label="Input Style">
        <Select value={settings.inputMode || 'dropdown'} onChange={(v) => onChange({ inputMode: v })}>
          <option value="dropdown">Dropdown</option><option value="pills">Pills</option>
        </Select>
      </Field>
      <Field label="Options"><OptionsList options={settings.options || []} onChange={(opts) => onChange({ options: opts })} /></Field>
    </>
  );
}

function CoverFeeSettings({ settings, onChange }) {
  return (
    <>
      <Field label="Fee % "><NumberInput value={settings.feePercent ?? 2.9} onChange={(v) => onChange({ feePercent: v })} min={0} max={100} step={0.01} /></Field>
      <Field label="Fixed ($)"><NumberInput value={settings.feeFixed ?? 0.30} onChange={(v) => onChange({ feeFixed: v })} min={0} step={0.01} /></Field>
      <Toggle label="Checked by default" checked={settings.defaultChecked} onChange={(v) => onChange({ defaultChecked: v })} />
    </>
  );
}

function PaymentMethodSettings({ settings, onChange }) {
  const methods = [
    { value: 'card', label: 'Card' },
    { value: 'ach', label: 'ACH / Bank' },
    { value: 'apple_pay', label: 'Apple Pay' },
    { value: 'google_pay', label: 'Google Pay' },
  ];
  const selected = settings.options || ['card'];
  function toggle(v) {
    const next = selected.includes(v) ? selected.filter((o) => o !== v) : [...selected, v];
    if (next.length === 0) return;
    onChange({ options: next });
  }
  return (
    <Field label="Available Methods">
      {methods.map((m) => <Toggle key={m.value} label={m.label} checked={selected.includes(m.value)} onChange={() => toggle(m.value)} />)}
    </Field>
  );
}

function CheckboxGroupSettings({ settings, onChange }) {
  return (
    <>
      <Field label="Options"><OptionsList options={settings.options || []} onChange={(opts) => onChange({ options: opts })} /></Field>
      <Field label="Layout">
        <Select value={settings.layout || 'vertical'} onChange={(v) => onChange({ layout: v })}>
          <option value="vertical">Vertical</option><option value="horizontal">Horizontal</option>
        </Select>
      </Field>
    </>
  );
}

function RadioSettings({ settings, onChange }) {
  return (
    <>
      <Field label="Options"><OptionsList options={settings.options || []} onChange={(opts) => onChange({ options: opts })} /></Field>
      <Toggle label="Display as dropdown" checked={settings.asDropdown} onChange={(v) => onChange({ asDropdown: v })} />
    </>
  );
}

function StarRatingSettings({ settings, onChange }) {
  return (
    <>
      <Field label="Max Stars"><NumberInput value={settings.maxStars ?? 5} onChange={(v) => onChange({ maxStars: v })} min={3} max={10} /></Field>
      <Toggle label="Allow half stars" checked={settings.halfStars} onChange={(v) => onChange({ halfStars: v })} />
    </>
  );
}

function RangeSliderSettings({ settings, onChange }) {
  return (
    <>
      <Field label="Min"><NumberInput value={settings.min ?? 0} onChange={(v) => onChange({ min: v })} /></Field>
      <Field label="Max"><NumberInput value={settings.max ?? 100} onChange={(v) => onChange({ max: v })} /></Field>
      <Field label="Step"><NumberInput value={settings.step ?? 1} onChange={(v) => onChange({ step: v })} min={1} /></Field>
      <Field label="Default value"><NumberInput value={settings.defaultValue} onChange={(v) => onChange({ defaultValue: v })} /></Field>
    </>
  );
}

function LikertSettings({ settings, onChange }) {
  return (
    <>
      <Field label="Scale Points"><NumberInput value={settings.points ?? 5} onChange={(v) => onChange({ points: v })} min={3} max={7} /></Field>
      <Field label="Low Label"><TextInput value={settings.lowLabel} onChange={(v) => onChange({ lowLabel: v })} placeholder="Strongly Disagree" /></Field>
      <Field label="High Label"><TextInput value={settings.highLabel} onChange={(v) => onChange({ highLabel: v })} placeholder="Strongly Agree" /></Field>
    </>
  );
}

function FullNameSettings({ settings, onChange }) {
  return (
    <>
      <Toggle label="Show prefix (Mr./Ms.)" checked={settings.showPrefix} onChange={(v) => onChange({ showPrefix: v })} />
      <Toggle label="Show middle name" checked={settings.showMiddle} onChange={(v) => onChange({ showMiddle: v })} />
      <Toggle label="Show suffix (Jr./Sr.)" checked={settings.showSuffix} onChange={(v) => onChange({ showSuffix: v })} />
    </>
  );
}

function AddressSettings({ settings, onChange }) {
  return (
    <>
      <Toggle label="Show address line 2" checked={settings.showAddress2} onChange={(v) => onChange({ showAddress2: v })} />
      <Toggle label="Show country" checked={settings.showCountry} onChange={(v) => onChange({ showCountry: v })} />
    </>
  );
}

function FileUploadSettings({ settings, onChange }) {
  return (
    <>
      <Field label="Accepted types" hint="Comma-separated: .pdf,.jpg"><TextInput value={settings.accept} onChange={(v) => onChange({ accept: v })} placeholder=".pdf,.jpg,.png" /></Field>
      <Field label="Max size (MB)"><NumberInput value={settings.maxSizeMb ?? 5} onChange={(v) => onChange({ maxSizeMb: v })} min={1} max={100} /></Field>
      <Toggle label="Allow multiple files" checked={settings.multiple} onChange={(v) => onChange({ multiple: v })} />
    </>
  );
}

function TermsSettings({ settings, onChange }) {
  return (
    <>
      <Field label="Checkbox label"><TextInput value={settings.checkboxLabel} onChange={(v) => onChange({ checkboxLabel: v })} placeholder="I agree to the terms" /></Field>
      <Field label="Link text"><TextInput value={settings.linkText} onChange={(v) => onChange({ linkText: v })} placeholder="Terms & Conditions" /></Field>
      <Field label="Link URL"><TextInput value={settings.linkUrl} onChange={(v) => onChange({ linkUrl: v })} placeholder="https://…" /></Field>
    </>
  );
}

function OrderSummarySettings({ settings, onChange }) {
  return (
    <>
      <Field label="Submit button label"><TextInput value={settings.submitLabel} onChange={(v) => onChange({ submitLabel: v })} placeholder="Complete Donation" /></Field>
      <Toggle label="Show fee breakdown" checked={settings.showFeeBreakdown} onChange={(v) => onChange({ showFeeBreakdown: v })} />
    </>
  );
}

function HiddenFieldSettings({ settings, onChange }) {
  return (
    <Field label="Default value" hint="Can use merge tags like {{contactId}}">
      <TextInput value={settings.value} onChange={(v) => onChange({ value: v })} placeholder="Static or {{merge}}" />
    </Field>
  );
}

function StripeElementSettings({ settings, onChange }) {
  const methodOptions = [
    { value: 'card', label: 'Card' },
    { value: 'us_bank_account', label: 'ACH / Bank' },
    { value: 'link', label: 'Link (saved cards)' },
  ];
  const enabled = settings.methods || ['card'];
  return (
    <Field label="Payment methods">
      {methodOptions.map((m) => (
        <Toggle key={m.value} label={m.label} checked={enabled.includes(m.value)}
          onChange={(v) => {
            const next = v ? [...enabled, m.value] : enabled.filter((x) => x !== m.value);
            onChange({ methods: next.length ? next : ['card'] });
          }}
        />
      ))}
    </Field>
  );
}

// ─── Field Inspector (Field tab) ──────────────────────────────────────────────

function FieldInspector({ field, pageIdx, dispatch }) {
  const meta = getFieldMeta(field.type);
  function update(updates) {
    dispatch({ type: 'UPDATE_FIELD', payload: { fieldId: field.id, updates } });
  }
  function onSettingChange(settings) {
    update({ settings: { ...field.settings, ...settings } });
  }

  const isContentType = ['heading','paragraph','image','divider','spacer','html_embed','section_header'].includes(field.type);
  const hasPlaceholder = ['text','email','phone','textarea','number','url','zip_code','amount','organization'].includes(field.type);
  const hasRequired = !['divider','spacer','html_embed','cover_fee','card_input','ach_input'].includes(field.type);

  return (
    <div className="insp-section">
      <div className="insp-field-header">
        <span className="insp-field-icon">{meta.icon}</span>
        <span className="insp-field-type">{meta.label}</span>
      </div>

      {!isContentType && (
        <Field label="Label"><TextInput value={field.label} onChange={(v) => update({ label: v })} placeholder="Field label" /></Field>
      )}
      {hasPlaceholder && (
        <Field label="Placeholder"><TextInput value={field.placeholder} onChange={(v) => update({ placeholder: v })} placeholder="Placeholder text…" /></Field>
      )}
      {hasRequired && <Toggle label="Required" checked={field.required} onChange={(v) => update({ required: v })} />}
      {!isContentType && <Toggle label="Visible" checked={field.enabled !== false} onChange={(v) => update({ enabled: v })} />}

      <Separator />

      {field.type === 'heading'                && <HeadingSettings       settings={field.settings} onChange={onSettingChange} />}
      {field.type === 'paragraph'              && <ParagraphSettings     settings={field.settings} onChange={onSettingChange} />}
      {field.type === 'image'                  && <ImageSettings         settings={field.settings} onChange={onSettingChange} />}
      {field.type === 'divider'                && <DividerSettings       settings={field.settings} onChange={onSettingChange} />}
      {field.type === 'spacer'                 && <SpacerSettings        settings={field.settings} onChange={onSettingChange} />}
      {field.type === 'html_embed'             && <HtmlEmbedSettings     settings={field.settings} onChange={onSettingChange} />}
      {field.type === 'section_header'         && <SectionHeaderSettings settings={field.settings} onChange={onSettingChange} />}
      {field.type === 'amount'                 && <AmountSettings        settings={field.settings} onChange={onSettingChange} />}
      {field.type === 'amount_pills'           && <AmountPillsSettings   settings={field.settings} onChange={onSettingChange} />}
      {field.type === 'donation_frequency'     && <FrequencySettings     settings={field.settings} onChange={onSettingChange} />}
      {field.type === 'category'               && <CategorySettings      settings={field.settings} onChange={onSettingChange} />}
      {field.type === 'cover_fee'              && <CoverFeeSettings      settings={field.settings} onChange={onSettingChange} />}
      {field.type === 'payment_method'         && <PaymentMethodSettings settings={field.settings} onChange={onSettingChange} />}
      {field.type === 'stripe_payment_element' && <StripeElementSettings settings={field.settings} onChange={onSettingChange} />}
      {field.type === 'checkbox_group'         && <CheckboxGroupSettings settings={field.settings} onChange={onSettingChange} />}
      {field.type === 'radio'                  && <RadioSettings         settings={field.settings} onChange={onSettingChange} />}
      {field.type === 'dropdown'               && <Field label="Options"><OptionsList options={field.settings.options||[]} onChange={(opts)=>onSettingChange({options:opts})} /></Field>}
      {field.type === 'star_rating'            && <StarRatingSettings    settings={field.settings} onChange={onSettingChange} />}
      {field.type === 'range_slider'           && <RangeSliderSettings   settings={field.settings} onChange={onSettingChange} />}
      {field.type === 'likert'                 && <LikertSettings        settings={field.settings} onChange={onSettingChange} />}
      {field.type === 'full_name'              && <FullNameSettings      settings={field.settings} onChange={onSettingChange} />}
      {field.type === 'billing_address'        && <AddressSettings       settings={field.settings} onChange={onSettingChange} />}
      {field.type === 'file_upload'            && <FileUploadSettings    settings={field.settings} onChange={onSettingChange} />}
      {field.type === 'terms_acceptance'       && <TermsSettings         settings={field.settings} onChange={onSettingChange} />}
      {field.type === 'order_summary'          && <OrderSummarySettings  settings={field.settings} onChange={onSettingChange} />}
      {field.type === 'hidden'                 && <HiddenFieldSettings   settings={field.settings} onChange={onSettingChange} />}
      {field.type === 'checkbox' && (
        <Field label="Checkbox label">
          <TextInput value={field.settings?.checkboxLabel} onChange={(v) => onSettingChange({ checkboxLabel: v })} placeholder="I agree to…" />
        </Field>
      )}

      <Separator />
      <button
        className="insp-btn-danger"
        onClick={() => dispatch({ type: 'REMOVE_FIELD', payload: { pageIdx, fieldId: field.id } })}
      >
        Remove Field
      </button>
    </div>
  );
}

// ─── Logic Tab ────────────────────────────────────────────────────────────────

function LogicInspector({ field, state, dispatch }) {
  const conditions = field.conditions || [];
  const allFields = [];
  for (const page of state.pages) {
    for (const row of page.rows) {
      for (const col of row.columns) {
        if (col.field && col.field.id !== field.id) allFields.push(col.field);
      }
    }
  }
  function updateConditions(newConds) {
    dispatch({ type: 'UPDATE_FIELD', payload: { fieldId: field.id, updates: { conditions: newConds } } });
  }
  function addCondition() {
    updateConditions([...conditions, { id: `cond_${Date.now()}`, fieldId: '', operator: 'equals', value: '', action: 'show' }]);
  }
  function updateCondition(idx, key, val) {
    updateConditions(conditions.map((c, i) => (i === idx ? { ...c, [key]: val } : c)));
  }
  function removeCondition(idx) {
    updateConditions(conditions.filter((_, i) => i !== idx));
  }
  return (
    <div className="insp-section">
      <SectionTitle>Conditional Logic</SectionTitle>
      <p className="insp-hint-text">Control when this field is shown based on other field values.</p>
      {conditions.length === 0 ? (
        <div className="insp-logic-empty">No rules — field always visible.</div>
      ) : (
        <div className="insp-logic-list">
          {conditions.map((cond, idx) => (
            <div key={cond.id || idx} className="insp-logic-rule">
              <div className="insp-logic-rule-header">
                <span className="insp-logic-rule-num">Rule {idx + 1}</span>
                <button className="insp-btn-icon-danger" onClick={() => removeCondition(idx)}>✕</button>
              </div>
              <Field label="When field">
                <select className="insp-input" value={cond.fieldId} onChange={(e) => updateCondition(idx, 'fieldId', e.target.value)}>
                  <option value="">— select field —</option>
                  {allFields.map((f) => <option key={f.id} value={f.id}>{f.label || f.type}</option>)}
                </select>
              </Field>
              <Field label="Operator">
                <Select value={cond.operator} onChange={(v) => updateCondition(idx, 'operator', v)}>
                  <option value="equals">equals</option>
                  <option value="not_equals">does not equal</option>
                  <option value="contains">contains</option>
                  <option value="is_empty">is empty</option>
                  <option value="is_not_empty">is not empty</option>
                  <option value="greater_than">greater than</option>
                  <option value="less_than">less than</option>
                </Select>
              </Field>
              {!['is_empty','is_not_empty'].includes(cond.operator) && (
                <Field label="Value"><TextInput value={cond.value} onChange={(v) => updateCondition(idx, 'value', v)} placeholder="Value to compare" /></Field>
              )}
              <Field label="Then">
                <Select value={cond.action} onChange={(v) => updateCondition(idx, 'action', v)}>
                  <option value="show">Show this field</option>
                  <option value="hide">Hide this field</option>
                  <option value="require">Make required</option>
                </Select>
              </Field>
            </div>
          ))}
        </div>
      )}
      <button className="insp-btn-sm" onClick={addCondition}>+ Add Condition</button>
    </div>
  );
}

// ─── Salesforce Tab ───────────────────────────────────────────────────────────

function SalesforceInspector({ field, state, dispatch }) {
  const sf = field.salesforce || {};
  const suggestions = SF_SUGGESTIONS[field.type] || [];
  function updateSf(updates) {
    dispatch({ type: 'UPDATE_FIELD', payload: { fieldId: field.id, updates: { salesforce: { ...sf, ...updates } } } });
  }
  return (
    <div className="insp-section">
      <SectionTitle>Field Mapping</SectionTitle>
      <p className="insp-hint-text">Map this field to a Salesforce object and field API name.</p>
      <Field label="Object">
        <Select value={sf.object || ''} onChange={(v) => updateSf({ object: v })}>
          <option value="">— none —</option>
          <option value="Contact">Contact</option>
          <option value="Lead">Lead</option>
          <option value="Account">Account</option>
          <option value="Opportunity">Opportunity</option>
          <option value="Transaction__c">Transaction__c</option>
          <option value="Campaign">Campaign</option>
        </Select>
      </Field>
      <Field label="Field API Name">
        <input className="insp-input" value={sf.field || ''} onChange={(e) => updateSf({ field: e.target.value })} placeholder="e.g. FirstName, Amount__c" list={`sf-sugg-${field.id}`} />
        {suggestions.length > 0 && (
          <datalist id={`sf-sugg-${field.id}`}>
            {suggestions.map((s) => <option key={s.field} value={s.field} label={s.label} />)}
          </datalist>
        )}
      </Field>
      {suggestions.length > 0 && (
        <div className="insp-sf-suggestions">
          <div className="insp-sf-sugg-label">Suggested:</div>
          {suggestions.map((s) => (
            <button key={s.field} className="insp-sf-sugg-btn" onClick={() => updateSf({ object: s.object, field: s.field })}>
              <span className="insp-sf-obj">{s.object}</span>
              <span className="insp-sf-field">{s.field}</span>
              <span className="insp-sf-label">{s.label}</span>
            </button>
          ))}
        </div>
      )}
      <Field label="Transform" hint="Optional value override or formula">
        <TextInput value={sf.transform} onChange={(v) => updateSf({ transform: v })} placeholder="e.g. fixed:Donation" />
      </Field>
      <Separator />
      <SectionTitle>Form-Level Salesforce Config</SectionTitle>
      {[
        { key: 'primaryObject', label: 'Primary Object', placeholder: 'Contact' },
        { key: 'donationObject', label: 'Donation Object', placeholder: 'Transaction__c' },
        { key: 'defaultCampaignId', label: 'Default Campaign ID', placeholder: '701…' },
        { key: 'recordType', label: 'Record Type', placeholder: 'Individual' },
      ].map(({ key, label, placeholder }) => (
        <Field key={key} label={label}>
          <TextInput value={state.salesforce?.[key]} onChange={(v) => dispatch({ type: 'UPDATE_SETTINGS', payload: { key: 'salesforce', updates: { [key]: v } } })} placeholder={placeholder} />
        </Field>
      ))}
      <Toggle
        label="Create Account on submission"
        checked={state.salesforce?.createAccount}
        onChange={(v) => dispatch({ type: 'UPDATE_SETTINGS', payload: { key: 'salesforce', updates: { createAccount: v } } })}
      />
    </div>
  );
}

// ─── Form Settings Tab ────────────────────────────────────────────────────────

function FormSettings({ state, dispatch }) {
  const { branding = {}, payment = {}, display = {}, confirmationPage = {} } = state;
  function updateBranding(u) { dispatch({ type: 'UPDATE_SETTINGS', payload: { key: 'branding', updates: u } }); }
  function updatePayment(u) { dispatch({ type: 'UPDATE_SETTINGS', payload: { key: 'payment', updates: u } }); }
  function updateDisplay(u) { dispatch({ type: 'UPDATE_SETTINGS', payload: { key: 'display', updates: u } }); }
  function updateConfirmation(u) { dispatch({ type: 'UPDATE_SETTINGS', payload: { key: 'confirmationPage', updates: u } }); }

  return (
    <div className="insp-section">
      <SectionTitle>Branding</SectionTitle>
      <Field label="Accent Color">
        <div className="insp-color-row">
          <input type="color" className="insp-color" value={branding.accentColor || '#bd2135'} onChange={(e) => updateBranding({ accentColor: e.target.value })} />
          <input className="insp-input" value={branding.accentColor || '#bd2135'} onChange={(e) => /^#[0-9a-fA-F]{0,6}$/.test(e.target.value) && updateBranding({ accentColor: e.target.value })} />
        </div>
      </Field>
      <Field label="Form Title"><TextInput value={branding.title} onChange={(v) => updateBranding({ title: v })} placeholder="Support Our Mission" /></Field>
      <Field label="Subtitle"><TextInput value={branding.subtitle} onChange={(v) => updateBranding({ subtitle: v })} placeholder="Your gift makes a difference." /></Field>
      <Field label="Logo URL"><TextInput value={branding.logoUrl} onChange={(v) => updateBranding({ logoUrl: v })} placeholder="https://…" /></Field>
      <Field label="Header Background">
        <div className="insp-color-row">
          <input type="color" className="insp-color" value={branding.headerBg || '#ffffff'} onChange={(e) => updateBranding({ headerBg: e.target.value })} />
          <TextInput value={branding.headerBg} onChange={(v) => updateBranding({ headerBg: v })} placeholder="#ffffff" />
        </div>
      </Field>
      <Field label="Font Family">
        <Select value={branding.fontFamily || 'Manrope'} onChange={(v) => updateBranding({ fontFamily: v })}>
          <option value="Manrope">Manrope</option>
          <option value="Inter">Inter</option>
          <option value="Georgia">Georgia</option>
          <option value="system-ui">System UI</option>
        </Select>
      </Field>

      <Separator />
      <SectionTitle>Display</SectionTitle>
      <Field label="Form Mode">
        <Select value={display.mode || 'embedded'} onChange={(v) => updateDisplay({ mode: v })}>
          <option value="embedded">Embedded (inline)</option>
          <option value="modal">Modal popup</option>
        </Select>
      </Field>

      <Separator />
      <SectionTitle>Payment</SectionTitle>
      <Field label="Currency">
        <Select value={payment.currency || 'USD'} onChange={(v) => updatePayment({ currency: v })}>
          <option value="USD">USD ($)</option><option value="CAD">CAD</option><option value="EUR">EUR</option><option value="GBP">GBP</option>
        </Select>
      </Field>
      <Field label="Stripe Publishable Key" hint="Starts with pk_live_ or pk_test_">
        <TextInput value={payment.stripePublishableKey} onChange={(v) => updatePayment({ stripePublishableKey: v })} placeholder="pk_live_…" />
      </Field>
      <Field label="Processing Fee %"><NumberInput value={payment.processingFeePercent} onChange={(v) => updatePayment({ processingFeePercent: v })} min={0} step={0.01} /></Field>
      <Field label="Fixed Fee ($)"><NumberInput value={payment.processingFeeFixed} onChange={(v) => updatePayment({ processingFeeFixed: v })} min={0} step={0.01} /></Field>
      <Toggle label="Allow recurring donations" checked={payment.allowRecurring} onChange={(v) => updatePayment({ allowRecurring: v })} />

      <Separator />
      <SectionTitle>Confirmation</SectionTitle>
      <Field label="After submit">
        <Select value={confirmationPage.type || 'message'} onChange={(v) => updateConfirmation({ type: v })}>
          <option value="message">Show message</option>
          <option value="redirect">Redirect to URL</option>
        </Select>
      </Field>
      {(confirmationPage.type || 'message') === 'message' ? (
        <Field label="Thank-you message"><TextArea value={confirmationPage.message} onChange={(v) => updateConfirmation({ message: v })} placeholder="Thank you for your donation!" rows={3} /></Field>
      ) : (
        <Field label="Redirect URL"><TextInput value={confirmationPage.redirectUrl} onChange={(v) => updateConfirmation({ redirectUrl: v })} placeholder="https://yoursite.com/thank-you" /></Field>
      )}
      <Toggle label="Send email notification" checked={confirmationPage.emailNotification} onChange={(v) => updateConfirmation({ emailNotification: v })} />
    </div>
  );
}

// ─── Site Preview tab ────────────────────────────────────────────────────────

function SitePreview({ state, page, previewMode, setPreviewMode }) {
  const accent = state.branding?.accentColor || '#bd2135';
  const title = state.branding?.title || 'Support Our Mission';
  const subtitle = state.branding?.subtitle || 'Your gift makes a difference.';
  const logoUrl = state.branding?.logoUrl || '';

  const runtimeHeader = (
    <div className="insp-runtime-header">
      {logoUrl ? <img src={logoUrl} alt="logo" /> : <div className="insp-runtime-logo-fallback" />}
      <div>
        <div className="insp-runtime-title">{title}</div>
        <div className="insp-runtime-subtitle">{subtitle}</div>
      </div>
    </div>
  );

  const renderPage = (
    <div className="insp-runtime-body">
      {page?.rows?.length ? (
        page.rows.map((row) => (
          <div key={row.id} className="insp-runtime-row">
            {(row.columns || []).map((col) => {
              const span = typeof col.width === 'number' && col.width > 0 ? col.width : 12;
              return (
                <div key={col.id} className="insp-runtime-col" style={{ gridColumn: `span ${span}` }}>
                  {col.field ? (
                    <>
                      {!['heading','paragraph','divider','spacer','html_embed','section_header'].includes(col.field.type) && (
                        <div className="insp-runtime-field-label">{col.field.label || col.field.type}</div>
                      )}
                      <FieldPreview field={col.field} accent={accent} />
                    </>
                  ) : (
                    <div className="insp-runtime-empty">Empty</div>
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
  );

  return (
    <div className="insp-section">
      <SectionTitle>Site Preview</SectionTitle>
      <div className="insp-preview-toolbar">
        <button className={`insp-preview-mode${previewMode === 'embedded' ? ' is-active' : ''}`} onClick={() => setPreviewMode('embedded')}>Embedded</button>
        <button className={`insp-preview-mode${previewMode === 'modal' ? ' is-active' : ''}`} onClick={() => setPreviewMode('modal')}>Modal</button>
      </div>
      <div className="insp-site-preview">
        <div className="insp-site-chrome">
          <div className="insp-site-brand">Sample Site</div>
          <button className="insp-site-donate" type="button" style={{ background: accent }}>Donate</button>
        </div>
        <div className="insp-site-content">
          <h4 style={{ color: accent }}>Support our mission</h4>
          <p>Preview your form in context before publishing.</p>
        </div>
        {previewMode === 'embedded' ? (
          <div className="insp-runtime-panel">{runtimeHeader}{renderPage}</div>
        ) : (
          <div className="insp-modal-preview-shell">
            <button className="insp-modal-launch" type="button" style={{ background: accent }}>Open Donation Form</button>
            <div className="insp-modal-overlay">
              <div className="insp-modal-card">{runtimeHeader}{renderPage}</div>
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

  const tabs = [
    { id: 'field',    label: selectedField ? '✏ Field' : 'Field' },
    { id: 'logic',    label: '⚡ Logic',     disabled: !selectedField },
    { id: 'sf',       label: '☁ Salesforce', disabled: !selectedField },
    { id: 'settings', label: '⚙ Form' },
    { id: 'preview',  label: '👁 Preview' },
  ];

  return (
    <aside className="vb-inspector">
      <div className="insp-tabs insp-tabs-5">
        {tabs.map((t) => (
          <button
            key={t.id}
            className={`insp-tab${tab === t.id ? ' is-active' : ''}${t.disabled ? ' is-disabled' : ''}`}
            onClick={() => {
              if (t.disabled) return;
              if (t.id === 'preview') setPreviewMode(state.display?.mode || 'embedded');
              setTab(t.id);
            }}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className="insp-body">
        {tab === 'field' ? (
          selectedField ? (
            <FieldInspector field={selectedField.field} pageIdx={selectedField.pageIdx} dispatch={dispatch} />
          ) : (
            <div className="insp-empty">
              <span className="insp-empty-icon">☝</span>
              <p>Click a field on the canvas to edit its settings.</p>
            </div>
          )
        ) : tab === 'logic' && selectedField ? (
          <LogicInspector field={selectedField.field} state={state} dispatch={dispatch} />
        ) : tab === 'sf' && selectedField ? (
          <SalesforceInspector field={selectedField.field} state={state} dispatch={dispatch} />
        ) : tab === 'settings' ? (
          <FormSettings state={state} dispatch={dispatch} />
        ) : tab === 'preview' ? (
          <SitePreview
            state={state}
            page={state.pages[state.selectedPageIdx] || state.pages[0]}
            previewMode={previewMode}
            setPreviewMode={setPreviewMode}
          />
        ) : (
          <div className="insp-empty">
            <span className="insp-empty-icon">☝</span>
            <p>Select a field on the canvas first.</p>
          </div>
        )}
      </div>
    </aside>
  );
}
