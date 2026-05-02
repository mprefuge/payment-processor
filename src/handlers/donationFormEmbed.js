require('../preflight');

const { getDonationFormRuntimeSource } = require('../services/formBuilder/runtimeSource');
const { FormConfigStore } = require('../services/formBuilder/formConfigStore');

let configStore = new FormConfigStore();

const setConfigStore = (store) => {
  configStore = store;
};

const resetConfigStore = () => {
  configStore = new FormConfigStore();
};

const readQueryValue = (request, requestUrl, key) => {
  return (
    requestUrl.searchParams.get(key) ||
    (request && request.query && typeof request.query.get === 'function'
      ? request.query.get(key)
      : null)
  );
};

const extractConfigIdFromConfigUrl = (configUrl) => {
  if (!configUrl) {
    return null;
  }

  try {
    const parsed = new URL(configUrl);
    const parts = parsed.pathname.split('/').filter(Boolean);
    const configsIndex = parts.lastIndexOf('configs');
    if (configsIndex >= 0 && parts.length > configsIndex + 1) {
      return decodeURIComponent(parts[configsIndex + 1]);
    }
  } catch (_error) {
    return null;
  }

  return null;
};

module.exports = async function donationFormEmbed(request) {
  const requestUrl = new URL(
    request && request.url ? request.url : 'http://localhost:7071/api/form-builder/embed.js'
  );
  const configIdFromQuery = readQueryValue(request, requestUrl, 'config');
  const configUrl = readQueryValue(request, requestUrl, 'configUrl');
  const configIdFromUrl = extractConfigIdFromConfigUrl(configUrl);
  const configId = configIdFromQuery || configIdFromUrl;
  const record = configId ? await configStore.get(configId) : null;
  const inlineConfig = record ? record.config : null;

  if (!inlineConfig && !configUrl) {
    return {
      status: 400,
      jsonBody: {
        error: 'missing_config_reference',
        message: 'config or configUrl is required.',
      },
    };
  }

  const runtimeSource = getDonationFormRuntimeSource();
  const body = `${runtimeSource}
(function () {
  var inlineConfig = ${JSON.stringify(inlineConfig)};
  var explicitConfigUrl = ${JSON.stringify(configUrl)};
  var target = document.querySelector('[data-donation-form]') || document.getElementById('donation-form-embedded');
  if (!target) {
    target = document.createElement('div');
    target.setAttribute('data-donation-form', 'true');
    document.currentScript.parentNode.insertBefore(target, document.currentScript);
  }

  if (inlineConfig) {
    window.DonationFormRuntime.renderForm(target, inlineConfig, { mode: 'live' });
    return;
  }

  fetch(explicitConfigUrl)
    .then(function (response) {
      if (!response.ok) {
        throw new Error('Unable to load donation form configuration.');
      }
      return response.json();
    })
    .then(function (payload) {
      var config = payload && payload.config ? payload.config : payload;
      window.DonationFormRuntime.renderForm(target, config, { mode: 'live' });
    })
    .catch(function (error) {
      target.innerHTML = '<div style="padding:16px;border:1px solid #bd2135;border-radius:16px;color:#bd2135;background:#fff5f3;font-family:Georgia,serif;">' + (error && error.message ? error.message : 'Unable to load donation form.') + '</div>';
    });
})();`;

  return {
    status: 200,
    headers: {
      'Content-Type': 'application/javascript; charset=utf-8',
      'Cache-Control': 'no-store',
    },
    body,
  };
};

module.exports.__internals = {
  resetConfigStore,
  setConfigStore,
};
