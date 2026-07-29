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

const parseInteger = (value, defaultValue) => {
  const parsed = Number.parseInt(String(value ?? '').trim(), 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : defaultValue;
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

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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

const isPlainObject = (value) =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

/** Deep merge where `override` wins, used to layer the configured payload over the template. */
const mergeDeep = (base, override) => {
  if (!isPlainObject(base) || !isPlainObject(override)) {
    return override === undefined ? base : override;
  }

  const merged = { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (value === undefined) {
      continue;
    }
    merged[key] =
      isPlainObject(value) && isPlainObject(base[key]) ? mergeDeep(base[key], value) : value;
  }

  return merged;
};

/**
 * A payload that fills in every input `POST /api/transaction` accepts, so every
 * field the flow can populate downstream actually gets a value to route.
 *
 * The configured `SMOKE_TRANSACTION_PAYLOAD` is layered on top of this, so a
 * minimal secret still produces full field coverage while any value it does set
 * still wins.
 *
 * `organization` and `campaign` deliberately use stable names: the Salesforce
 * Account and Campaign they resolve to are created on first use and reused
 * forever after. Cleanup does not delete them, so a per-run name would leak a
 * new Account and Campaign on every single run.
 */
const buildFullCoverageTemplate = (organizationName, campaignName) => ({
  amount: 5000,
  // Keep `onetime`: payment-mode sessions carry amount_total and a payment intent
  // at creation, both of which the verification step checks. Subscription-mode
  // sessions populate neither until the first invoice is paid.
  frequency: 'onetime',
  attribution: 'Deployment Smoke Test',
  category: campaignName,
  transactionType: 'Deployment Smoke Test',
  paymentMethod: 'card',
  coverFee: true,
  feeAmount: 175,
  organization: organizationName,
  customer: {
    email: 'deployment.smoke@example.invalid',
    firstname: 'Deployment',
    lastname: 'Smoke',
    phone: '+15555550100',
    organization: organizationName,
    address: {
      line1: '123 Deployment Way',
      city: 'Austin',
      state: 'TX',
      postal_code: '78701',
      country: 'US',
    },
  },
  metadata: {
    campaign: campaignName,
  },
});

/** Rewrites `local@domain` to `local+suffix@domain` so each run gets fresh records. */
const uniquifyEmail = (email, suffix) => {
  const atIndex = email.lastIndexOf('@');
  if (atIndex <= 0) {
    return email;
  }

  const local = email.slice(0, atIndex);
  const domain = email.slice(atIndex + 1);
  const normalizedSuffix = suffix.replace(/[^A-Za-z0-9._-]/g, '-');

  return `${local.split('+')[0]}+${normalizedSuffix}@${domain}`;
};

const buildTaggedPayload = (rawPayload, tag, options) => {
  const configured = JSON.parse(rawPayload);
  const template = buildFullCoverageTemplate(options.organizationName, options.campaignName);
  const payload = options.fullCoverage ? mergeDeep(template, configured) : configured;

  const metadata = isPlainObject(payload.metadata) ? { ...payload.metadata } : {};
  metadata.source_test_tag = tag;
  if (typeof metadata.memo__c !== 'string' || metadata.memo__c.trim().length === 0) {
    metadata.memo__c = `Deployment smoke test | [source_test_tag:${tag}]`;
  }

  const customer = isPlainObject(payload.customer) ? { ...payload.customer } : {};
  const email = typeof customer.email === 'string' ? customer.email : payload.email;

  // A run that reuses an email matches the Contact and Stripe customer a previous
  // run left behind, and the matched-contact path only backfills a subset of
  // fields — which reads as a routing failure that isn't one.
  if (options.uniqueEmail && typeof email === 'string') {
    const uniqueEmail = uniquifyEmail(email, tag);
    if (isPlainObject(payload.customer)) {
      customer.email = uniqueEmail;
    } else {
      payload.email = uniqueEmail;
    }
  }

  return {
    ...payload,
    ...(isPlainObject(payload.customer) ? { customer } : {}),
    metadata,
  };
};

const centsToMajorUnits = (cents) =>
  typeof cents === 'number' && Number.isFinite(cents) ? Math.round(cents) / 100 : null;

/**
 * Derives, from the payload that was actually posted, the value each downstream
 * field must hold. This is the half of verification that depends on the request;
 * the cross-system id links are derived server-side.
 */
const buildExpectedFields = (payload) => {
  const customer = isPlainObject(payload.customer) ? payload.customer : payload;
  const address = isPlainObject(customer.address) ? customer.address : {};
  const firstName = customer.firstname ?? customer.firstName;
  const lastName = customer.lastname ?? customer.lastName;
  const fullName = [firstName, lastName].filter(Boolean).join(' ');
  const postalCode = address.postal_code ?? address.postalCode ?? customer.zipcode;
  const country = address.country ?? 'US';

  const feeAmount =
    payload.coverFee && typeof payload.feeAmount === 'number' ? payload.feeAmount : 0;
  const grossAmount = centsToMajorUnits(payload.amount + feeAmount);

  const expected = {
    'stripe.customer': {
      email: customer.email,
      name: fullName,
      phone: customer.phone,
      'address.line1': address.line1,
      'address.city': address.city ?? customer.city,
      'address.state': address.state ?? customer.state,
      'address.postal_code': postalCode,
      'address.country': country,
      'metadata.memo__c': payload.metadata?.memo__c,
      'metadata.campaign': payload.metadata?.campaign,
    },
    'stripe.checkout_session': {
      mode: payload.frequency === 'onetime' ? 'payment' : 'subscription',
      currency: 'usd',
      amount_total: payload.amount + feeAmount,
      'metadata.category': payload.category ?? 'General',
      'metadata.frequency': payload.frequency,
      'metadata.transactionType': payload.transactionType ?? 'Payment',
      'metadata.campaign': payload.metadata?.campaign,
      'metadata.memo__c': payload.metadata?.memo__c,
      'metadata.cover_fees': payload.coverFee ? 'true' : undefined,
      'metadata.cover_fees_amount': payload.coverFee ? String(feeAmount) : undefined,
    },
    'salesforce.Contact': {
      FirstName: firstName,
      LastName: lastName,
      Email: customer.email,
      Phone: customer.phone,
      MailingStreet: address.line1,
      MailingCity: address.city ?? customer.city,
      MailingState: address.state ?? customer.state,
      MailingPostalCode: postalCode,
      MailingCountry: country,
    },
    'salesforce.Transaction__c': {
      transaction_type__c: 'charge',
      Status__c: 'Pending',
      Payment_Method__c: 'Pending',
      Amount_Gross__c: grossAmount,
      Cover_Fees__c: payload.coverFee ? true : undefined,
      Cover_Fees_Amount__c: payload.coverFee ? centsToMajorUnits(feeAmount) : undefined,
      Currency_ISO_Code__c: 'USD',
      Frequency__c: payload.frequency,
      Attribution__c: payload.attribution,
      Memo__c: payload.metadata?.memo__c,
    },
  };

  // Drop undefined entries so the server only compares values we actually sent.
  return Object.fromEntries(
    Object.entries(expected).map(([object, fields]) => [
      object,
      Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined)),
    ])
  );
};

/** Field paths the posted payload cannot populate, reported as warnings instead of failures. */
const buildOptionalFields = (payload) => {
  const customer = isPlainObject(payload.customer) ? payload.customer : payload;
  const address = isPlainObject(customer.address) ? customer.address : {};
  const optional = {
    'stripe.customer': [],
    'stripe.checkout_session': [],
    'salesforce.Contact': [],
    'salesforce.Transaction__c': [],
  };

  if (!customer.phone) {
    optional['stripe.customer'].push('phone');
    optional['salesforce.Contact'].push('Phone');
  }

  if (!address.line1 && !customer.address) {
    optional['stripe.customer'].push('address.line1');
    optional['salesforce.Contact'].push('MailingStreet');
  }

  if (!payload.coverFee) {
    optional['stripe.checkout_session'].push('metadata.cover_fees', 'metadata.cover_fees_amount');
    optional['salesforce.Transaction__c'].push('Cover_Fees__c', 'Cover_Fees_Amount__c');
  }

  if (!payload.organization && !customer.organization && !payload.metadata?.organization) {
    optional['salesforce.Transaction__c'].push('Account__c');
  }

  if (!payload.metadata?.campaign && !payload.category) {
    optional['stripe.customer'].push('metadata.campaign');
    optional['stripe.checkout_session'].push('metadata.campaign');
  }

  if (!payload.attribution) {
    optional['salesforce.Transaction__c'].push('Attribution__c');
  }

  return optional;
};

const assertHealthResponse = (response, body) => {
  const unhealthy = Array.isArray(body?.connections)
    ? body.connections
        .filter((connection) => connection?.status === 'unhealthy')
        .map((connection) => connection.name || connection.type || 'unknown')
    : [];

  if (!response.ok) {
    const detail = unhealthy.length > 0 ? ` Unhealthy connection(s): ${unhealthy.join(', ')}.` : '';
    throw new Error(
      `Health check returned non-2xx status ${response.status} (reported status: ${body?.status ?? 'unknown'}).${detail}`
    );
  }

  if (body?.status !== 'ok') {
    const detail = unhealthy.length > 0 ? ` Unhealthy connection(s): ${unhealthy.join(', ')}.` : '';
    throw new Error(
      `Health check reported status "${body?.status ?? 'unknown'}", expected "ok".${detail}`
    );
  }
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

const summarizeVerification = (body) => {
  const counts = body?.counts || {};
  const lines = [
    `Field verification: ${counts.ok ?? 0}/${counts.checked ?? 0} populated as expected ` +
      `(${counts.missing ?? 0} missing, ${counts.mismatched ?? 0} mismatched, ` +
      `${counts.notApplicable ?? 0} not applicable).`,
  ];

  for (const object of Array.isArray(body?.objects) ? body.objects : []) {
    lines.push(
      `  ${object.object}: ${object.found ? object.recordId || 'found' : 'NOT FOUND'} — ` +
        `${object.counts.ok}/${object.counts.checked} ok`
    );
  }

  for (const warning of Array.isArray(body?.warnings) ? body.warnings : []) {
    lines.push(`  WARNING ${warning}`);
  }

  return lines.join('\n');
};

/**
 * Polls the verification endpoint until every required field is populated.
 *
 * Retries exist for propagation, not for flakiness: Stripe search and the
 * Salesforce write both settle asynchronously after the transaction returns, so
 * an early check can legitimately see a half-written picture.
 */
const runVerification = async (verifyUrl, commonHeaders, payload, attempts, retryDelayMs) => {
  const body = {
    tag: payload.tag,
    liveMode: payload.liveMode,
    checkoutSessionId: payload.checkoutSessionId,
    expected: payload.expected,
    optionalFields: payload.optionalFields,
    requireOptional: payload.requireOptional,
  };

  let lastFailure = null;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const response = await fetch(verifyUrl, {
      method: 'POST',
      headers: { ...commonHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    // A 404 is not a verification result at all — the deployed app predates the
    // endpoint. Say so, because "Verification failed (404): Not Found" reads like
    // the records were checked and found wanting.
    if (response.status === 404) {
      throw new Error(
        `Verification endpoint ${verifyUrl} returned 404. The deployed app does not expose it — ` +
          'deploy this branch before running the flow against it, or set SMOKE_VERIFY_ENABLED=false ' +
          '(workflow input `verify_fields: false`) to run the flow without field verification.'
      );
    }

    // 422 means the records were read and did not match — retryable while the
    // writes are still settling. Any other non-2xx is a real failure.
    if (!response.ok && response.status !== 422) {
      const text = await response.text().catch(() => '');
      throw new Error(`Verification failed (${response.status}): ${text || response.statusText}`);
    }

    const verifyBody = await parseJson(response, 'Verification');

    if (verifyBody?.ok) {
      console.log(summarizeVerification(verifyBody));
      return verifyBody;
    }

    lastFailure = verifyBody;
    const failures = Array.isArray(verifyBody?.failures) ? verifyBody.failures : [];
    console.log(
      `Verification attempt ${attempt}/${attempts} incomplete (${failures.length} field(s) outstanding).`
    );

    if (attempt < attempts) {
      await delay(retryDelayMs);
    }
  }

  console.error(summarizeVerification(lastFailure));
  const failures = Array.isArray(lastFailure?.failures) ? lastFailure.failures : [];
  throw new Error(
    `Verification failed after ${attempts} attempt(s). Unpopulated or mismatched field(s):\n  ${
      failures.join('\n  ') || 'none reported'
    }`
  );
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
    await delay(propagationDelayMs);
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
  const verifyPath = process.env.SMOKE_VERIFY_PATH || '/api/ops/test-artifact-verify';
  const cleanupPath = process.env.SMOKE_CLEANUP_PATH || '/api/ops/test-artifact-cleanup';
  const functionKey = requireEnv('SMOKE_FUNCTION_KEY');
  const payload = requireEnv('SMOKE_TRANSACTION_PAYLOAD');
  const tag = process.env.SMOKE_TEST_TAG?.trim() || `deploy-smoke-${Date.now()}`;
  const cleanupLiveMode = parseBoolean(process.env.SMOKE_CLEANUP_LIVE_MODE, false);
  const deleteSalesforceContacts = parseBoolean(process.env.SMOKE_DELETE_SALESFORCE_CONTACTS, true);
  const propagationDelayMs = Math.max(
    0,
    parseInteger(process.env.SMOKE_SEARCH_PROPAGATION_DELAY_MS, 0)
  );
  const systems = (process.env.SMOKE_SYSTEMS || 'stripe,salesforce,qbo')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);

  const verifyEnabled = parseBoolean(process.env.SMOKE_VERIFY_ENABLED, true);
  const verifyDelayMs = Math.max(0, parseInteger(process.env.SMOKE_VERIFY_DELAY_MS, 30000));
  const verifyAttempts = Math.max(1, parseInteger(process.env.SMOKE_VERIFY_ATTEMPTS, 4));
  const verifyRetryDelayMs = Math.max(
    0,
    parseInteger(process.env.SMOKE_VERIFY_RETRY_DELAY_MS, 20000)
  );
  const verifyRequireOptional = parseBoolean(process.env.SMOKE_VERIFY_REQUIRE_OPTIONAL, false);
  const fullCoverage = parseBoolean(process.env.SMOKE_FULL_FIELD_COVERAGE, true);
  const uniqueEmail = parseBoolean(process.env.SMOKE_UNIQUE_EMAIL, true);
  const organizationName =
    process.env.SMOKE_ORGANIZATION_NAME?.trim() || 'Payment Processor Smoke Test Org';
  const campaignName = process.env.SMOKE_CAMPAIGN_NAME?.trim() || 'Deployment Smoke Test';
  const transactionLiveMode = /(?:\?|&)(?:mode=live|livemode=(?:true|1|yes|on))/i.test(
    transactionPath
  );

  const commonHeaders = {
    Accept: 'application/json',
    'x-functions-key': functionKey,
    'x-test-artifact-tag': tag,
  };

  const healthUrl = joinUrl(baseUrl, healthPath);
  const transactionUrl = joinUrl(baseUrl, transactionPath);
  const verifyUrl = joinUrl(baseUrl, verifyPath);
  const cleanupUrl = joinUrl(baseUrl, cleanupPath);

  console.log(`Running deployment smoke flow against ${baseUrl} with tag ${tag}`);

  // The health endpoint returns 503 (not 2xx) when degraded, so we fetch it
  // directly rather than via request(), which throws on non-2xx before we can
  // inspect the body to surface which connection(s) are unhealthy.
  const healthResponse = await fetch(healthUrl, { method: 'GET', headers: commonHeaders });
  const healthBody = await parseJson(healthResponse, 'Health check');
  if (healthBody == null || typeof healthBody !== 'object') {
    throw new Error('Health check did not return a JSON object.');
  }
  assertHealthResponse(healthResponse, healthBody);

  // Once the transaction request is dispatched, real data may exist in Stripe/Salesforce/QBO.
  // Cleanup must run in the finally block regardless of whether subsequent assertions pass.
  let smokeError = null;

  try {
    const taggedPayload = buildTaggedPayload(payload, tag, {
      fullCoverage,
      uniqueEmail,
      organizationName,
      campaignName,
    });

    const transactionBody = await request(
      transactionUrl,
      {
        method: 'POST',
        headers: {
          ...commonHeaders,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(taggedPayload),
      },
      'Transaction smoke test'
    );
    assertTransactionResponse(transactionBody);

    if (verifyEnabled) {
      if (verifyDelayMs > 0) {
        console.log(
          `Waiting ${verifyDelayMs}ms for the transaction to propagate before verifying...`
        );
        await delay(verifyDelayMs);
      }

      await runVerification(
        verifyUrl,
        commonHeaders,
        {
          tag,
          liveMode: transactionLiveMode,
          checkoutSessionId:
            typeof transactionBody?.id === 'string'
              ? transactionBody.id
              : typeof transactionBody?.sessionId === 'string'
                ? transactionBody.sessionId
                : undefined,
          expected: buildExpectedFields(taggedPayload),
          optionalFields: buildOptionalFields(taggedPayload),
          requireOptional: verifyRequireOptional,
        },
        verifyAttempts,
        verifyRetryDelayMs
      );
    } else {
      console.log('Field verification disabled (SMOKE_VERIFY_ENABLED=false).');
    }
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

module.exports = {
  __internals: {
    buildExpectedFields,
    buildFullCoverageTemplate,
    buildOptionalFields,
    buildTaggedPayload,
    mergeDeep,
    runVerification,
    uniquifyEmail,
  },
};

if (require.main === module) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
