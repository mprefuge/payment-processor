import React, { useState, useRef } from 'react';

const API_BASE = '/api/form-builder/configs';

export default function Topbar({ state, dispatch }) {
  const [library, setLibrary] = useState([]);
  const [libLoaded, setLibLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState('');
  const nameRef = useRef(null);

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
    if (!id) {
      dispatch({ type: 'RESET' });
      return;
    }
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
      const config = buildSavePayload(state);
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

  function buildSavePayload(state) {
    const { formId, selectedPageIdx, selectedFieldId, dirty, ...config } = state;
    config.name = config.name || 'Untitled Form';
    return config;
  }

  const accent = state.branding?.accentColor || '#bd2135';

  return (
    <header className="vb-topbar">
      <div className="vb-topbar-brand">
        Form<span style={{ color: accent }}>Builder</span>
      </div>
      <div className="vb-topbar-sep" />

      {/* Form name */}
      <input
        ref={nameRef}
        className="vb-topbar-name"
        value={state.name}
        onChange={(e) =>
          dispatch({
            type: 'UPDATE_SETTINGS',
            payload: { key: 'root', updates: { name: e.target.value } },
          })
        }
        placeholder="Form name…"
      />

      {/* Library picker */}
      <select
        className="vb-topbar-select"
        defaultValue=""
        onClick={loadLibrary}
        onChange={(e) => loadForm(e.target.value)}
      >
        <option value="">Load saved form…</option>
        {library.map((rec) => (
          <option key={rec.id} value={rec.id}>
            {rec.name || 'Untitled'} ({rec.displayMode || 'embedded'})
          </option>
        ))}
      </select>

      <div className="vb-topbar-spacer" />

      {msg && <span className="vb-topbar-msg">{msg}</span>}
      {state.dirty && <span className="vb-topbar-unsaved">Unsaved changes</span>}

      <button className="vb-btn vb-btn-ghost" onClick={() => dispatch({ type: 'RESET' })}>
        Reset
      </button>
      <button
        className="vb-btn vb-btn-primary"
        style={{ '--accent': accent }}
        onClick={save}
        disabled={saving}
      >
        {saving ? 'Saving…' : 'Publish →'}
      </button>
    </header>
  );
}
