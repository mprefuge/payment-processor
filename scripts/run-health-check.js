#!/usr/bin/env node

const path = require('path');

async function main() {
  const handlerPath = path.join(__dirname, '..', 'dist', 'handlers', 'healthCheck');
  let handler;
  try {
    handler = require(handlerPath);
  } catch (error) {
    console.error('Failed to load compiled health check handler from dist/.');
    console.error('Ensure `npm run build` has been executed before running the health check script.');
    throw error;
  }

  const context = {
    invocationId: 'ci-health-check',
    log: (...args) => console.log('[health-check]', ...args),
    bindingData: {},
    bindings: {},
    res: undefined
  };

  await handler(context, { method: 'GET', url: '/api/health' });

  const { res } = context;
  if (!res) {
    throw new Error('Health check handler did not set a response.');
  }

  const { status, body } = res;
  if (status !== 200) {
    console.error('Health check failed with HTTP status:', status);
    throw new Error('Health check returned a non-success status code.');
  }

  const normalizedBody = body || {};
  const overallStatus = normalizedBody.status || 'unknown';

  console.log('[health-check] Response body:\n', JSON.stringify(normalizedBody, null, 2));

  if (overallStatus !== 'ok') {
    const components = Array.isArray(normalizedBody.components)
      ? normalizedBody.components.map(component => `${component.component}: ${component.status}`).join(', ')
      : 'no component details available';
    throw new Error(`Health check reported status "${overallStatus}" (${components}).`);
  }

  console.log('[health-check] Health check completed successfully.');
}

main().catch(error => {
  console.error('[health-check] ❌', error.message);
  process.exitCode = 1;
});
