const parseBoolean = (value, defaultValue = false) => {
  if (typeof value !== 'string') {
    return defaultValue;
  }

  const normalized = value.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) {
    return true;
  }
  if (['0', 'false', 'no', 'off'].includes(normalized)) {
    return false;
  }

  return defaultValue;
};

const requireEnv = (name) => {
  const value = process.env[name];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`Missing required environment variable ${name}.`);
  }

  return value.trim();
};

const joinUrl = (baseUrl, path) =>
  `${baseUrl.replace(/\/$/, '')}${path.startsWith('/') ? path : `/${path}`}`;

const parseJson = async (response, label) => {
  const text = await response.text();
  if (!text) {
    throw new Error(`${label} returned an empty response.`);
  }

  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(
      `${label} did not return valid JSON: ${error instanceof Error ? error.message : String(error)}`
    );
  }
};

const buildTaggedPayload = (rawPayload, tag) => {
  const payload = JSON.parse(rawPayload);
  const metadata =
    payload && typeof payload.metadata === 'object' && !Array.isArray(payload.metadata)
      ? { ...payload.metadata }
      : {};

  metadata.source_test_tag = tag;
  if (typeof metadata.memo__c !== 'string' || metadata.memo__c.trim().length === 0) {
    metadata.memo__c = `Deployment smoke test | [source_test_tag:${tag}]`;
  }

  return {
    ...payload,
    metadata,
  };
};

const assertTransactionResponse = (body) => {
  const hasSessionIndicator =
    typeof body?.checkoutUrl === 'string' ||
    typeof body?.url === 'string' ||
    typeof body?.sessionId === 'string' ||
    typeof body?.id === 'string';

  if (!hasSessionIndicator) {
    throw new Error('Transaction smoke response did not include a checkout/session indicator.');
  }
};

const assertCleanupResponse = (body) => {
  if (!Array.isArray(body?.results)) {
    throw new Error('Cleanup response did not include per-system results.');
  }

  const errors = body.results.flatMap((system) =>
    Array.isArray(system?.records)
      ? system.records
          .filter((record) => record?.status === 'error')
          .map(
            (record) =>
              `${system.system}:${record.type}:${record.id}:${record.message || 'unknown error'}`
          )
      : []
  );

  if (errors.length > 0) {
    throw new Error(`Cleanup reported errors: ${errors.join(' | ')}`);
  }

  const stripeSummary = body.results.find((system) => system?.system === 'stripe');
  if (!stripeSummary || !stripeSummary.counts || stripeSummary.counts.changed < 1) {
    throw new Error('Cleanup response did not report any Stripe artifacts being changed.');
  }
};

const request = async (url, init, label) => {
  const response = await fetch(url, init);
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`${label} failed (${response.status}): ${text || response.statusText}`);
  }

  return parseJson(response, label);
};

const runCleanup = async (
  cleanupUrl,
  commonHeaders,
  tag,
  cleanupLiveMode,
  systems,
  deleteSalesforceContacts,
  propagationDelayMs
) => {
  if (propagationDelayMs > 0) {
    console.log(`Waiting ${propagationDelayMs}ms for data propagation before cleanup...`);
    await new Promise((resolve) => setTimeout(resolve, propagationDelayMs));
  }

  const cleanupBody = await request(
    cleanupUrl,
    {
      method: 'POST',
      headers: {
        ...commonHeaders,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        tag,
        dryRun: false,
        liveMode: cleanupLiveMode,
        systems,
        deleteSalesforceContacts,
      }),
    },
    'Cleanup'
  );
  return cleanupBody;
};

const main = async () => {
  const baseUrl = requireEnv('SMOKE_BASE_URL');
  const healthPath = process.env.SMOKE_HEALTH_PATH || '/api/health';
  const transactionPath = process.env.SMOKE_TRANSACTION_PATH || '/api/transaction?mode=test';
  const cleanupPath = process.env.SMOKE_CLEANUP_PATH || '/api/ops/test-artifact-cleanup';
  const functionKey = requireEnv('SMOKE_FUNCTION_KEY');
  const payload = requireEnv('SMOKE_TRANSACTION_PAYLOAD');
  const tag = process.env.SMOKE_TEST_TAG?.trim() || `deploy-smoke-${Date.now()}`;
  const cleanupLiveMode = parseBoolean(process.env.SMOKE_CLEANUP_LIVE_MODE, false);
  const deleteSalesforceContacts = parseBoolean(process.env.SMOKE_DELETE_SALESFORCE_CONTACTS, true);
  const propagationDelayMs = Math.max(
    0,
    parseInt(process.env.SMOKE_SEARCH_PROPAGATION_DELAY_MS || '0', 10) || 0
  );
  const systems = (process.env.SMOKE_SYSTEMS || 'stripe,salesforce,qbo')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);

  const commonHeaders = {
    Accept: 'application/json',
    'x-functions-key': functionKey,
    'x-test-artifact-tag': tag,
  };

  const healthUrl = joinUrl(baseUrl, healthPath);
  const transactionUrl = joinUrl(baseUrl, transactionPath);
  const cleanupUrl = joinUrl(baseUrl, cleanupPath);

  console.log(`Running deployment smoke flow against ${baseUrl} with tag ${tag}`);

  const healthBody = await request(
    healthUrl,
    { method: 'GET', headers: commonHeaders },
    'Health check'
  );
  if (healthBody == null || typeof healthBody !== 'object') {
    throw new Error('Health check did not return a JSON object.');
  }

  // Once the transaction request is dispatched, real data may exist in Stripe/Salesforce/QBO.
  // Cleanup must run in the finally block regardless of whether subsequent assertions pass.
  let smokeError = null;

  try {
    const transactionBody = await request(
      transactionUrl,
      {
        method: 'POST',
        headers: {
          ...commonHeaders,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(buildTaggedPayload(payload, tag)),
      },
      'Transaction smoke test'
    );
    assertTransactionResponse(transactionBody);
  } catch (err) {
    smokeError = err;
  } finally {
    // Always attempt cleanup — the server may have partially committed data even if the
    // request threw a network error or the response assertion failed.
    try {
      const cleanupBody = await runCleanup(
        cleanupUrl,
        commonHeaders,
        tag,
        cleanupLiveMode,
        systems,
        deleteSalesforceContacts,
        propagationDelayMs
      );
      assertCleanupResponse(cleanupBody);
      console.log('Test artifact cleanup completed successfully.');
    } catch (cleanupErr) {
      const cleanupMessage = cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr);
      console.error(
        `WARNING: Cleanup failed — test data tagged [${tag}] may remain in production systems. Error: ${cleanupMessage}`
      );
      // Prefer surfacing the original smoke error; otherwise surface the cleanup error.
      if (!smokeError) {
        smokeError = cleanupErr;
      }
    }
  }

  if (smokeError) {
    throw smokeError;
  }

  console.log('Deployment smoke flow completed successfully.');
};

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
