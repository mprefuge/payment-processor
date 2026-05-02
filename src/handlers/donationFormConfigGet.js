require('../preflight');

const { FormConfigStore } = require('../services/formBuilder/formConfigStore');

let configStore = new FormConfigStore();

const setConfigStore = (store) => {
  configStore = store;
};

const resetConfigStore = () => {
  configStore = new FormConfigStore();
};

module.exports = async function donationFormConfigGet(request) {
  const configId = request && request.params ? request.params.configId : null;
  const record = await configStore.get(configId);
  if (!record) {
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
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    },
    body: JSON.stringify(record),
  };
};

module.exports.__internals = {
  resetConfigStore,
  setConfigStore,
};
