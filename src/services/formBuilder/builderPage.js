const { getDefaultDonationFormConfig } = require('./defaultDonationFormConfig');
const { getDonationFormRuntimeSource } = require('./runtimeSource');

function createBuilderPage({ builderEndpoint, saveEndpoint, configBaseUrl }) {
  const defaultConfig = JSON.stringify(getDefaultDonationFormConfig());
  const runtimeSource = getDonationFormRuntimeSource();

  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Donation Form Builder</title>
    <style>
      :root {
        --builder-accent: #bd2135;
        --builder-ink: #1d1d1f;
        --builder-muted: #666;
        --builder-bg: #f3efe8;
        --builder-panel: #fff;
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        font-family: Georgia, 'Times New Roman', serif;
        color: var(--builder-ink);
        background:
          radial-gradient(circle at top left, rgba(189, 33, 53, 0.14), transparent 28%),
          linear-gradient(180deg, #f7f1ea, #f3efe8 35%, #ece8e0 100%);
      }
      .builder-shell {
        min-height: 100vh;
        padding: 24px;
        display: grid;
        gap: 24px;
        grid-template-columns: minmax(320px, 420px) minmax(0, 1fr);
      }
      .builder-panel,
      .builder-preview {
        background: rgba(255,255,255,0.92);
        backdrop-filter: blur(10px);
        border: 1px solid rgba(0,0,0,0.08);
        border-radius: 24px;
        box-shadow: 0 24px 60px rgba(0,0,0,0.08);
      }
      .builder-panel { padding: 24px; overflow: auto; }
      .builder-preview { padding: 20px; }
      .builder-eyebrow {
        text-transform: uppercase;
        letter-spacing: .14em;
        font-size: 12px;
        color: var(--builder-accent);
        font-weight: 700;
      }
      h1 { margin: 8px 0 10px; font-size: 36px; line-height: 1.05; }
      .builder-copy { color: var(--builder-muted); font-size: 15px; max-width: 60ch; }
      .builder-section { margin-top: 22px; }
      .builder-section h2 {
        margin: 0 0 12px;
        font-size: 18px;
      }
      .builder-grid { display: grid; gap: 12px; }
      .builder-grid-2 { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .builder-label {
        display: block;
        margin-bottom: 6px;
        font-size: 12px;
        text-transform: uppercase;
        letter-spacing: .06em;
        font-weight: 700;
        color: var(--builder-muted);
      }
      .builder-input,
      .builder-textarea,
      .builder-select {
        width: 100%;
        border-radius: 14px;
        border: 1px solid rgba(0,0,0,.12);
        background: #fff;
        padding: 12px 14px;
        font: inherit;
      }
      .builder-textarea { min-height: 90px; resize: vertical; }
      .builder-toggle {
        display: flex;
        gap: 10px;
        align-items: center;
        padding: 12px 14px;
        border-radius: 16px;
        background: #fff;
        border: 1px solid rgba(0,0,0,.08);
      }
      .builder-toggle input { width: 18px; height: 18px; }
      .builder-list { display: grid; gap: 10px; }
      .builder-item {
        padding: 14px;
        border-radius: 16px;
        border: 1px solid rgba(0,0,0,.1);
        background: linear-gradient(180deg, #fff, #faf7f4);
        display: grid;
        gap: 10px;
        cursor: grab;
      }
      .builder-item.is-dragging { opacity: .45; }
      .builder-item-top { display: flex; justify-content: space-between; gap: 12px; }
      .builder-item-title { font-weight: 700; }
      .builder-item-help { font-size: 13px; color: var(--builder-muted); }
      .builder-actions { display: flex; gap: 12px; flex-wrap: wrap; margin-top: 18px; }
      .builder-btn {
        border: 0;
        border-radius: 999px;
        padding: 12px 18px;
        font: inherit;
        font-weight: 700;
        cursor: pointer;
      }
      .builder-btn-primary {
        background: var(--builder-accent);
        color: #fff;
        box-shadow: 0 14px 32px rgba(189, 33, 53, 0.22);
      }
      .builder-btn-secondary {
        background: #fff;
        border: 1px solid rgba(0,0,0,.12);
      }
      .builder-result {
        margin-top: 18px;
        padding: 16px;
        border-radius: 18px;
        background: #fff8f6;
        border: 1px solid rgba(189, 33, 53, .14);
        display: none;
      }
      .builder-result.is-visible { display: block; }
      .builder-code {
        margin-top: 8px;
        padding: 12px;
        border-radius: 14px;
        background: #241f20;
        color: #f5f5f5;
        font-family: Consolas, monospace;
        font-size: 12px;
        overflow: auto;
        white-space: pre-wrap;
      }
      .builder-preview-head {
        display: flex;
        justify-content: space-between;
        align-items: center;
        gap: 12px;
        margin-bottom: 16px;
      }
      .builder-preview-head small { color: var(--builder-muted); }
      @media (max-width: 1080px) {
        .builder-shell { grid-template-columns: 1fr; }
      }
    </style>
  </head>
  <body>
    <div class="builder-shell">
      <aside class="builder-panel">
        <div class="builder-eyebrow">No-Code Builder</div>
        <h1>Donation Form Builder</h1>
        <div class="builder-copy">Arrange the donor experience with drag-and-drop sections, tune the payment options, and publish a reusable configuration URL plus embed snippet.</div>

        <div class="builder-section">
          <h2>Branding</h2>
          <div class="builder-grid">
            <div>
              <label class="builder-label" for="builder-name">Form Name</label>
              <input class="builder-input" id="builder-name" />
            </div>
            <div>
              <label class="builder-label" for="builder-org-name">Organization Name</label>
              <input class="builder-input" id="builder-org-name" />
            </div>
            <div>
              <label class="builder-label" for="builder-title">Title</label>
              <input class="builder-input" id="builder-title" />
            </div>
            <div>
              <label class="builder-label" for="builder-submit-label">Submit Label</label>
              <input class="builder-input" id="builder-submit-label" />
            </div>
            <div>
              <label class="builder-label" for="builder-logo-url">Logo URL</label>
              <input class="builder-input" id="builder-logo-url" />
            </div>
            <div>
              <label class="builder-label" for="builder-accent-color">Accent Color</label>
              <input class="builder-input" id="builder-accent-color" type="color" />
            </div>
            <div>
              <label class="builder-label" for="builder-description">Description</label>
              <textarea class="builder-textarea" id="builder-description"></textarea>
            </div>
          </div>
        </div>

        <div class="builder-section">
          <h2>Presentation</h2>
          <div class="builder-grid builder-grid-2">
            <div>
              <label class="builder-label" for="builder-display-mode">Form Display Mode</label>
              <select class="builder-select" id="builder-display-mode">
                <option value="embedded">Embedded Form</option>
                <option value="modal">Modal Popup Form</option>
              </select>
            </div>
            <div>
              <label class="builder-label" for="builder-modal-trigger-label">Modal Trigger Label</label>
              <input class="builder-input" id="builder-modal-trigger-label" placeholder="Open donation form" />
            </div>
          </div>
        </div>

        <div class="builder-section">
          <h2>Payment Settings</h2>
          <div class="builder-grid">
            <div>
              <label class="builder-label" for="builder-api-url">Transaction API URL</label>
              <input class="builder-input" id="builder-api-url" />
            </div>
            <div class="builder-grid-2 builder-grid">
              <div>
                <label class="builder-label" for="builder-default-frequency">Default Frequency</label>
                <select class="builder-select" id="builder-default-frequency">
                  <option value="onetime">One-Time</option>
                  <option value="month">Monthly</option>
                  <option value="biweek">Bi-Weekly</option>
                  <option value="week">Weekly</option>
                  <option value="year">Yearly</option>
                </select>
              </div>
              <div>
                <label class="builder-label" for="builder-amounts">Preset Amounts</label>
                <input class="builder-input" id="builder-amounts" placeholder="500,100,50,25,10" />
              </div>
            </div>
            <div>
              <label class="builder-label" for="builder-categories">Categories</label>
              <textarea class="builder-textarea" id="builder-categories"></textarea>
            </div>
          </div>
        </div>

        <div class="builder-section">
          <h2>Feature Toggles</h2>
          <div class="builder-grid">
            <label class="builder-toggle"><input type="checkbox" id="toggle-recurring" /> Allow recurring gifts</label>
            <label class="builder-toggle"><input type="checkbox" id="toggle-organization" /> Allow organization giving</label>
            <label class="builder-toggle"><input type="checkbox" id="toggle-address" /> Collect address</label>
            <label class="builder-toggle"><input type="checkbox" id="toggle-tribute" /> Enable tribute gifts</label>
            <label class="builder-toggle"><input type="checkbox" id="toggle-fees" /> Enable cover-fee option</label>
          </div>
        </div>

        <div class="builder-section">
          <h2>Section Layout</h2>
          <div class="builder-copy">Drag cards to rearrange the form. Disable any section you do not want rendered.</div>
          <div class="builder-list" id="section-list"></div>
        </div>

        <div class="builder-actions">
          <button class="builder-btn builder-btn-primary" id="save-config">Publish Configuration</button>
          <button class="builder-btn builder-btn-secondary" id="reset-config">Reset to Defaults</button>
        </div>

        <div class="builder-result" id="publish-result">
          <div><strong>Config URL</strong></div>
          <div id="config-url"></div>
          <div style="margin-top:12px"><strong>Embedded Snippet</strong></div>
          <div class="builder-code" id="embed-snippet-embedded"></div>
          <div style="margin-top:12px"><strong>Modal Snippet</strong></div>
          <div class="builder-code" id="embed-snippet-modal"></div>
        </div>
      </aside>

      <section class="builder-preview">
        <div class="builder-preview-head">
          <div>
            <div class="builder-eyebrow">Live Preview</div>
            <small>The preview uses the same runtime as the generated embed script.</small>
          </div>
          <a href="${builderEndpoint}" style="color:var(--builder-accent)">Reload builder</a>
        </div>
        <div id="builder-preview-root"></div>
      </section>
    </div>

    <script>
      ${runtimeSource}
    </script>
    <script>
      (function () {
        var DEFAULT_CONFIG = ${defaultConfig};
        var SAVE_ENDPOINT = ${JSON.stringify(saveEndpoint)};
        var CONFIG_BASE_URL = ${JSON.stringify(configBaseUrl)};
        var builderState = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
        var sectionList = document.getElementById('section-list');
        var previewRoot = document.getElementById('builder-preview-root');
        var publishResult = document.getElementById('publish-result');
        var draggingSectionId = null;

        function clone(value) {
          return value === undefined ? value : JSON.parse(JSON.stringify(value));
        }

        function readLines(value) {
          return value
            .split(/\\r?\\n/)
            .map(function (item) { return item.trim(); })
            .filter(Boolean);
        }

        function readAmounts(value) {
          return value
            .split(',')
            .map(function (item) { return Number(item.trim()); })
            .filter(function (item) { return Number.isFinite(item) && item > 0; });
        }

        function bindBranding() {
          builderState.display = builderState.display || {};
          document.getElementById('builder-name').value = builderState.name || '';
          document.getElementById('builder-org-name').value = builderState.branding.organizationName || '';
          document.getElementById('builder-title').value = builderState.branding.title || '';
          document.getElementById('builder-submit-label').value = builderState.branding.submitLabel || '';
          document.getElementById('builder-logo-url').value = builderState.branding.logoUrl || '';
          document.getElementById('builder-accent-color').value = builderState.branding.accentColor || '#bd2135';
          document.getElementById('builder-description').value = builderState.branding.description || '';
          document.getElementById('builder-display-mode').value = builderState.display.mode || 'embedded';
          document.getElementById('builder-modal-trigger-label').value = builderState.display.modalTriggerLabel || 'Open donation form';
          document.getElementById('builder-api-url').value = builderState.endpoints.processDonationApi || '';
          document.getElementById('builder-default-frequency').value = builderState.payment.defaultFrequency || 'onetime';
          document.getElementById('builder-amounts').value = (builderState.payment.amountPresets || []).join(',');
          document.getElementById('builder-categories').value = (builderState.payment.categories || []).join('\\n');
          document.getElementById('toggle-recurring').checked = Boolean(builderState.options.allowRecurring);
          document.getElementById('toggle-organization').checked = Boolean(builderState.options.allowOrganizationGiving);
          document.getElementById('toggle-address').checked = Boolean(builderState.options.collectAddress);
          document.getElementById('toggle-tribute').checked = Boolean(builderState.options.enableTribute);
          document.getElementById('toggle-fees').checked = Boolean(builderState.options.enableFeeCoverage);
        }

        function applyInputs() {
          builderState.display = builderState.display || {};
          builderState.name = document.getElementById('builder-name').value.trim() || DEFAULT_CONFIG.name;
          builderState.branding.organizationName = document.getElementById('builder-org-name').value.trim() || DEFAULT_CONFIG.branding.organizationName;
          builderState.branding.title = document.getElementById('builder-title').value.trim() || DEFAULT_CONFIG.branding.title;
          builderState.branding.submitLabel = document.getElementById('builder-submit-label').value.trim() || DEFAULT_CONFIG.branding.submitLabel;
          builderState.branding.logoUrl = document.getElementById('builder-logo-url').value.trim();
          builderState.branding.accentColor = document.getElementById('builder-accent-color').value || DEFAULT_CONFIG.branding.accentColor;
          builderState.branding.description = document.getElementById('builder-description').value.trim();
          builderState.display.mode = document.getElementById('builder-display-mode').value || DEFAULT_CONFIG.display.mode;
          builderState.display.modalTriggerLabel = document.getElementById('builder-modal-trigger-label').value.trim() || DEFAULT_CONFIG.display.modalTriggerLabel;
          builderState.endpoints.processDonationApi = document.getElementById('builder-api-url').value.trim() || DEFAULT_CONFIG.endpoints.processDonationApi;
          builderState.payment.defaultFrequency = document.getElementById('builder-default-frequency').value;
          builderState.payment.amountPresets = readAmounts(document.getElementById('builder-amounts').value);
          if (!builderState.payment.amountPresets.length) {
            builderState.payment.amountPresets = clone(DEFAULT_CONFIG.payment.amountPresets);
          }
          builderState.payment.categories = readLines(document.getElementById('builder-categories').value);
          if (!builderState.payment.categories.length) {
            builderState.payment.categories = clone(DEFAULT_CONFIG.payment.categories);
          }
          builderState.options.allowRecurring = document.getElementById('toggle-recurring').checked;
          builderState.options.allowOrganizationGiving = document.getElementById('toggle-organization').checked;
          builderState.options.collectAddress = document.getElementById('toggle-address').checked;
          builderState.options.enableTribute = document.getElementById('toggle-tribute').checked;
          builderState.options.enableFeeCoverage = document.getElementById('toggle-fees').checked;
        }

        function renderSectionList() {
          sectionList.innerHTML = '';
          builderState.sections.forEach(function (section) {
            var item = document.createElement('div');
            item.className = 'builder-item';
            item.draggable = true;
            item.dataset.sectionId = section.id;
            item.innerHTML =
              '<div class="builder-item-top">' +
                '<div><div class="builder-item-title">' + section.label + '</div><div class="builder-item-help">' + section.description + '</div></div>' +
                '<label class="builder-toggle" style="padding:8px 10px"><input type="checkbox" ' + (section.enabled ? 'checked' : '') + ' data-enable-toggle="' + section.id + '"> Enabled</label>' +
              '</div>' +
              '<div class="builder-grid builder-grid-2">' +
                '<div><label class="builder-label">Heading</label><input class="builder-input" data-section-label="' + section.id + '" value="' + section.label.replace(/"/g, '&quot;') + '"></div>' +
                '<div><label class="builder-label">Description</label><input class="builder-input" data-section-description="' + section.id + '" value="' + section.description.replace(/"/g, '&quot;') + '"></div>' +
              '</div>';

            item.addEventListener('dragstart', function () {
              draggingSectionId = section.id;
              item.classList.add('is-dragging');
            });
            item.addEventListener('dragend', function () {
              draggingSectionId = null;
              item.classList.remove('is-dragging');
            });
            item.addEventListener('dragover', function (event) {
              event.preventDefault();
            });
            item.addEventListener('drop', function (event) {
              event.preventDefault();
              if (!draggingSectionId || draggingSectionId === section.id) {
                return;
              }
              var fromIndex = builderState.sections.findIndex(function (entry) { return entry.id === draggingSectionId; });
              var toIndex = builderState.sections.findIndex(function (entry) { return entry.id === section.id; });
              if (fromIndex < 0 || toIndex < 0) {
                return;
              }
              var moved = builderState.sections.splice(fromIndex, 1)[0];
              builderState.sections.splice(toIndex, 0, moved);
              renderSectionList();
              renderPreview();
            });

            sectionList.appendChild(item);
          });
        }

        function renderPreview() {
          applyInputs();
          previewRoot.innerHTML = '';
          window.DonationFormRuntime.renderForm(previewRoot, builderState, { mode: 'preview' });
        }

        sectionList.addEventListener('input', function (event) {
          var toggleId = event.target.getAttribute('data-enable-toggle');
          if (toggleId) {
            var toggledSection = builderState.sections.find(function (section) { return section.id === toggleId; });
            if (toggledSection) {
              toggledSection.enabled = event.target.checked;
            }
          }
          var labelId = event.target.getAttribute('data-section-label');
          if (labelId) {
            var labeledSection = builderState.sections.find(function (section) { return section.id === labelId; });
            if (labeledSection) {
              labeledSection.label = event.target.value;
            }
          }
          var descriptionId = event.target.getAttribute('data-section-description');
          if (descriptionId) {
            var describedSection = builderState.sections.find(function (section) { return section.id === descriptionId; });
            if (describedSection) {
              describedSection.description = event.target.value;
            }
          }
          renderPreview();
        });

        document.querySelectorAll('.builder-input, .builder-textarea, .builder-select').forEach(function (element) {
          element.addEventListener('input', renderPreview);
          element.addEventListener('change', renderPreview);
        });
        document.querySelectorAll('input[type="checkbox"]').forEach(function (element) {
          element.addEventListener('change', renderPreview);
        });

        document.getElementById('reset-config').addEventListener('click', function () {
          builderState = clone(DEFAULT_CONFIG);
          bindBranding();
          renderSectionList();
          renderPreview();
          publishResult.classList.remove('is-visible');
        });

        document.getElementById('save-config').addEventListener('click', function () {
          applyInputs();
          fetch(SAVE_ENDPOINT, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(builderState),
          })
            .then(function (response) { return response.json(); })
            .then(function (result) {
              publishResult.classList.add('is-visible');
              document.getElementById('config-url').textContent = result.configUrl;
              var snippets = result.embedSnippets || {};
              document.getElementById('embed-snippet-embedded').textContent =
                snippets.embedded || result.embeddedEmbedSnippet || result.embedSnippet || '';
              document.getElementById('embed-snippet-modal').textContent =
                snippets.modal || result.modalEmbedSnippet || result.embedSnippet || '';
              var url = new URL(CONFIG_BASE_URL, window.location.origin);
              url.searchParams.set('config', result.id);
              history.replaceState({}, '', url.toString());
            })
            .catch(function (error) {
              publishResult.classList.add('is-visible');
              document.getElementById('config-url').textContent = error && error.message ? error.message : 'Unable to publish configuration.';
              document.getElementById('embed-snippet-embedded').textContent = '';
              document.getElementById('embed-snippet-modal').textContent = '';
            });
        });

        function loadExistingConfig() {
          var params = new URLSearchParams(window.location.search);
          var configId = params.get('config');
          if (!configId) {
            return Promise.resolve();
          }
          return fetch(CONFIG_BASE_URL.replace(/\\\/$/, '') + '/' + encodeURIComponent(configId))
            .then(function (response) {
              if (!response.ok) {
                throw new Error('Configuration not found.');
              }
              return response.json();
            })
            .then(function (payload) {
              builderState = payload.config || clone(DEFAULT_CONFIG);
              bindBranding();
              renderSectionList();
              renderPreview();
            })
            .catch(function () {
              builderState = clone(DEFAULT_CONFIG);
            });
        }

        bindBranding();
        renderSectionList();
        renderPreview();
        loadExistingConfig();
      })();
    </script>
  </body>
</html>`;
}

module.exports = {
  createBuilderPage,
};
