const { getDefaultDonationFormConfig } = require('./defaultDonationFormConfig');
const { getDonationFormRuntimeSource } = require('./runtimeSource');
const path = require('path');
const fs = require('fs');

// If the React builder has been compiled, serve it instead of the legacy inline builder.
function createBuilderPage({ builderEndpoint, saveEndpoint, listEndpoint, configBaseUrl }) {
  const reactDistIndex = path.join(__dirname, 'builder-dist', 'index.html');
  if (fs.existsSync(reactDistIndex)) {
    return fs.readFileSync(reactDistIndex, 'utf-8');
  }
  return _legacyBuilderPage({ builderEndpoint, saveEndpoint, listEndpoint, configBaseUrl });
}

function _legacyBuilderPage({ builderEndpoint, saveEndpoint, listEndpoint, configBaseUrl }) {
  const defaultConfig = JSON.stringify(getDefaultDonationFormConfig());
  const runtimeSource = getDonationFormRuntimeSource();

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Donation Form Builder</title>
  <style>
    @import url('https://fonts.googleapis.com/css2?family=Fraunces:wght@500;600&family=Manrope:wght@400;500;600;700;800&display=swap');

    :root {
      --accent: #bd2135;
      --accent-light: rgba(189,33,53,0.10);
      --accent-ring: rgba(189,33,53,0.32);
      --ink: #18161a;
      --ink-2: #4a4650;
      --ink-3: #8a8490;
      --surface: #ffffff;
      --surface-2: #f7f3ef;
      --surface-3: #ede8e2;
      --border: rgba(24,22,26,0.10);
      --border-strong: rgba(24,22,26,0.18);
      --shadow-sm: 0 2px 8px rgba(24,22,26,0.08);
      --shadow-md: 0 8px 24px rgba(24,22,26,0.10);
      --topbar-h: 54px;
      --shelf-w: 260px;
      --inspector-w: 320px;
      --radius-sm: 8px;
      --radius-md: 12px;
    }

    * { box-sizing: border-box; margin: 0; padding: 0; }
    button, input, select, textarea { font: inherit; color: inherit; }
    button { border: 0; cursor: pointer; background: none; }

    /* ── Top bar ─────────────────────────────────────── */
    .vb-topbar {
      position: fixed; top: 0; left: 0; right: 0; z-index: 100;
      height: var(--topbar-h);
      background: rgba(255,255,255,0.96);
      backdrop-filter: blur(12px);
      border-bottom: 1px solid var(--border);
      display: flex; align-items: center; gap: 12px; padding: 0 16px;
    }
    .vb-topbar-brand { font-family: 'Fraunces', Georgia, serif; font-size: 18px; font-weight: 600; white-space: nowrap; margin-right: 4px; }
    .vb-topbar-brand span { color: var(--accent); }
    .vb-topbar-sep { width: 1px; height: 24px; background: var(--border); }
    .vb-topbar-form-row { display: flex; align-items: center; gap: 8px; flex: 1; min-width: 0; }
    .vb-topbar-select { flex: 1; max-width: 280px; min-width: 120px; border: 1px solid var(--border); border-radius: 8px; padding: 6px 10px; font-size: 13px; font-weight: 500; background: var(--surface); outline: none; }
    .vb-topbar-select:focus { border-color: var(--accent-ring); box-shadow: 0 0 0 3px var(--accent-light); }
    .vb-topbar-actions { display: flex; gap: 6px; margin-left: auto; }
    .vb-btn { border-radius: 8px; padding: 7px 14px; font-size: 13px; font-weight: 700; transition: all 0.14s ease; white-space: nowrap; }
    .vb-btn:hover { transform: translateY(-1px); }
    .vb-btn:disabled { opacity: 0.45; cursor: not-allowed; transform: none; }
    .vb-btn-ghost { border: 1px solid var(--border-strong); background: var(--surface); color: var(--ink-2); }
    .vb-btn-ghost:hover { background: var(--surface-2); }
    .vb-btn-primary { background: var(--accent); color: #fff; box-shadow: 0 4px 16px rgba(189,33,53,0.28); }
    .vb-btn-primary:hover { background: #a51d2d; }

    /* ── Editor body ─────────────────────────────────── */
    .vb-editor { display: flex; height: 100vh; padding-top: var(--topbar-h); }

    /* ── Left shelf ──────────────────────────────────── */
    .vb-shelf { width: var(--shelf-w); flex-shrink: 0; background: var(--surface); border-right: 1px solid var(--border); display: flex; flex-direction: column; overflow: hidden; }

    .vb-shelf-pages { padding: 12px; border-bottom: 1px solid var(--border); }
    .vb-shelf-pages-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px; }
    .vb-shelf-pages-title { font-size: 10px; font-weight: 800; text-transform: uppercase; letter-spacing: 0.12em; color: var(--ink-3); }
    .vb-shelf-add-page { font-size: 11px; font-weight: 700; color: var(--accent); padding: 3px 8px; border-radius: 6px; border: 1px solid var(--accent-ring); }
    .vb-shelf-add-page:hover { background: var(--accent-light); }

    .vb-page-chip { width: 100%; text-align: left; padding: 8px 10px; border-radius: 8px; border: 1px solid transparent; background: none; font-size: 13px; font-weight: 600; display: flex; align-items: center; gap: 8px; cursor: pointer; margin-bottom: 2px; }
    .vb-page-chip:hover { background: var(--surface-2); }
    .vb-page-chip.is-selected { background: var(--accent-light); border-color: var(--accent-ring); color: var(--accent); }
    .vb-page-chip.is-dragging { opacity: 0.4; }
    .vb-page-chip-num { flex-shrink: 0; width: 20px; height: 20px; border-radius: 50%; background: var(--surface-3); font-size: 10px; font-weight: 800; color: var(--ink-2); display: flex; align-items: center; justify-content: center; }
    .vb-page-chip.is-selected .vb-page-chip-num { background: var(--accent); color: #fff; }
    .vb-page-chip-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .vb-page-chip-count { font-size: 10px; color: var(--ink-3); flex-shrink: 0; }

    .vb-shelf-head { padding: 12px 12px 10px; border-bottom: 1px solid var(--border); }
    .vb-shelf-head h2 { font-size: 10px; font-weight: 800; text-transform: uppercase; letter-spacing: 0.12em; color: var(--ink-3); margin-bottom: 8px; }
    .vb-shelf-search { position: relative; }
    .vb-shelf-search-icon { position: absolute; left: 9px; top: 50%; transform: translateY(-50%); color: var(--ink-3); pointer-events: none; font-size: 13px; }
    .vb-shelf-search-input { width: 100%; border: 1px solid var(--border); border-radius: 8px; padding: 7px 10px 7px 30px; font-size: 13px; background: var(--surface-2); outline: none; }
    .vb-shelf-search-input:focus { border-color: var(--accent-ring); background: var(--surface); }

    .vb-shelf-body { flex: 1; overflow-y: auto; padding: 12px; }
    .vb-shelf-section { margin-bottom: 14px; }
    .vb-shelf-section-title { font-size: 10px; font-weight: 800; text-transform: uppercase; letter-spacing: 0.12em; color: var(--ink-3); margin-bottom: 8px; padding: 0 2px; }
    .vb-shelf-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; }
    .vb-shelf-block { display: flex; flex-direction: column; align-items: flex-start; gap: 3px; padding: 10px; border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--surface); cursor: grab; transition: all 0.12s ease; user-select: none; }
    .vb-shelf-block:hover { border-color: var(--border-strong); background: var(--surface-2); transform: translateY(-1px); box-shadow: var(--shadow-sm); }
    .vb-shelf-block:active { cursor: grabbing; }
    .vb-shelf-block.is-disabled { opacity: 0.38; cursor: not-allowed; transform: none; box-shadow: none; }
    .vb-shelf-block-icon { font-size: 20px; line-height: 1; width: 34px; height: 34px; display: flex; align-items: center; justify-content: center; border-radius: 8px; background: var(--surface-2); margin-bottom: 4px; }
    .vb-shelf-block-name { font-size: 12px; font-weight: 700; }
    .vb-shelf-block-desc { font-size: 11px; color: var(--ink-3); line-height: 1.3; }

    /* ── Canvas ──────────────────────────────────────── */
    .vb-canvas-area { flex: 1; min-width: 0; overflow-y: auto; padding: 24px; background: var(--surface-2); }
    .vb-canvas-inner { max-width: 680px; margin: 0 auto; }

    .vb-page-section { margin-bottom: 28px; }
    .vb-page-header { display: flex; align-items: center; gap: 10px; margin-bottom: 10px; }
    .vb-page-header-label { font-size: 10px; font-weight: 800; text-transform: uppercase; letter-spacing: 0.14em; color: var(--ink-3); white-space: nowrap; }
    .vb-page-header-name { font-size: 14px; font-weight: 700; white-space: nowrap; }
    .vb-page-header-line { flex: 1; height: 1px; background: var(--border); }
    .vb-page-header-actions { display: flex; gap: 5px; }
    .vb-page-header-btn { font-size: 11px; font-weight: 700; color: var(--ink-3); padding: 3px 8px; border: 1px solid var(--border); border-radius: 6px; background: var(--surface); }
    .vb-page-header-btn:hover { color: var(--ink); border-color: var(--border-strong); }
    .vb-page-header-btn.danger:hover { color: var(--accent); border-color: var(--accent-ring); background: var(--accent-light); }

    .vb-page-drop-area { border-radius: var(--radius-md); padding: 0; min-height: 56px; display: grid; grid-template-columns: repeat(12, minmax(0, 1fr)); gap: 6px; align-items: start; }
    .vb-page-drop-area.is-empty { border: 2px dashed var(--border); display: flex; align-items: center; justify-content: center; min-height: 80px; border-radius: var(--radius-md); }
    .vb-page-drop-area.drag-over { border-color: var(--accent-ring) !important; background: var(--accent-light) !important; }
    .vb-page-empty-hint { font-size: 13px; color: var(--ink-3); padding: 16px; text-align: center; }

    .vb-drop-zone { grid-column: 1 / -1; height: 6px; border-radius: 4px; margin: 3px 0; transition: all 0.14s ease; }
    .vb-drop-zone.drag-over { height: 34px; margin: 3px 0; border-radius: 8px; background: var(--accent-light); border: 2px dashed var(--accent-ring); }
    .vb-drop-zone.drag-over::after { content: 'Drop here'; display: flex; align-items: center; justify-content: center; height: 100%; font-size: 11px; font-weight: 700; color: var(--accent); }

    .vb-add-page-btn { width: 100%; padding: 12px; border: 2px dashed var(--border); border-radius: var(--radius-md); background: none; color: var(--ink-3); font-size: 13px; font-weight: 600; transition: all 0.14s ease; margin-top: 4px; }
    .vb-add-page-btn:hover { border-color: var(--accent-ring); color: var(--accent); background: var(--accent-light); }

    /* ── Block card ──────────────────────────────────── */
    .vb-block { grid-column: 1 / -1; position: relative; border-radius: var(--radius-md); background: var(--surface); border: 2px solid transparent; transition: border-color 0.12s, box-shadow 0.12s; }
    .vb-block.vb-block-field { grid-column: span var(--vb-field-span, 12); min-width: 0; }
    .vb-block:hover { box-shadow: var(--shadow-md); border-color: var(--border-strong); }
    .vb-block.is-selected { border-color: var(--accent) !important; box-shadow: 0 0 0 3px var(--accent-light); }
    .vb-block.is-disabled { opacity: 0.5; }
    .vb-block.is-dragging { opacity: 0.35; }
    .vb-block.drag-over { outline: 2px dashed var(--accent); outline-offset: 2px; background: var(--accent-light); }

    .vb-block-overlay { position: absolute; top: 8px; right: 8px; display: none; align-items: center; gap: 4px; z-index: 10; }
    .vb-block:hover .vb-block-overlay, .vb-block.is-selected .vb-block-overlay { display: flex; }
    .vb-block-drag-handle { cursor: grab; width: 28px; height: 28px; border-radius: 6px; background: rgba(255,255,255,0.94); border: 1px solid var(--border); display: flex; align-items: center; justify-content: center; font-size: 14px; color: var(--ink-3); }
    .vb-block-drag-handle:active { cursor: grabbing; }
    .vb-block-ovr-btn { width: 28px; height: 28px; border-radius: 6px; background: rgba(255,255,255,0.94); border: 1px solid var(--border); display: flex; align-items: center; justify-content: center; font-size: 13px; cursor: pointer; transition: all 0.1s; }
    .vb-block-ovr-btn:hover { background: #fff; border-color: var(--border-strong); }
    .vb-block-ovr-btn.del:hover { background: #fef2f2; border-color: rgba(239,68,68,0.3); color: #dc2626; }

    .vb-block-preview { padding: 18px 20px; }
    .vb-block-type-badge { display: inline-flex; align-items: center; gap: 5px; font-size: 10px; font-weight: 800; text-transform: uppercase; letter-spacing: 0.1em; color: var(--ink-3); margin-bottom: 10px; }

    /* Block preview types */
    .vbp-hero { text-align: center; padding: 16px 12px; }
    .vbp-hero-logo { width: 52px; height: 52px; border-radius: 14px; background: var(--surface-2); border: 1px solid var(--border); margin: 0 auto 12px; display: flex; align-items: center; justify-content: center; font-size: 22px; }
    .vbp-hero-title { font-family: 'Fraunces', Georgia, serif; font-size: 20px; font-weight: 600; margin-bottom: 6px; }
    .vbp-hero-desc { font-size: 13px; color: var(--ink-2); max-width: 38ch; margin: 0 auto; line-height: 1.6; }
    .vbp-freq-tabs { display: flex; gap: 4px; margin-bottom: 10px; flex-wrap: wrap; }
    .vbp-freq-tab { padding: 4px 11px; border-radius: 20px; font-size: 12px; font-weight: 700; border: 1px solid var(--border); color: var(--ink-2); }
    .vbp-amounts { display: flex; gap: 5px; flex-wrap: wrap; margin-bottom: 10px; }
    .vbp-amount-btn { padding: 6px 13px; border-radius: 8px; font-size: 13px; font-weight: 700; border: 1px solid var(--border); background: var(--surface); color: var(--ink); }
    .vbp-custom { display: flex; align-items: center; gap: 8px; }
    .vbp-custom-sym { font-size: 14px; font-weight: 700; color: var(--ink-3); }
    .vbp-fake-input { flex: 1; height: 36px; border-radius: 8px; border: 1px solid var(--border); background: var(--surface-2); }
    .vbp-fields { display: grid; gap: 7px; }
    .vbp-field-row { display: grid; grid-template-columns: 1fr 1fr; gap: 7px; }
    .vbp-field { height: 36px; border-radius: 8px; border: 1px solid var(--border); background: var(--surface-2); display: flex; align-items: center; padding: 0 11px; font-size: 12px; color: var(--ink-3); }
    .vbp-content-body { font-size: 14px; line-height: 1.65; color: var(--ink-2); border-left: 3px solid var(--accent-ring); padding-left: 12px; }
    .vbp-toggle-row { display: flex; align-items: center; gap: 9px; height: 36px; border-radius: 8px; border: 1px solid var(--border); padding: 0 11px; background: var(--surface-2); }
    .vbp-fake-cb { width: 15px; height: 15px; border-radius: 4px; border: 1px solid var(--border); background: var(--surface); flex-shrink: 0; }
    .vbp-toggle-lbl { font-size: 13px; color: var(--ink-2); }
    .vbp-submit-wrap { text-align: center; padding: 10px 0; }
    .vbp-total { font-size: 13px; color: var(--ink-3); margin-bottom: 10px; }
    .vbp-total strong { font-size: 20px; color: var(--ink); font-family: 'Fraunces', Georgia, serif; }
    .vbp-submit-btn { display: inline-block; padding: 12px 32px; border-radius: 999px; color: #fff; font-size: 14px; font-weight: 800; box-shadow: 0 8px 22px rgba(189,33,53,0.28); }

    /* ── Inspector ───────────────────────────────────── */
    .vb-inspector { width: var(--inspector-w); flex-shrink: 0; background: var(--surface); border-left: 1px solid var(--border); display: flex; flex-direction: column; overflow: hidden; transition: margin-right 0.22s ease; }
    .vb-inspector.is-hidden { margin-right: calc(-1 * var(--inspector-w)); }
    .vb-inspector-tabs { display: flex; border-bottom: 1px solid var(--border); }
    .vb-inspector-tab { flex: 1; padding: 13px 6px; font-size: 12px; font-weight: 700; color: var(--ink-3); border-bottom: 2px solid transparent; transition: all 0.12s; }
    .vb-inspector-tab:hover { color: var(--ink); }
    .vb-inspector-tab.is-active { color: var(--accent); border-bottom-color: var(--accent); }
    .vb-inspector-body { flex: 1; overflow-y: auto; padding: 14px; }
    .vb-tab-panel { display: none; }
    .vb-tab-panel.is-active { display: block; }

    .vb-field { display: grid; gap: 5px; margin-bottom: 11px; }
    .vb-label { font-size: 10px; font-weight: 800; text-transform: uppercase; letter-spacing: 0.1em; color: var(--ink-3); }
    .vb-input, .vb-textarea, .vb-select { width: 100%; border: 1px solid var(--border); border-radius: 8px; padding: 7px 10px; font-size: 13px; background: var(--surface); outline: none; }
    .vb-input:focus, .vb-textarea:focus, .vb-select:focus { border-color: var(--accent-ring); box-shadow: 0 0 0 3px var(--accent-light); }
    .vb-textarea { min-height: 76px; resize: vertical; }
    .vb-toggle-setting { display: flex; align-items: center; justify-content: space-between; padding: 9px 11px; border: 1px solid var(--border); border-radius: 8px; background: var(--surface-2); margin-bottom: 7px; }
    .vb-toggle-setting label { font-size: 13px; font-weight: 600; cursor: pointer; }
    .vb-toggle-setting input[type="checkbox"] { width: 16px; height: 16px; accent-color: var(--accent); }
    .vb-divider { height: 1px; background: var(--border); margin: 14px 0; }
    .vb-section-head { font-size: 10px; font-weight: 800; text-transform: uppercase; letter-spacing: 0.12em; color: var(--ink-3); margin-bottom: 9px; }
    .vb-grid-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
    .vb-color-row { display: flex; align-items: center; gap: 7px; }
    .vb-color-row .vb-input { flex: 1; }
    .vb-color-row input[type="color"] { width: 34px; height: 34px; border-radius: 8px; border: 1px solid var(--border); padding: 2px; cursor: pointer; flex-shrink: 0; }
    .vb-insp-actions { display: grid; grid-template-columns: 1fr 1fr; gap: 7px; margin-top: 14px; }
    .vb-insp-action { padding: 7px; border-radius: 8px; font-size: 12px; font-weight: 700; border: 1px solid var(--border); background: var(--surface); color: var(--ink-2); transition: all 0.12s; }
    .vb-insp-action:hover { border-color: var(--border-strong); background: var(--surface-2); }
    .vb-insp-action.danger:hover { border-color: rgba(239,68,68,0.3); color: #dc2626; background: #fef2f2; }
    .vb-insp-empty { padding: 24px 0; text-align: center; color: var(--ink-3); font-size: 13px; line-height: 1.6; }

    .vb-preview-surface { background: var(--surface-2); border-radius: var(--radius-md); padding: 12px; margin-top: 4px; }
    .vb-result { display: none; padding: 12px; border: 1px solid rgba(189,33,53,0.18); border-radius: var(--radius-md); background: #fff9f6; margin-top: 12px; }
    .vb-result.is-visible { display: block; }
    .vb-code { margin-top: 6px; padding: 9px; border-radius: 7px; background: #211d20; color: #f8f2ef; font-family: Consolas, monospace; font-size: 11px; white-space: pre-wrap; overflow: auto; max-height: 140px; }
  </style>
</head>
<body>

<header class="vb-topbar">
  <div class="vb-topbar-brand">Form<span>Builder</span> <small style="font-family:Manrope,sans-serif;font-size:11px;font-weight:600;color:var(--ink-3);letter-spacing:0.04em;vertical-align:middle;">Visual Editor</small></div>
  <div class="vb-topbar-sep"></div>
  <div class="vb-topbar-form-row">
    <select class="vb-topbar-select" id="vb-form-library"><option value="">New form&hellip;</option></select>
    <button class="vb-btn vb-btn-ghost" id="vb-load-form">Load</button>
    <button class="vb-btn vb-btn-ghost" id="vb-delete-form">Delete</button>
  </div>
  <div class="vb-topbar-actions">
    <button class="vb-btn vb-btn-ghost" id="vb-reset">Reset</button>
    <button class="vb-btn vb-btn-primary" id="vb-publish">Publish &rarr;</button>
  </div>
</header>

<div class="vb-editor">
  <aside class="vb-shelf">
    <div class="vb-shelf-pages">
      <div class="vb-shelf-pages-head">
        <span class="vb-shelf-pages-title">Pages</span>
        <button class="vb-shelf-add-page" id="vb-add-page">+ Add</button>
      </div>
      <div id="vb-page-nav"></div>
    </div>
    <div class="vb-shelf-head">
      <h2>Blocks</h2>
      <div class="vb-shelf-search">
        <span class="vb-shelf-search-icon">&#128269;</span>
        <input class="vb-shelf-search-input" type="search" id="vb-search" placeholder="Search blocks&hellip;" />
      </div>
    </div>
    <div class="vb-shelf-body" id="vb-shelf-body"></div>
  </aside>

  <main class="vb-canvas-area">
    <div class="vb-canvas-inner" id="vb-canvas"></div>
  </main>

  <aside class="vb-inspector is-hidden" id="vb-inspector">
    <div class="vb-inspector-tabs">
      <button class="vb-inspector-tab is-active" data-tab="block">Block</button>
      <button class="vb-inspector-tab" data-tab="settings">Settings</button>
      <button class="vb-inspector-tab" data-tab="preview">Preview</button>
    </div>
    <div class="vb-inspector-body">
      <div class="vb-tab-panel is-active" id="vb-tab-block">
        <div id="vb-block-insp"></div>
      </div>

      <div class="vb-tab-panel" id="vb-tab-settings">
        <div class="vb-section-head">Identity</div>
        <div class="vb-field"><label class="vb-label">Form Name</label><input class="vb-input" id="gs-name" /></div>
        <div class="vb-field"><label class="vb-label">Organization Name</label><input class="vb-input" id="gs-org-name" /></div>
        <div class="vb-field"><label class="vb-label">Hero Title</label><input class="vb-input" id="gs-title" /></div>
        <div class="vb-field"><label class="vb-label">Hero Description</label><textarea class="vb-textarea" id="gs-description"></textarea></div>
        <div class="vb-grid-2">
          <div class="vb-field"><label class="vb-label">Logo URL</label><input class="vb-input" id="gs-logo-url" /></div>
          <div class="vb-field"><label class="vb-label">Accent Color</label>
            <div class="vb-color-row"><input class="vb-input" id="gs-accent-text" placeholder="#bd2135" /><input type="color" id="gs-accent-color" /></div>
          </div>
        </div>
        <div class="vb-divider"></div>
        <div class="vb-section-head">Display</div>
        <div class="vb-field"><label class="vb-label">Display Mode</label>
          <select class="vb-select" id="gs-display-mode"><option value="embedded">Embedded</option><option value="modal">Modal Popup</option></select>
        </div>
        <div class="vb-field"><label class="vb-label">Modal Trigger Label</label><input class="vb-input" id="gs-modal-label" /></div>
        <div class="vb-field"><label class="vb-label">Submit Button Label</label><input class="vb-input" id="gs-submit-label" /></div>
        <div class="vb-divider"></div>
        <div class="vb-section-head">Payment</div>
        <div class="vb-field"><label class="vb-label">Transaction API URL</label><input class="vb-input" id="gs-api-url" /></div>
        <div class="vb-grid-2">
          <div class="vb-field"><label class="vb-label">Default Frequency</label>
            <select class="vb-select" id="gs-frequency">
              <option value="onetime">One-Time</option><option value="month">Monthly</option>
              <option value="biweek">Bi-Weekly</option><option value="week">Weekly</option><option value="year">Yearly</option>
            </select>
          </div>
          <div class="vb-field"><label class="vb-label">Preset Amounts</label><input class="vb-input" id="gs-amounts" placeholder="500,100,50,25" /></div>
        </div>
        <div class="vb-field"><label class="vb-label">Categories (one per line)</label><textarea class="vb-textarea" id="gs-categories"></textarea></div>
        <div class="vb-divider"></div>
        <div class="vb-section-head">Options</div>
        <div class="vb-toggle-setting"><label for="gs-recurring">Allow recurring gifts</label><input type="checkbox" id="gs-recurring" /></div>
        <div class="vb-toggle-setting"><label for="gs-org-giving">Organization giving</label><input type="checkbox" id="gs-org-giving" /></div>
        <div class="vb-toggle-setting"><label for="gs-address">Collect address</label><input type="checkbox" id="gs-address" /></div>
        <div class="vb-toggle-setting"><label for="gs-tribute">Tribute gifts</label><input type="checkbox" id="gs-tribute" /></div>
        <div class="vb-toggle-setting"><label for="gs-fees">Cover-fee option</label><input type="checkbox" id="gs-fees" /></div>
      </div>

      <div class="vb-tab-panel" id="vb-tab-preview">
        <div class="vb-preview-surface"><div id="vb-preview-root"></div></div>
        <div class="vb-result" id="vb-result">
          <strong style="font-size:12px">Config URL</strong>
          <div id="vb-config-url" style="font-size:12px;margin:4px 0 10px;word-break:break-all"></div>
          <strong style="font-size:12px">Embedded Snippet</strong>
          <div class="vb-code" id="vb-snip-embedded"></div>
          <strong style="font-size:12px;display:block;margin-top:10px">Modal Snippet</strong>
          <div class="vb-code" id="vb-snip-modal"></div>
        </div>
      </div>
    </div>
  </aside>
</div>

<script>
  ${runtimeSource}
</script>
<script>
(function () {
  var DEFAULT_CONFIG = ${defaultConfig};
  var BUILDER_ENDPOINT = ${JSON.stringify(builderEndpoint)};
  var SAVE_ENDPOINT    = ${JSON.stringify(saveEndpoint)};
  var LIST_ENDPOINT    = ${JSON.stringify(listEndpoint || saveEndpoint)};
  var CONFIG_BASE_URL  = ${JSON.stringify(configBaseUrl)};

  var BLOCK_CATALOG = [
    { category: 'Structure', blocks: [
      { type: 'hero',    icon: '\\uD83C\\uDFDB', name: 'Hero',             desc: 'Logo, title & intro copy' },
      { type: 'content', icon: '\\uD83D\\uDCDD', name: 'Text Block',       desc: 'Free-form narrative copy', allowMultiple: true },
    ]},
    { category: 'Donation', blocks: [
      { type: 'amount',  icon: '\\uD83D\\uDCB0', name: 'Donation Details', desc: 'Amount, frequency & designation' },
      { type: 'address', icon: '\\uD83D\\uDCCD', name: 'Address',          desc: 'Mailing address fields' },
      { type: 'tribute', icon: '\\uD83D\\uDD4A',  name: 'Tribute',          desc: 'Honor or memory gift' },
      { type: 'fees',    icon: '\\uD83E\\uDDFE', name: 'Processing Fees',  desc: 'Cover-fee & payment method' },
      { type: 'submit',  icon: '\\u2705',        name: 'Submit',           desc: 'Review total & submit' },
    ]},
    { category: 'Fields', blocks: [
      { type: 'field_firstName', icon: '\\uD83D\\uDC64', name: 'First Name', desc: 'Single-line input', allowMultiple: true },
      { type: 'field_lastName',  icon: '\\uD83D\\uDC64', name: 'Last Name',  desc: 'Single-line input', allowMultiple: true },
      { type: 'field_email',     icon: '\\u2709\\uFE0F', name: 'Email',      desc: 'Email input', allowMultiple: true },
      { type: 'field_phone',     icon: '\\u260E\\uFE0F', name: 'Phone',      desc: 'Phone input', allowMultiple: true },
      { type: 'field_text',      icon: '\\uD83D\\uDDE8', name: 'Text Field', desc: 'Custom single-line input', allowMultiple: true },
      { type: 'field_textarea',  icon: '\\uD83D\\uDCDD', name: 'Text Area',  desc: 'Multi-line text input', allowMultiple: true },
      { type: 'field_dropdown',  icon: '\\u25BE',          name: 'Dropdown',   desc: 'Select from options', allowMultiple: true },
    ]}
  ];

  /* ─── state ──────────────────────────────────────────── */
  var S = {
    bs: null,
    configId: null,
    selPageId: null,
    selSectionId: null,
    activeTab: 'block',
    drag: null,          // { kind:'library'|'block'|'page', type, sectionId, pageId }
    suppressClickUntil: 0,
    q: '',
  };

  /* ─── DOM refs ───────────────────────────────────────── */
  var elPageNav  = document.getElementById('vb-page-nav');
  var elShelf    = document.getElementById('vb-shelf-body');
  var elCanvas   = document.getElementById('vb-canvas');
  var elInspector= document.getElementById('vb-inspector');
  var elBlockInsp= document.getElementById('vb-block-insp');
  var elPreview  = document.getElementById('vb-preview-root');
  var elResult   = document.getElementById('vb-result');
  var elLibrary  = document.getElementById('vb-form-library');

  /* ─── helpers ────────────────────────────────────────── */
  function clone(v) { return v === undefined ? v : JSON.parse(JSON.stringify(v)); }
  function esc(v) { return String(v==null?'':v).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;'); }
  function readLines(v) { return String(v||'').split(/\\r?\\n/).map(function(s){return s.trim();}).filter(Boolean); }
  function readAmounts(v) { return String(v||'').split(',').map(function(s){return Number(s.trim());}).filter(function(n){return Number.isFinite(n)&&n>0;}); }
  function trimSlash(v) { return v && v.charAt(v.length-1)==='/' ? v.slice(0,-1) : (v||''); }
  function createId(p) { return p+'_'+Date.now().toString(36)+'_'+Math.random().toString(36).slice(2,7); }
  function getSectionType(s) { return s&&(s.type||s.id)?String(s.type||s.id):'content'; }
  function getSectionById(id) { return (S.bs.sections||[]).find(function(s){return s.id===id;})||null; }
  function getPageById(id) { return (S.bs.pages||[]).find(function(p){return p.id===id;})||null; }
  function getPageContainingSection(sectionId) {
    return (S.bs.pages||[]).find(function(page){ return Array.isArray(page.sectionIds) && page.sectionIds.indexOf(sectionId)!==-1; })||null;
  }
  function suppressClickFor(ms) {
    var windowMs = Number(ms);
    if(!Number.isFinite(windowMs) || windowMs<0) windowMs = 250;
    S.suppressClickUntil = Math.max(S.suppressClickUntil||0, Date.now() + windowMs);
  }
  function clickSuppressed() {
    return Date.now() < (S.suppressClickUntil||0);
  }
  function getDefaultSectionByType(type) { return (DEFAULT_CONFIG.sections||[]).find(function(s){return(s.type||s.id)===type;})||null; }
  function getBlockMeta(type) {
    for (var ci=0;ci<BLOCK_CATALOG.length;ci++) {
      var cat=BLOCK_CATALOG[ci];
      for (var bi=0;bi<cat.blocks.length;bi++) { if(cat.blocks[bi].type===type) return cat.blocks[bi]; }
    }
    return {type:type,icon:'\\u25A1',name:type,desc:''};
  }
  function isFieldType(type) { return String(type||'').indexOf('field_')===0; }
  function fieldSupportsTypeSelection(type) { return String(type||'')==='field_text'; }
  function defaultFieldSettingsForType(type) {
    if(type==='field_firstName') return { fieldKey:'firstName', inputType:'text', placeholder:'', required:true };
    if(type==='field_lastName') return { fieldKey:'lastName', inputType:'text', placeholder:'', required:true };
    if(type==='field_email') return { fieldKey:'email', inputType:'email', placeholder:'', required:true };
    if(type==='field_phone') return { fieldKey:'phone', inputType:'tel', placeholder:'', required:true };
    if(type==='field_dropdown') return { fieldKey:createId('field'), inputType:'select', placeholder:'', required:false, options:['Option 1','Option 2'] };
    if(type==='field_textarea') return { fieldKey:createId('field'), inputType:'textarea', placeholder:'', required:false };
    return { fieldKey:createId('field'), inputType:'text', placeholder:'', required:false };
  }
  function normalizeFieldSettings(type, settings) {
    var base=defaultFieldSettingsForType(type);
    var src=settings&&typeof settings==='object'?settings:{};
    var key=String(src.fieldKey||base.fieldKey||'').trim().replace(/[^a-zA-Z0-9_]/g,'_');
    if(!key) key=createId('field');
    var inputType=String(src.inputType||base.inputType||'text');
    var normalized={
      fieldKey:key,
      inputType:inputType,
      placeholder:src.placeholder?String(src.placeholder):'',
      required:src.required===true,
    };
    if(inputType==='select'){
      var opts=Array.isArray(src.options)?src.options.map(function(v){return String(v).trim();}).filter(Boolean):[];
      if(!opts.length&&Array.isArray(base.options)) opts=base.options.slice();
      normalized.options=opts;
    }
    return normalized;
  }
  function createNamedFieldSection(type, label, description) {
    var meta=getBlockMeta(type);
    return {
      id:createId('field'),
      type:type,
      label:label||meta.name||'Field',
      description:description||meta.desc||'',
      enabled:true,
      settings:normalizeFieldSettings(type,{}),
    };
  }
  function placeholderContentFieldType(section) {
    if(!section||String(section.type||'')!=='content') return '';
    var normalizedLabel=String(section.label||'').trim().toLowerCase();
    var normalizedDesc=String(section.description||'').trim().toLowerCase();
    var bodyText=section.settings&&section.settings.body?String(section.settings.body):'';
    var looksLikePlaceholder=/add\\s+supporting\\s+copy\\s+for\\s+this\\s+step\\.?/i.test(bodyText);
    if(!looksLikePlaceholder) return '';
    if(normalizedLabel==='first name') return 'field_firstName';
    if(normalizedLabel==='last name') return 'field_lastName';
    if(normalizedLabel==='email') return 'field_email';
    if(normalizedLabel==='phone') return 'field_phone';
    if(normalizedLabel==='dropdown') return 'field_dropdown';
    if(normalizedLabel==='text field') return 'field_text';
    if(normalizedLabel==='text area'||normalizedLabel==='textarea') return 'field_textarea';
    if(normalizedDesc==='single-line input') return 'field_text';
    if(normalizedDesc==='multi-line text input') return 'field_textarea';
    if(normalizedDesc==='select from options') return 'field_dropdown';
    return '';
  }
  function expandLegacySection(section, type) {
    if(type==='donor'){
      var explicitTypes=arguments[2]||{};
      var donorFields=[
        { type:'field_firstName', label:'First Name' },
        { type:'field_lastName', label:'Last Name' },
        { type:'field_email', label:'Email' },
        { type:'field_phone', label:'Phone' },
      ].filter(function(entry){ return !explicitTypes[entry.type]; })
        .map(function(entry){ return createNamedFieldSection(entry.type,entry.label,''); });
      return donorFields;
    }
    return null;
  }
  function createSectionFromType(type) {
    if(type==='content'){
      return {id:createId('content'),type:'content',label:'Text Block',description:'Supporting copy block.',enabled:true,settings:{body:'Add supporting copy for this step.'}};
    }
    if(isFieldType(type)){
      var m=getBlockMeta(type);
      return {
        id:createId('field'),
        type:type,
        label:m.name||'Field',
        description:m.desc||'',
        enabled:true,
        settings:normalizeFieldSettings(type,{}),
      };
    }
    return clone(getDefaultSectionByType(type));
  }

  /* ─── normalizer ─────────────────────────────────────── */
  function ensureEditorModel(rawConfig) {
    var config = window.DonationFormRuntime.normalizeConfig(clone(rawConfig||DEFAULT_CONFIG));
    var defSections = clone(DEFAULT_CONFIG.sections||[]);
    var sections=[]; var seenIds={};
    var sourceToNewSectionIds={};
    var explicitFieldTypes={};
    (Array.isArray(config.sections)&&config.sections.length?config.sections:defSections).forEach(function(section){
      var inferredType=placeholderContentFieldType(section);
      if(inferredType) explicitFieldTypes[inferredType]=true;
      if(section&&isFieldType(section.type)) explicitFieldTypes[String(section.type)]=true;
    });
    (Array.isArray(config.sections)&&config.sections.length?config.sections:defSections).forEach(function(section){
      if(!section||typeof section!=='object') return;
      var fb=getDefaultSectionByType(section.type||section.id);
      var type=String(section.type||(fb?fb.type||fb.id:'content'));
      var inferredFieldType=placeholderContentFieldType(section);
      if(inferredFieldType) type=inferredFieldType;
      var id=section.id||(type==='content'?createId('content'):type);
      var expanded=expandLegacySection(section,type,explicitFieldTypes);
      if(expanded){
        sourceToNewSectionIds[id]=expanded.map(function(s){return s.id;});
        if(!expanded.length) return;
        expanded.forEach(function(s){
          if(seenIds[s.id]) return;
          sections.push(s);
          seenIds[s.id]=true;
        });
        return;
      }
      if(seenIds[id]) return;
      var normalizedSettings=section.settings&&typeof section.settings==='object'?clone(section.settings):undefined;
      var normalizedDescription=section.description||(fb?fb.description:'Supporting copy.');
      if(type==='content'){
        normalizedSettings={body:section.settings&&section.settings.body?String(section.settings.body):'Add supporting copy for this step.'};
      } else if(isFieldType(type)){
        normalizedSettings=normalizeFieldSettings(type,normalizedSettings);
        if(/name,\\s*email,\\s*and\\s*phone\\s*collection\\.?/i.test(String(normalizedDescription||''))){
          normalizedDescription='';
        }
      }
      sections.push({id:id,type:type,label:section.label||(fb?fb.label:'Text Block'),description:normalizedDescription,enabled:section.enabled!==false,settings:normalizedSettings});
      seenIds[id]=true;
      sourceToNewSectionIds[id]=[id];
    });
    config.sections=sections;
    var validIds={}; sections.forEach(function(s){validIds[s.id]=true;});
    var pages=(Array.isArray(config.pages)&&config.pages.length?config.pages:clone(DEFAULT_CONFIG.pages||[]))
      .map(function(page,i){
        var expandedIds=[];
        if(Array.isArray(page.sectionIds)){
          page.sectionIds.forEach(function(rawId){
            var mapped=sourceToNewSectionIds[rawId]||[rawId];
            mapped.forEach(function(mid){expandedIds.push(mid);});
          });
        }
        var sids=expandedIds.filter(function(id,j,a){return validIds[id]&&a.indexOf(id)===j;});
        return {id:page.id||createId('page'),name:page.name||('Page '+(i+1)),description:page.description||'',sectionIds:sids};
      })
      .filter(function(page,i,a){return a.findIndex(function(p){return p.id===page.id;})===i;});
    if(!pages.length) pages=[{id:createId('page'),name:'Page 1',description:'',sectionIds:[]}];
    var assigned={};
    pages.forEach(function(page){page.sectionIds=page.sectionIds.filter(function(id){if(assigned[id])return false;assigned[id]=true;return true;});});
    sections.forEach(function(s){if(!assigned[s.id])pages[pages.length-1].sectionIds.push(s.id);});
    config.pages=pages; return config;
  }

  /* ─── mutations ──────────────────────────────────────── */
  function selectPage(pageId) { S.selPageId=pageId; S.selSectionId=null; showInspector(); render(); switchTab('block'); }
  function selectSection(pageId,sectionId) { S.selPageId=pageId; S.selSectionId=sectionId; showInspector(); render(); switchTab('block'); }
  function showInspector() { elInspector.classList.remove('is-hidden'); }

  function addPage() {
    var page={id:createId('page'),name:'New Page',description:'',sectionIds:[]};
    S.bs.pages.push(page); S.selPageId=page.id; S.selSectionId=null; showInspector(); render();
  }

  function addSectionToPage(type,pageId,beforeSectionId) {
    var targetPage=getPageById(pageId||S.selPageId)||S.bs.pages[0]; if(!targetPage) return;
    var section;
    if(type==='content'||isFieldType(type)){
      section=createSectionFromType(type);
      if(!section) return;
      S.bs.sections.push(section);
    } else {
      section=S.bs.sections.find(function(s){return getSectionType(s)===type;})||createSectionFromType(type);
      if(!section) return;
      if(!getSectionById(section.id)) S.bs.sections.push(section);
    }
    if(targetPage.sectionIds.indexOf(section.id)===-1){
      var insertAt=beforeSectionId?targetPage.sectionIds.indexOf(beforeSectionId):-1;
      if(insertAt<0) targetPage.sectionIds.push(section.id);
      else targetPage.sectionIds.splice(insertAt,0,section.id);
    }
    S.selPageId=targetPage.id; S.selSectionId=section.id; showInspector(); render(); switchTab('block');
  }

  function removeSection(sectionId,pageId) {
    S.bs.pages.forEach(function(page){page.sectionIds=page.sectionIds.filter(function(id){return id!==sectionId;});});
    var s=getSectionById(sectionId);
    if(s&&(getSectionType(s)==='content'||isFieldType(getSectionType(s)))) S.bs.sections=S.bs.sections.filter(function(x){return x.id!==sectionId;});
    if(S.selSectionId===sectionId) S.selSectionId=null;
    S.selPageId=pageId||S.selPageId; render();
  }

  function duplicateSection(sectionId,pageId) {
    var src=getSectionById(sectionId); var page=getPageById(pageId);
    if(!src||!page||getSectionType(src)!=='content') return;
    var dup=clone(src); dup.id=createId('content'); dup.label=dup.label+' Copy';
    S.bs.sections.push(dup); var idx=page.sectionIds.indexOf(sectionId); page.sectionIds.splice(idx+1,0,dup.id);
    S.selSectionId=dup.id; render();
  }

  function removePage(pageId) {
    if(S.bs.pages.length<=1) return;
    var idx=S.bs.pages.findIndex(function(p){return p.id===pageId;}); if(idx<0) return;
    var removed=S.bs.pages.splice(idx,1)[0];
    var dest=S.bs.pages[Math.max(0,idx-1)]||S.bs.pages[0];
    if(dest&&removed.sectionIds.length) dest.sectionIds=dest.sectionIds.concat(removed.sectionIds.filter(function(id){return dest.sectionIds.indexOf(id)===-1;}));
    S.selPageId=dest?dest.id:null; S.selSectionId=null; render();
  }

  function moveSection(sectionId,fromPageId,toPageId,beforeSectionId) {
    if(!sectionId) return;
    var fromPage=getPageById(fromPageId)||getPageContainingSection(sectionId);
    var toPage=getPageById(toPageId)||fromPage;
    if(!fromPage||!toPage) return;

    var removed=false;
    (S.bs.pages||[]).forEach(function(page){
      var beforeCount=Array.isArray(page.sectionIds)?page.sectionIds.length:0;
      page.sectionIds=(page.sectionIds||[]).filter(function(id){return id!==sectionId;});
      if(page.sectionIds.length!==beforeCount) removed=true;
    });
    if(!removed) return;

    var insertAt=beforeSectionId?toPage.sectionIds.indexOf(beforeSectionId):-1;
    if(insertAt<0) toPage.sectionIds.push(sectionId);
    else toPage.sectionIds.splice(insertAt,0,sectionId);

    S.selPageId=toPage.id; S.selSectionId=sectionId; render();
  }

  function movePage(draggedId,targetId) {
    if(!draggedId||!targetId||draggedId===targetId) return;
    var from=S.bs.pages.findIndex(function(p){return p.id===draggedId;});
    var to=S.bs.pages.findIndex(function(p){return p.id===targetId;});
    if(from<0||to<0) return;
    var moved=S.bs.pages.splice(from,1)[0]; S.bs.pages.splice(to,0,moved); render();
  }

  /* ─── block preview HTML ─────────────────────────────── */
  function blockPreview(section,ac) {
    var type=getSectionType(section);
    ac=ac||'#bd2135';
    if(type==='hero'){
      var title=S.bs.branding&&S.bs.branding.title?S.bs.branding.title:'Support Our Mission';
      var desc=S.bs.branding&&S.bs.branding.description?S.bs.branding.description.slice(0,100):'Your generosity makes a difference.';
      return '<div class="vbp-hero"><div class="vbp-hero-logo">\\uD83C\\uDFDB</div><div class="vbp-hero-title">'+esc(title)+'</div><div class="vbp-hero-desc">'+esc(desc)+'</div></div>';
    }
    if(type==='amount'){
      var amounts=S.bs.payment&&S.bs.payment.amountPresets?S.bs.payment.amountPresets:[500,100,50,25];
      var btns=amounts.slice(0,4).map(function(a,i){return '<span class="vbp-amount-btn"'+(i===1?' style="background:'+ac+';color:#fff;border-color:transparent"':'')+'>$'+a+'</span>';}).join('');
      return '<div><div class="vbp-freq-tabs"><span class="vbp-freq-tab" style="background:'+ac+';color:#fff;border-color:transparent">One-Time</span><span class="vbp-freq-tab">Monthly</span><span class="vbp-freq-tab">Bi-Weekly</span></div><div class="vbp-amounts">'+btns+'</div><div class="vbp-custom"><span class="vbp-custom-sym">$</span><div class="vbp-fake-input"></div></div></div>';
    }
    if(type==='donor') return '<div class="vbp-fields"><div class="vbp-field-row"><div class="vbp-field">First name</div><div class="vbp-field">Last name</div></div><div class="vbp-field">Email address</div><div class="vbp-field">Phone number</div></div>';
    if(type==='address') return '<div class="vbp-fields"><div class="vbp-field">Street address</div><div class="vbp-field-row"><div class="vbp-field">City</div><div class="vbp-field">State / ZIP</div></div></div>';
    if(type==='tribute') return '<div class="vbp-fields"><div class="vbp-toggle-row"><div class="vbp-fake-cb"></div><span class="vbp-toggle-lbl">This gift is in honor or memory of someone</span></div><div class="vbp-field" style="color:#ccc;margin-top:2px">Honoree name</div></div>';
    if(type==='fees') return '<div class="vbp-fields"><div class="vbp-toggle-row"><div class="vbp-fake-cb" style="background:'+ac+';border-color:'+ac+'"></div><span class="vbp-toggle-lbl">I\\'ll cover the processing fee</span></div><div class="vbp-field-row" style="margin-top:4px"><div class="vbp-field">Card number</div><div class="vbp-field">MM / YY &middot; CVC</div></div></div>';
    if(type==='submit'){
      var lbl=S.bs.branding&&S.bs.branding.submitLabel?S.bs.branding.submitLabel:'Continue';
      return '<div class="vbp-submit-wrap"><div class="vbp-total">Your gift <strong>$100</strong></div><div class="vbp-submit-btn" style="background:'+ac+'">'+esc(lbl)+'</div></div>';
    }
    if(type==='content'){
      var body=section.settings&&section.settings.body?section.settings.body:'Add supporting copy for this step.';
      return '<div class="vbp-content-body" style="border-left-color:'+ac+'">'+esc(body.slice(0,200))+'</div>';
    }
    if(isFieldType(type)){
      var fs=normalizeFieldSettings(type,section.settings||{});
      var label=section.label||'Field';
      if(fs.inputType==='select'){
        var opts=(Array.isArray(fs.options)?fs.options:['Option 1','Option 2']).slice(0,2).map(function(opt){return '<span class="vbp-freq-tab">'+esc(opt)+'</span>';}).join('');
        return '<div class="vbp-fields"><div class="vbp-field" style="background:#fff;color:#6a6470">'+esc(label)+'</div><div class="vbp-freq-tabs" style="margin-top:6px">'+opts+'</div></div>';
      }
      if(fs.inputType==='textarea'){
        return '<div class="vbp-fields"><div class="vbp-field" style="background:#fff;color:#6a6470">'+esc(label)+'</div><div class="vbp-field" style="height:52px;margin-top:6px;background:#fff"></div></div>';
      }
      return '<div class="vbp-fields"><div class="vbp-field" style="background:#fff;color:#6a6470">'+esc(label)+(fs.required?' *':'')+'</div></div>';
    }
    return '<div style="color:var(--ink-3);font-size:13px">'+esc(type)+' block</div>';
  }

  /* ─── render: page nav ───────────────────────────────── */
  function renderPageNav() {
    var html='';
    S.bs.pages.forEach(function(page,i){
      html+='<div class="vb-page-chip'+(page.id===S.selPageId?' is-selected':'')+'" draggable="true" data-page-nav-id="'+esc(page.id)+'">'
        +'<span class="vb-page-chip-num">'+(i+1)+'</span>'
        +'<span class="vb-page-chip-name">'+esc(page.name)+'</span>'
        +'<span class="vb-page-chip-count">'+page.sectionIds.length+'</span>'
        +'</div>';
    });
    elPageNav.innerHTML=html;
  }

  /* ─── render: shelf ──────────────────────────────────── */
  function renderShelf() {
    var q=S.q.toLowerCase(); var html='';
    BLOCK_CATALOG.forEach(function(cat){
      var filtered=cat.blocks.filter(function(b){return !q||b.name.toLowerCase().indexOf(q)>=0||b.desc.toLowerCase().indexOf(q)>=0;});
      if(!filtered.length) return;
      html+='<div class="vb-shelf-section"><div class="vb-shelf-section-title">'+esc(cat.category)+'</div><div class="vb-shelf-grid">';
      filtered.forEach(function(b){
        var exists=S.bs.pages.some(function(page){return page.sectionIds.some(function(sid){var s=getSectionById(sid);return s&&getSectionType(s)===b.type;});});
        var disabled=!b.allowMultiple&&b.type!=='content'&&exists;
        html+='<div class="vb-shelf-block'+(disabled?' is-disabled':'')+'" draggable="'+(disabled?'false':'true')+'" data-shelf-type="'+esc(b.type)+'" title="'+esc(b.name)+': '+esc(b.desc)+'">'
          +'<div class="vb-shelf-block-icon">'+b.icon+'</div>'
          +'<span class="vb-shelf-block-name">'+esc(b.name)+'</span>'
          +'<span class="vb-shelf-block-desc">'+esc(b.desc)+'</span>'
          +'</div>';
      });
      html+='</div></div>';
    });
    elShelf.innerHTML=html||'<div style="padding:10px 2px;font-size:13px;color:var(--ink-3)">No blocks match.</div>';
  }

  /* ─── render: canvas ─────────────────────────────────── */
  function renderCanvas() {
    var ac=(S.bs.branding&&S.bs.branding.accentColor)||'#bd2135';
    var html='';
    S.bs.pages.forEach(function(page,pi){
      html+='<div class="vb-page-section" data-page-section="'+esc(page.id)+'">'
        +'<div class="vb-page-header">'
          +'<span class="vb-page-header-label">Page '+(pi+1)+'</span>'
          +'<span class="vb-page-header-name">'+esc(page.name)+'</span>'
          +'<div class="vb-page-header-line"></div>'
          +'<div class="vb-page-header-actions">'
            +'<button class="vb-page-header-btn" data-action="select-page" data-page-id="'+esc(page.id)+'">Edit</button>'
            +(S.bs.pages.length>1?'<button class="vb-page-header-btn danger" data-action="remove-page" data-page-id="'+esc(page.id)+'">Remove</button>':'')
          +'</div>'
        +'</div>'
        +'<div class="vb-page-drop-area'+(page.sectionIds.length===0?' is-empty':'')+'" data-page-drop="'+esc(page.id)+'">';

      if(page.sectionIds.length===0){
        html+='<div class="vb-page-empty-hint">Drag a block here from the left panel, or click a block to add it.</div>';
      } else {
        var autoSpanById={};
        var fieldRun=[];
        function flushFieldRun(){
          if(!fieldRun.length) return;
          var span=fieldRun.length===1?12:(fieldRun.length===2?6:4);
          fieldRun.forEach(function(fid){ autoSpanById[fid]=span; });
          fieldRun=[];
        }
        page.sectionIds.forEach(function(rsid){
          var rs=getSectionById(rsid); if(!rs) return;
          if(isFieldType(getSectionType(rs))){
            fieldRun.push(rsid);
            if(fieldRun.length>=3) flushFieldRun();
          } else {
            flushFieldRun();
          }
        });
        flushFieldRun();

        html+='<div class="vb-drop-zone" data-dz-before="'+esc(page.sectionIds[0])+'" data-dz-page="'+esc(page.id)+'"></div>';
        page.sectionIds.forEach(function(sid,si){
          var s=getSectionById(sid); if(!s) return;
          var type=getSectionType(s);
          var m=getBlockMeta(type);
          var isField=isFieldType(type);
          var span=isField?(autoSpanById[s.id]||12):12;
          html+='<div class="vb-block'+(isField?' vb-block-field':'')+(S.selSectionId===s.id?' is-selected':'')+(s.enabled===false?' is-disabled':'')+(S.drag&&S.drag.kind==='block'&&S.drag.sectionId===s.id?' is-dragging':'')+'" style="'+(isField?'--vb-field-span:'+span+';':'')+'" draggable="true" data-block-id="'+esc(s.id)+'" data-block-page="'+esc(page.id)+'">'
            +'<div class="vb-block-overlay">'
              +'<div class="vb-block-drag-handle" title="Drag to reorder">&#8942; &#8942;</div>'
              +'<button class="vb-block-ovr-btn" data-action="select-section" data-section-id="'+esc(s.id)+'" data-page-id="'+esc(page.id)+'" title="Edit settings">&#9998;</button>'
              +(getSectionType(s)==='content'?'<button class="vb-block-ovr-btn" data-action="duplicate-section" data-section-id="'+esc(s.id)+'" data-page-id="'+esc(page.id)+'" title="Duplicate">&#10697;</button>':'')
              +'<button class="vb-block-ovr-btn del" data-action="remove-section" data-section-id="'+esc(s.id)+'" data-page-id="'+esc(page.id)+'" title="Remove">&times;</button>'
            +'</div>'
            +'<div class="vb-block-preview">'
              +'<div class="vb-block-type-badge">'+m.icon+' '+esc(m.name)+(s.enabled===false?' &middot; Hidden':'')+'</div>'
              +blockPreview(s,ac)
            +'</div>'
            +'</div>';
          var nextId=page.sectionIds[si+1];
          html+='<div class="vb-drop-zone"'+(nextId?' data-dz-before="'+esc(nextId)+'"':' data-dz-after="last"')+' data-dz-page="'+esc(page.id)+'"></div>';
        });
      }

      html+='</div></div>'; // drop-area + page-section
    });

    html+='<button class="vb-add-page-btn" id="vb-add-page-canvas">+ Add a new page</button>';
    elCanvas.innerHTML=html;
    var addBtn=document.getElementById('vb-add-page-canvas');
    if(addBtn) addBtn.addEventListener('click',addPage);
  }

  /* ─── render: block inspector ────────────────────────── */
  function renderBlockInsp() {
    var sel=S.selSectionId?getSectionById(S.selSectionId):null;
    var page=getPageById(S.selPageId)||S.bs.pages[0];
    if(sel){
      var type=getSectionType(sel); var m=getBlockMeta(type);
      elBlockInsp.innerHTML=
        '<div style="display:flex;align-items:center;gap:9px;margin-bottom:14px;padding-bottom:12px;border-bottom:1px solid var(--border)">'
          +'<div style="font-size:26px;line-height:1">'+m.icon+'</div>'
          +'<div><div style="font-size:14px;font-weight:700">'+esc(m.name)+'</div><div style="font-size:12px;color:var(--ink-3)">'+esc(m.desc)+'</div></div>'
        +'</div>'
        +'<div class="vb-field"><label class="vb-label">Label</label><input class="vb-input" id="insp-label" value="'+esc(sel.label||'')+'"></div>'
        +'<div class="vb-field"><label class="vb-label">Description</label><textarea class="vb-textarea" id="insp-desc">'+esc(sel.description||'')+'</textarea></div>'
        +(type==='content'
          ?'<div class="vb-field"><label class="vb-label">Text Content</label><textarea class="vb-textarea" style="min-height:110px" id="insp-body">'+esc(sel.settings&&sel.settings.body?sel.settings.body:'')+'</textarea></div>'
          :'')
        +(isFieldType(type)
          ?(function(){
            var fs=normalizeFieldSettings(type,sel.settings||{});
            return ''
              +'<div class="vb-field"><label class="vb-label">Field Key</label><input class="vb-input" id="insp-field-key" value="'+esc(fs.fieldKey||'')+'"></div>'
              +(fieldSupportsTypeSelection(type)
                ?'<div class="vb-field"><label class="vb-label">Field Type</label><select class="vb-select" id="insp-input-type"><option value="text"'+(fs.inputType==='text'?' selected':'')+'>Text</option><option value="number"'+(fs.inputType==='number'?' selected':'')+'>Number</option><option value="email"'+(fs.inputType==='email'?' selected':'')+'>Email</option><option value="tel"'+(fs.inputType==='tel'?' selected':'')+'>Phone</option></select></div>'
                :'')
              +'<div style="font-size:12px;color:var(--ink-3);margin:-2px 0 8px">Adaptive layout: drag fields to reorder. Rows auto-snap to 1 (100%), 2 (50/50), or 3 (33/33/33).</div>'
              +'<div class="vb-field"><label class="vb-label">Placeholder</label><input class="vb-input" id="insp-placeholder" value="'+esc(fs.placeholder||'')+'"></div>'
              +(fs.inputType==='select'
                ?'<div class="vb-field"><label class="vb-label">Dropdown Options (one per line)</label><textarea class="vb-textarea" id="insp-options">'+esc((fs.options||[]).join('\\n'))+'</textarea></div>'
                :'')
              +'<div class="vb-toggle-setting"><label for="insp-required">Required</label><input type="checkbox" id="insp-required"'+(fs.required?' checked':'')+'></div>';
          })()
          :'')
        +'<div class="vb-toggle-setting"><label for="insp-visible">Visible</label><input type="checkbox" id="insp-visible"'+(sel.enabled!==false?' checked':'')+'></div>'
        +'<div class="vb-insp-actions">'
          +'<button class="vb-insp-action danger" data-insp-action="remove-section">Remove</button>'
          +(type==='content'?'<button class="vb-insp-action" data-insp-action="duplicate-section">Duplicate</button>':'<span></span>')
        +'</div>';
      return;
    }
    if(page){
      elBlockInsp.innerHTML=
        '<div style="margin-bottom:14px;padding-bottom:12px;border-bottom:1px solid var(--border)">'
          +'<div style="font-size:14px;font-weight:700">Page Settings</div>'
          +'<div style="font-size:12px;color:var(--ink-3)">Step '+(S.bs.pages.indexOf(page)+1)+' of '+S.bs.pages.length+'</div>'
        +'</div>'
        +'<div class="vb-field"><label class="vb-label">Page Name</label><input class="vb-input" id="insp-page-name" value="'+esc(page.name||'')+'"></div>'
        +'<div class="vb-field"><label class="vb-label">Page Description</label><textarea class="vb-textarea" id="insp-page-desc">'+esc(page.description||'')+'</textarea></div>'
        +'<div class="vb-insp-actions"><button class="vb-insp-action danger" data-insp-action="remove-page"'+(S.bs.pages.length<=1?' disabled':'')+'> Remove Page</button></div>';
      return;
    }
    elBlockInsp.innerHTML='<div class="vb-insp-empty">Click a block to edit it, or click a page&rsquo;s Edit button.</div>';
  }

  /* ─── render: preview ────────────────────────────────── */
  function renderPreview() { applySettings(); elPreview.innerHTML=''; window.DonationFormRuntime.renderForm(elPreview,S.bs,{mode:'preview'}); }

  /* ─── settings sync ──────────────────────────────────── */
  function syncSettings() {
    var bs=S.bs; bs.display=bs.display||{}; bs.endpoints=bs.endpoints||{}; bs.options=bs.options||{}; bs.payment=bs.payment||{}; bs.branding=bs.branding||{};
    document.getElementById('gs-name').value       =bs.name||'';
    document.getElementById('gs-org-name').value   =bs.branding.organizationName||'';
    document.getElementById('gs-title').value      =bs.branding.title||'';
    document.getElementById('gs-submit-label').value=bs.branding.submitLabel||'';
    document.getElementById('gs-logo-url').value   =bs.branding.logoUrl||'';
    var c=bs.branding.accentColor||'#bd2135';
    document.getElementById('gs-accent-color').value=c;
    document.getElementById('gs-accent-text').value =c;
    document.getElementById('gs-description').value=bs.branding.description||'';
    document.getElementById('gs-display-mode').value=bs.display.mode||'embedded';
    document.getElementById('gs-modal-label').value=bs.display.modalTriggerLabel||'Open donation form';
    document.getElementById('gs-api-url').value    =bs.endpoints.processDonationApi||'';
    document.getElementById('gs-frequency').value  =bs.payment.defaultFrequency||'onetime';
    document.getElementById('gs-amounts').value    =(bs.payment.amountPresets||[]).join(',');
    document.getElementById('gs-categories').value =(bs.payment.categories||[]).join('\\n');
    document.getElementById('gs-recurring').checked =Boolean(bs.options.allowRecurring);
    document.getElementById('gs-org-giving').checked=Boolean(bs.options.allowOrganizationGiving);
    document.getElementById('gs-address').checked  =Boolean(bs.options.collectAddress);
    document.getElementById('gs-tribute').checked  =Boolean(bs.options.enableTribute);
    document.getElementById('gs-fees').checked     =Boolean(bs.options.enableFeeCoverage);
  }

  function applySettings() {
    var bs=S.bs; bs.display=bs.display||{}; bs.endpoints=bs.endpoints||{}; bs.options=bs.options||{}; bs.payment=bs.payment||{}; bs.branding=bs.branding||{};
    bs.name=document.getElementById('gs-name').value.trim()||DEFAULT_CONFIG.name;
    bs.branding.organizationName=document.getElementById('gs-org-name').value.trim()||DEFAULT_CONFIG.branding.organizationName;
    bs.branding.title=document.getElementById('gs-title').value.trim()||DEFAULT_CONFIG.branding.title;
    bs.branding.submitLabel=document.getElementById('gs-submit-label').value.trim()||DEFAULT_CONFIG.branding.submitLabel;
    bs.branding.logoUrl=document.getElementById('gs-logo-url').value.trim();
    bs.branding.accentColor=document.getElementById('gs-accent-color').value||DEFAULT_CONFIG.branding.accentColor;
    bs.branding.description=document.getElementById('gs-description').value.trim();
    bs.display.mode=document.getElementById('gs-display-mode').value||DEFAULT_CONFIG.display.mode;
    bs.display.modalTriggerLabel=document.getElementById('gs-modal-label').value.trim()||DEFAULT_CONFIG.display.modalTriggerLabel;
    bs.endpoints.processDonationApi=document.getElementById('gs-api-url').value.trim()||DEFAULT_CONFIG.endpoints.processDonationApi;
    bs.payment.defaultFrequency=document.getElementById('gs-frequency').value||DEFAULT_CONFIG.payment.defaultFrequency;
    bs.payment.amountPresets=readAmounts(document.getElementById('gs-amounts').value);
    if(!bs.payment.amountPresets.length) bs.payment.amountPresets=clone(DEFAULT_CONFIG.payment.amountPresets);
    bs.payment.categories=readLines(document.getElementById('gs-categories').value);
    if(!bs.payment.categories.length) bs.payment.categories=clone(DEFAULT_CONFIG.payment.categories);
    bs.options.allowRecurring=document.getElementById('gs-recurring').checked;
    bs.options.allowOrganizationGiving=document.getElementById('gs-org-giving').checked;
    bs.options.collectAddress=document.getElementById('gs-address').checked;
    bs.options.enableTribute=document.getElementById('gs-tribute').checked;
    bs.options.enableFeeCoverage=document.getElementById('gs-fees').checked;
  }

  /* ─── tab switch ─────────────────────────────────────── */
  function switchTab(tab) {
    S.activeTab=tab;
    document.querySelectorAll('.vb-inspector-tab').forEach(function(el){ el.classList.toggle('is-active',el.getAttribute('data-tab')===tab); });
    document.querySelectorAll('.vb-tab-panel').forEach(function(el){ el.classList.toggle('is-active',el.id==='vb-tab-'+tab); });
    if(tab==='preview') renderPreview();
  }

  /* ─── main render ────────────────────────────────────── */
  function render() {
    if(!getPageById(S.selPageId)&&S.bs.pages[0]) S.selPageId=S.bs.pages[0].id;
    renderPageNav(); renderShelf(); renderCanvas(); renderBlockInsp();
  }

  /* ─── reset / load ───────────────────────────────────── */
  function resetToDefault() {
    S.configId=null; S.bs=ensureEditorModel(DEFAULT_CONFIG);
    S.selPageId=S.bs.pages[0]?S.bs.pages[0].id:null; S.selSectionId=null;
    syncSettings(); render(); elLibrary.value=''; elResult.classList.remove('is-visible');
  }

  function loadConfigById(configId) {
    if(!configId){resetToDefault();return Promise.resolve();}
    return fetch(trimSlash(CONFIG_BASE_URL)+'/'+encodeURIComponent(configId))
      .then(function(r){if(!r.ok)throw new Error('Not found');return r.json();})
      .then(function(payload){
        S.configId=configId; S.bs=ensureEditorModel(payload&&payload.config?payload.config:DEFAULT_CONFIG);
        S.selPageId=S.bs.pages[0]?S.bs.pages[0].id:null; S.selSectionId=null; syncSettings(); render();
      });
  }

  function refreshLibrary() {
    return fetch(LIST_ENDPOINT).then(function(r){return r.ok?r.json():{records:[]};})
      .then(function(p){
        var recs=p&&Array.isArray(p.records)?p.records:[];
        elLibrary.innerHTML='<option value="">New form\\u2026</option>';
        recs.forEach(function(rec){
          var opt=document.createElement('option'); opt.value=rec.id;
          opt.textContent=(rec.name||'Untitled')+' ('+(rec.displayMode||'embedded')+' \\u2022 '+(rec.updatedAt?new Date(rec.updatedAt).toLocaleDateString():'?')+')';
          if(S.configId&&S.configId===rec.id) opt.selected=true;
          elLibrary.appendChild(opt);
        });
      }).catch(function(){elLibrary.innerHTML='<option value="">New form\\u2026</option>';});
  }

  /* ══ DRAG & DROP ════════════════════════════════════════ */

  /* Shelf → canvas */
  elShelf.addEventListener('dragstart',function(e){
    var el=e.target.closest('[data-shelf-type]');
    if(!el||el.classList.contains('is-disabled')){e.preventDefault();return;}
    S.drag={kind:'library',type:el.getAttribute('data-shelf-type')};
    if(e.dataTransfer){e.dataTransfer.effectAllowed='copy';e.dataTransfer.setData('text/plain',el.getAttribute('data-shelf-type'));}
  });
  elShelf.addEventListener('dragend',function(){S.drag=null;clearDZ();});

  /* Block reorder */
  elCanvas.addEventListener('dragstart',function(e){
    var el=e.target.closest('[data-block-id]');
    if(!el)return;
    S.drag={kind:'block',sectionId:el.getAttribute('data-block-id'),pageId:el.getAttribute('data-block-page')};
    suppressClickFor(300);
    el.classList.add('is-dragging');
    if(e.dataTransfer)e.dataTransfer.effectAllowed='move';
  });
  elCanvas.addEventListener('dragend',function(e){
    var el=e.target.closest('[data-block-id]');
    if(el)el.classList.remove('is-dragging');
    suppressClickFor(250);
    S.drag=null;clearDZ();
  });

  /* Page chip reorder */
  elPageNav.addEventListener('dragstart',function(e){
    var el=e.target.closest('[data-page-nav-id]');
    if(!el)return;
    S.drag={kind:'page',pageId:el.getAttribute('data-page-nav-id')};
    el.classList.add('is-dragging');
    if(e.dataTransfer)e.dataTransfer.effectAllowed='move';
  });
  elPageNav.addEventListener('dragend',function(e){
    var el=e.target.closest('[data-page-nav-id]');
    if(el)el.classList.remove('is-dragging');
    S.drag=null;
  });
  elPageNav.addEventListener('dragover',function(e){if(S.drag&&S.drag.kind==='page')e.preventDefault();});
  elPageNav.addEventListener('drop',function(e){
    var el=e.target.closest('[data-page-nav-id]');
    if(!el||!S.drag||S.drag.kind!=='page')return;
    e.preventDefault();movePage(S.drag.pageId,el.getAttribute('data-page-nav-id'));S.drag=null;
  });

  /* Universal dragover / drop on canvas */
  document.addEventListener('dragover',function(e){
    if(!S.drag||S.drag.kind==='page')return;
    var dz=e.target.closest('.vb-drop-zone');
    var blk=e.target.closest('[data-block-id]');
    var pa=e.target.closest('[data-page-drop]');
    if(dz){e.preventDefault();clearDZ();dz.classList.add('drag-over');}
    else if(blk&&blk.getAttribute('data-block-id')!==S.drag.sectionId){e.preventDefault();clearDZ();blk.classList.add('drag-over');}
    else if(pa){e.preventDefault();clearDZ();pa.classList.add('drag-over');}
  });

  document.addEventListener('dragleave',function(e){
    var dz=e.target.closest('.vb-drop-zone');
    if(dz&&!dz.contains(e.relatedTarget))dz.classList.remove('drag-over');
    var blk=e.target.closest('[data-block-id]');
    if(blk&&!blk.contains(e.relatedTarget))blk.classList.remove('drag-over');
    var pa=e.target.closest('[data-page-drop]');
    if(pa&&!pa.contains(e.relatedTarget))pa.classList.remove('drag-over');
  });

  document.addEventListener('drop',function(e){
    if(!S.drag||S.drag.kind==='page')return;
    var dz=e.target.closest('.vb-drop-zone');
    var blk=e.target.closest('[data-block-id]');
    var pa=e.target.closest('[data-page-drop]');
    if(!dz&&!blk&&!pa)return;
    e.preventDefault();clearDZ();
    suppressClickFor(250);
    var toPageId, beforeId;
    if(dz){
      toPageId=dz.getAttribute('data-dz-page');
      beforeId=dz.getAttribute('data-dz-before')||null;
    } else if(blk&&blk.getAttribute('data-block-id')!==S.drag.sectionId){
      toPageId=blk.getAttribute('data-block-page');
      beforeId=blk.getAttribute('data-block-id');
    } else if(pa){
      toPageId=pa.getAttribute('data-page-drop');
      beforeId=null;
    } else {
      S.drag=null; return;
    }
    if(S.drag.kind==='library'){
      addSectionToPage(S.drag.type,toPageId,beforeId);
    } else if(S.drag.kind==='block'){
      if(S.drag.sectionId!==beforeId) moveSection(S.drag.sectionId,S.drag.pageId,toPageId,beforeId);
    }
    S.drag=null;
  });

  function clearDZ(){
    document.querySelectorAll('.drag-over').forEach(function(el){el.classList.remove('drag-over');});
  }

  /* ══ CLICK EVENTS ════════════════════════════════════════ */

  elPageNav.addEventListener('click',function(e){
    var el=e.target.closest('[data-page-nav-id]');
    if(el){selectPage(el.getAttribute('data-page-nav-id'));}
  });

  elCanvas.addEventListener('click',function(e){
    if(clickSuppressed()) return;
    var btn=e.target.closest('[data-action]');
    if(btn){
      var a=btn.getAttribute('data-action');
      var sid=btn.getAttribute('data-section-id'); var pid=btn.getAttribute('data-page-id');
      if(a==='remove-section')removeSection(sid,pid);
      else if(a==='duplicate-section')duplicateSection(sid,pid);
      else if(a==='select-section'){selectSection(pid,sid);}
      else if(a==='select-page'){selectPage(pid);}
      else if(a==='remove-page')removePage(pid);
      return;
    }
    var block=e.target.closest('[data-block-id]');
    if(block&&!e.target.closest('.vb-block-overlay')){
      selectSection(block.getAttribute('data-block-page'),block.getAttribute('data-block-id'));
    }
  });

  /* Shelf click = add to selected page */
  elShelf.addEventListener('click',function(e){
    var el=e.target.closest('[data-shelf-type]');
    if(el&&!el.classList.contains('is-disabled')) addSectionToPage(el.getAttribute('data-shelf-type'),S.selPageId,null);
  });

  /* Inspector tabs */
  document.querySelectorAll('.vb-inspector-tab').forEach(function(tab){
    tab.addEventListener('click',function(){switchTab(tab.getAttribute('data-tab'));});
  });

  /* Block inspector inputs */
  elBlockInsp.addEventListener('input',function(e){
    var sel=S.selSectionId?getSectionById(S.selSectionId):null;
    var type=sel?getSectionType(sel):'';
    var page=getPageById(S.selPageId);
    if(e.target.id==='insp-label'&&sel)sel.label=e.target.value;
    else if(e.target.id==='insp-desc'&&sel)sel.description=e.target.value;
    else if(e.target.id==='insp-body'&&sel){sel.settings=sel.settings||{};sel.settings.body=e.target.value;}
    else if(e.target.id==='insp-field-key'&&sel&&isFieldType(type)){sel.settings=normalizeFieldSettings(type,sel.settings||{});sel.settings.fieldKey=e.target.value.trim().replace(/[^a-zA-Z0-9_]/g,'_');}
    else if(e.target.id==='insp-placeholder'&&sel&&isFieldType(type)){sel.settings=normalizeFieldSettings(type,sel.settings||{});sel.settings.placeholder=e.target.value;}
    else if(e.target.id==='insp-options'&&sel&&isFieldType(type)){sel.settings=normalizeFieldSettings(type,sel.settings||{});sel.settings.options=readLines(e.target.value);}
    else if(e.target.id==='insp-page-name'&&page)page.name=e.target.value;
    else if(e.target.id==='insp-page-desc'&&page)page.description=e.target.value;
    renderPageNav(); renderCanvas();
  });

  elBlockInsp.addEventListener('change',function(e){
    var sel=S.selSectionId?getSectionById(S.selSectionId):null;
    var type=sel?getSectionType(sel):'';
    if(e.target.id==='insp-visible'&&sel){sel.enabled=e.target.checked;renderCanvas();}
    else if(e.target.id==='insp-required'&&sel&&isFieldType(type)){sel.settings=normalizeFieldSettings(type,sel.settings||{});sel.settings.required=e.target.checked;renderCanvas();}
    else if(e.target.id==='insp-input-type'&&sel&&isFieldType(type)){
      sel.settings=normalizeFieldSettings(type,sel.settings||{});
      sel.settings.inputType=e.target.value||'text';
      if(sel.settings.inputType==='select'&&(!Array.isArray(sel.settings.options)||!sel.settings.options.length)) sel.settings.options=['Option 1','Option 2'];
      renderBlockInsp();
      renderCanvas();
    }
  });

  elBlockInsp.addEventListener('click',function(e){
    var btn=e.target.closest('[data-insp-action]');
    if(!btn)return;
    var a=btn.getAttribute('data-insp-action');
    if(a==='remove-section'&&S.selSectionId)removeSection(S.selSectionId,S.selPageId);
    else if(a==='duplicate-section'&&S.selSectionId)duplicateSection(S.selSectionId,S.selPageId);
    else if(a==='remove-page'&&S.selPageId)removePage(S.selPageId);
  });

  /* Settings tab live update */
  document.getElementById('vb-tab-settings').addEventListener('input',function(e){
    if(e.target.id==='gs-accent-color')document.getElementById('gs-accent-text').value=e.target.value;
    if(e.target.id==='gs-accent-text'){var c=e.target.value;if(/^#[0-9a-f]{6}$/i.test(c))document.getElementById('gs-accent-color').value=c;}
  });
  document.getElementById('vb-tab-settings').addEventListener('change',function(){renderCanvas();});

  /* Add page */
  document.getElementById('vb-add-page').addEventListener('click',function(){addPage();});

  /* Search */
  document.getElementById('vb-search').addEventListener('input',function(){S.q=this.value.trim();renderShelf();});

  /* Top bar */
  document.getElementById('vb-reset').addEventListener('click',resetToDefault);

  document.getElementById('vb-load-form').addEventListener('click',function(){
    loadConfigById(elLibrary.value)
      .then(function(){
        var url=new URL(BUILDER_ENDPOINT,window.location.origin);
        if(S.configId)url.searchParams.set('config',S.configId);
        history.replaceState({},'',url.toString());
      })
      .catch(function(err){
        showInspector();switchTab('preview');elResult.classList.add('is-visible');
        document.getElementById('vb-config-url').textContent=err&&err.message?err.message:'Unable to load form.';
      });
  });

  document.getElementById('vb-delete-form').addEventListener('click',function(){
    var id=elLibrary.value||S.configId;
    if(!id){alert('Select a saved form first.');return;}
    if(!window.confirm('Delete this form? This cannot be undone.'))return;
    fetch(trimSlash(CONFIG_BASE_URL)+'/'+encodeURIComponent(id),{method:'DELETE'})
      .then(function(r){if(!r.ok)throw new Error('Delete failed');return r.json();})
      .then(function(){resetToDefault();return refreshLibrary();})
      .then(function(){history.replaceState({},'',new URL(BUILDER_ENDPOINT,window.location.origin).toString());})
      .catch(function(err){alert(err&&err.message?err.message:'Unable to delete.');});
  });

  document.getElementById('vb-publish').addEventListener('click',function(){
    applySettings();
    var payload=clone(S.bs); if(S.configId)payload.id=S.configId;
    fetch(SAVE_ENDPOINT,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)})
      .then(function(r){return r.json();})
      .then(function(result){
        S.configId=result.id||S.configId;
        showInspector();switchTab('preview');elResult.classList.add('is-visible');
        document.getElementById('vb-config-url').textContent=result.configUrl||'';
        document.getElementById('vb-snip-embedded').textContent=(result.embedSnippets&&result.embedSnippets.embedded)||result.embeddedEmbedSnippet||result.embedSnippet||'';
        document.getElementById('vb-snip-modal').textContent=(result.embedSnippets&&result.embedSnippets.modal)||result.modalEmbedSnippet||result.embedSnippet||'';
        var url=new URL(BUILDER_ENDPOINT,window.location.origin);url.searchParams.set('config',result.id);
        history.replaceState({},'',url.toString());return refreshLibrary();
      })
      .catch(function(err){
        showInspector();switchTab('preview');elResult.classList.add('is-visible');
        document.getElementById('vb-config-url').textContent=err&&err.message?err.message:'Publish failed.';
      });
  });

  /* ── Boot ────────────────────────────────────────────── */
  S.bs=ensureEditorModel(DEFAULT_CONFIG);
  S.selPageId=S.bs.pages[0]?S.bs.pages[0].id:null;
  syncSettings(); render();

  var initId=new URLSearchParams(window.location.search).get('config');
  if(initId) loadConfigById(initId).catch(resetToDefault);
  refreshLibrary();
})();
</script>
</body>
</html>`;
}

module.exports = { createBuilderPage };
