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

module.exports = async function donationFormConfigSave(request) {
  const body = await request.json();
  const record = await configStore.save(body);
  const baseUrl = getBaseUrl(request);
  const configUrl = baseUrl + '/api/form-builder/configs/' + encodeURIComponent(record.id);
  const embedScriptUrl =
    baseUrl + '/api/form-builder/embed.js?config=' + encodeURIComponent(record.id);
  const embeddedEmbedSnippet =
    '<div id="donation-form-embedded"></div>\n' +
    '<script src="' +
    embedScriptUrl +
    '"></' +
    'script>';
  const modalEmbedSnippet =
    '<div data-donation-form></div>\n' + '<script src="' + embedScriptUrl + '"></' + 'script>';
  const selectedMode =
    record && record.config && record.config.display && record.config.display.mode === 'modal'
      ? 'modal'
      : 'embedded';
  const embedSnippet = selectedMode === 'modal' ? modalEmbedSnippet : embeddedEmbedSnippet;

  return {
    status: 201,
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

module.exports.__internals = {
  resetConfigStore,
  setConfigStore,
};
