require('../preflight');

const { createBuilderPage } = require('../services/formBuilder/builderPage');

const getBaseUrl = (request) => {
  const requestUrl =
    request && request.url ? request.url : 'http://localhost:7071/api/form-builder';
  const parsed = new URL(requestUrl);
  return parsed.origin;
};

module.exports = async function donationFormBuilder(request) {
  const baseUrl = getBaseUrl(request);
  const builderEndpoint = baseUrl + '/api/form-builder';
  const saveEndpoint = baseUrl + '/api/form-builder/configs';
  const listEndpoint = baseUrl + '/api/form-builder/configs';
  const configBaseUrl = baseUrl + '/api/form-builder/configs';

  return {
    status: 200,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
    },
    body: createBuilderPage({
      builderEndpoint,
      saveEndpoint,
      listEndpoint,
      configBaseUrl,
    }),
  };
};
