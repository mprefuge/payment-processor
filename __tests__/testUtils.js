const createContext = (overrides = {}) => {
  const logs = [];
  const logFn = (...args) => {
    logs.push(args);
  };

  logFn.info = logFn;
  logFn.warn = logFn;
  logFn.error = logFn;

  const context = {
    bindingData: {},
    log: logFn,
    res: {},
    ...overrides,
  };

  if (!context.bindingData) {
    context.bindingData = {};
  }

  return { context, logs };
};

// Helper to create v4-style HttpRequest mock
const createHttpRequest = (options = {}) => {
  const {
    method = 'POST',
    url = 'http://localhost:7071/api/test',
    headers = {},
    body = {},
    params = {},
  } = options;

  // Create headers map with get() method
  const headersMap = new Map(Object.entries(headers));
  const requestHeaders = {
    get: (key) => headersMap.get(key.toLowerCase()),
    has: (key) => headersMap.has(key.toLowerCase()),
    entries: () => headersMap.entries(),
  };

  // Store body for async access
  let bodyData = body;
  
  const request = {
    method,
    url,
    headers: requestHeaders,
    params,
    query: new URLSearchParams(),
    // v4 async methods
    json: async () => bodyData,
    text: async () => typeof bodyData === 'string' ? bodyData : JSON.stringify(bodyData),
    arrayBuffer: async () => {
      const text = typeof bodyData === 'string' ? bodyData : JSON.stringify(bodyData);
      return new TextEncoder().encode(text).buffer;
    },
    formData: async () => { throw new Error('FormData not implemented in test mock'); },
    blob: async () => { throw new Error('Blob not implemented in test mock'); },
  };

  return request;
};

// Helper to normalize Azure Functions v4 response
// Azure runtime automatically converts jsonBody to JSON string in body,
// but when testing directly we need to do this ourselves
const normalizeResponse = (response) => {
  if (!response) return response;
  
  // If response has jsonBody, convert to body
  if (response.jsonBody && !response.body) {
    return {
      ...response,
      body: JSON.stringify(response.jsonBody),
    };
  }
  
  return response;
};

module.exports = {
  createContext,
  createHttpRequest,
  normalizeResponse,
};
