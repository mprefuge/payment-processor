require('../preflight');

const { FormConfigStore } = require('../services/formBuilder/formConfigStore');

let configStore = new FormConfigStore();

const setConfigStore = (store) => {
  configStore = store;
};

const resetConfigStore = () => {
  configStore = new FormConfigStore();
};

const getBaseUrl = (request) => {
  const requestUrl =
    request && request.url ? request.url : 'http://localhost:7071/api/form-builder/configs';
  const parsed = new URL(requestUrl);
  return parsed.origin;
};

const readConfigId = (request) => {
  if (!request) return null;
  if (request.params) {
    if (typeof request.params.get === 'function') {
      const v = request.params.get('configId');
      if (v) return v;
    }
    if (request.params['configId']) return request.params['configId'];
  }
  if (request.url) {
    try {
      const parsed = new URL(request.url);
      const parts = parsed.pathname.split('/').filter(Boolean);
      const idx = parts.lastIndexOf('configs');
      if (idx >= 0 && parts.length > idx + 1) return decodeURIComponent(parts[idx + 1]);
    } catch (_) {
      return null;
    }
  }
  return null;
};

module.exports = async function donationFormConfigUpdate(request) {
  const configId = readConfigId(request);
  if (!configId) {
    return {
      status: 400,
      jsonBody: { error: 'bad_request', message: 'Missing configId in URL.' },
    };
  }

  const body = await request.json();
  // Ensure the id in the body matches the URL param (URL wins)
  const record = await configStore.save({ ...body, id: configId });

  const baseUrl = getBaseUrl(request);
  const configUrl = baseUrl + '/api/form-builder/configs/' + encodeURIComponent(record.id);
  const embedScriptUrl =
    baseUrl + '/api/form-builder/embed.js?config=' + encodeURIComponent(record.id);
  const selectedMode =
    record && record.config && record.config.display && record.config.display.mode === 'modal'
      ? 'modal'
      : 'embedded';
  const embedSnippet =
    '<div data-donation-form></div>\n<script src="' + embedScriptUrl + '"></script>';

  const embeddedEmbedSnippet =
    '<div id="donation-form-embedded"></div>\n' +
    '<script src="' +
    embedScriptUrl +
    '"></' +
    'script>';
  const modalEmbedSnippet =
    '<div data-donation-form></div>\n' + '<script src="' + embedScriptUrl + '"></' + 'script>';

  return {
    status: 200,
    jsonBody: {
      id: record.id,
      configUrl,
      embedScriptUrl,
      embedSnippet,
      embeddedEmbedSnippet,
      modalEmbedSnippet,
      embedSnippets: {
        embedded: embeddedEmbedSnippet,
        modal: modalEmbedSnippet,
      },
      config: record.config,
    },
  };
};

module.exports.setConfigStore = setConfigStore;
module.exports.resetConfigStore = resetConfigStore;
