require('../preflight');

const { FormConfigStore } = require('../services/formBuilder/formConfigStore');

let configStore = new FormConfigStore();

const setConfigStore = (store) => {
  configStore = store;
};

const resetConfigStore = () => {
  configStore = new FormConfigStore();
};

module.exports = async function donationFormConfigDelete(request) {
  const configId = request && request.params ? request.params.configId : null;
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
