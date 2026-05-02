require('../preflight');

const { FormConfigStore } = require('../services/formBuilder/formConfigStore');

let configStore = new FormConfigStore();

const setConfigStore = (store) => {
  configStore = store;
};

const resetConfigStore = () => {
  configStore = new FormConfigStore();
};

module.exports = async function donationFormConfigList() {
  const records = await configStore.list();

  return {
    status: 200,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    },
    body: JSON.stringify({
      records,
    }),
  };
};

module.exports.__internals = {
  resetConfigStore,
  setConfigStore,
};
