require('../preflight');

const { FormConfigStore } = require('../services/formBuilder/formConfigStore');

let configStore = new FormConfigStore();

const setConfigStore = (store) => {
  configStore = store;
};

const resetConfigStore = () => {
  configStore = new FormConfigStore();
};

const readParam = (request, key) => {
  if (!request || !request.params) {
    return null;
  }

  if (typeof request.params.get === 'function') {
    const value = request.params.get(key);
    if (value) {
      return value;
    }
  }

  if (request.params[key]) {
    return request.params[key];
  }

  if (key === 'configId' && request.url) {
    try {
      const parsed = new URL(request.url);
      const parts = parsed.pathname.split('/').filter(Boolean);
      const configsIndex = parts.lastIndexOf('configs');
      if (configsIndex >= 0 && parts.length > configsIndex + 1) {
        return decodeURIComponent(parts[configsIndex + 1]);
      }
    } catch (_error) {
      return null;
    }
  }

  return null;
};

module.exports = async function donationFormConfigDelete(request) {
  const configId = readParam(request, 'configId');
  const deleted = await configStore.delete(configId);

  if (!deleted) {
    return {
      status: 404,
      jsonBody: {
        error: 'not_found',
        message: 'Donation form configuration was not found.',
      },
    };
  }

  return {
    status: 200,
    jsonBody: {
      ok: true,
      id: configId,
    },
  };
};

module.exports.__internals = {
  resetConfigStore,
  setConfigStore,
};
