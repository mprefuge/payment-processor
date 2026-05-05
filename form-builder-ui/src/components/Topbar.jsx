import React, { useState, useRef } from 'react';

const API_BASE = '/api/form-builder/configs';

const DEVICE_ICONS = {
  desktop: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <rect x="2" y="3" width="20" height="14" rx="2" />
      <path d="M8 21h8M12 17v4" />
    </svg>
  ),
  tablet: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <rect x="4" y="2" width="16" height="20" rx="2" />
      <circle cx="12" cy="18" r="1" fill="currentColor" />
    </svg>
  ),
  mobile: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <rect x="7" y="2" width="10" height="20" rx="2" />
      <circle cx="12" cy="18" r="1" fill="currentColor" />
    </svg>
  ),
};

export default function Topbar({ state, dispatch, canUndo, canRedo, devicePreview, setDevicePreview }) {
  const [library, setLibrary] = useState([]);
  const [libLoaded, setLibLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState('');

  async function loadLibrary() {
    if (libLoaded) return;
    try {
      const r = await fetch(API_BASE);
      const data = await r.json();
      setLibrary(data.records || []);
      setLibLoaded(true);
    } catch {
      setLibrary([]);
      setLibLoaded(true);
    }
  }

  async function loadForm(id) {
    if (!id) { dispatch({ type: 'RESET' }); return; }
    try {
      const r = await fetch(`${API_BASE}/${encodeURIComponent(id)}`);
      const data = await r.json();
      dispatch({ type: 'LOAD_CONFIG', payload: { ...data.config, id: data.id } });
    } catch {
      setMsg('Failed to load form.');
    }
  }

  async function save() {
    setSaving(true);
    try {
      const { formId, selectedPageIdx, selectedFieldId, dirty, history, historyIndex, ...config } = state;
      config.name = config.name || 'Untitled Form';
      const method = state.formId ? 'PUT' : 'POST';
      const url = state.formId ? `${API_BASE}/${encodeURIComponent(state.formId)}` : API_BASE;
      const r = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(config),
      });
      if (!r.ok) throw new Error('save failed');
      const data = await r.json();
      dispatch({ type: 'MARK_SAVED', payload: data.id });
      setMsg('Saved ✓');
      setLibLoaded(false);
      setTimeout(() => setMsg(''), 2500);
    } catch {
      setMsg('Save failed.');
    } finally {
      setSaving(false);
    }
  }

  const accent = state.branding?.accentColor || '#bd2135';
  const totalFields = state.pages.reduce(
    (n, p) => n + p.rows.reduce((m, r) => m + r.columns.filter((c) => c.field).length, 0), 0
  );

  return (
    <header className="vb-topbar">
      <div className="vb-topbar-brand">Form<span style={{ color: accent }}>Builder</span></div>
      <div className="vb-topbar-sep" />
      <input
        className="vb-topbar-name"
        value={state.name}
        onChange={(e) => dispatch({ type: 'UPDATE_SETTINGS', payload: { key: 'root', updates: { name: e.target.value } } })}
        placeholder="Form name..."
      />
      <select className="vb-topbar-select" defaultValue="" onClick={loadLibrary} onChange={(e) => loadForm(e.target.value)}>
        <option value="">Load form...</option>
        {library.map((rec) => (
          <option key={rec.id} value={rec.id}>{rec.name || 'Untitled'} ({rec.displayMode || 'embedded'})</option>
        ))}
      </select>
      <div className="vb-topbar-sep" />
      <div className="vb-topbar-history">
        <button className="vb-icon-btn" onClick={() => dispatch({ type: 'UNDO' })} disabled={!canUndo} title="Undo (Ctrl+Z)">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"><path d="M3 10h10a7 7 0 0 1 7 7v1"/><polyline points="3 5 3 10 8 10"/></svg>
        </button>
        <button className="vb-icon-btn" onClick={() => dispatch({ type: 'REDO' })} disabled={!canRedo} title="Redo (Ctrl+Y)">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"><path d="M21 10H11a7 7 0 0 0-7 7v1"/><polyline points="21 5 21 10 16 10"/></svg>
        </button>
      </div>
      <div className="vb-topbar-sep" />
      <div className="vb-device-toggle">
        {['desktop', 'tablet', 'mobile'].map((d) => (
          <button key={d} className={`vb-device-btn${devicePreview === d ? ' is-active' : ''}`} onClick={() => setDevicePreview(d)} title={d}>
            {DEVICE_ICONS[d]}
          </button>
        ))}
      </div>
      <div className="vb-topbar-spacer" />
      <div className="vb-topbar-stats">
        <span>{state.pages.length}p</span>
        <span>·</span>
        <span>{totalFields}f</span>
      </div>
      {msg && <span className="vb-topbar-msg">{msg}</span>}
      {state.dirty && <span className="vb-topbar-unsaved">Unsaved</span>}
      <button className="vb-btn vb-btn-ghost" onClick={() => dispatch({ type: 'RESET' })}>Reset</button>
      <button className="vb-btn vb-btn-primary" style={{ '--accent': accent }} onClick={save} disabled={saving}>
        {saving ? 'Saving...' : 'Publish →'}
      </button>
    </header>
  );
}
