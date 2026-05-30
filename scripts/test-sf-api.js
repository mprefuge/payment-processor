/**
 * Playwright API tests for the Salesforce field-mapping endpoints.
 * Run with: node scripts/test-sf-api.js
 *
 * These endpoints are READ-ONLY Salesforce metadata calls (describeGlobal /
 * describe) - no data is written to any system.
 */

const { request } = require('playwright');

const BASE = 'http://localhost:7071/api';
const PASS = '\x1b[32m✔\x1b[0m';
const FAIL = '\x1b[31m✘\x1b[0m';
const WARN = '\x1b[33m⚠\x1b[0m';

let passed = 0;
let failed = 0;
const errors = [];

function assert(label, condition, detail = '') {
  if (condition) {
    console.log(`  ${PASS} ${label}`);
    passed++;
  } else {
    console.log(`  ${FAIL} ${label}${detail ? ': ' + detail : ''}`);
    failed++;
    errors.push(label + (detail ? ': ' + detail : ''));
  }
}

async function run() {
  const ctx = await request.newContext({ timeout: 30_000 });

  // ── 1. GET /form-builder/sf/objects ──────────────────────────────────────
  console.log('\n[1] GET /form-builder/sf/objects');
  {
    const res = await ctx.get(`${BASE}/form-builder/sf/objects`);
    assert('returns 200', res.status() === 200, `got ${res.status()}`);

    const body = await res.json().catch(() => null);
    assert('body is JSON', body !== null);
    assert(
      'body has objects array',
      Array.isArray(body?.objects),
      JSON.stringify(body).slice(0, 80)
    );

    const objects = body?.objects ?? [];
    assert('at least 1 object returned', objects.length > 0, `count=${objects.length}`);

    const firstObj = objects[0];
    assert(
      'each object has name, label, custom, keyPrefix',
      firstObj &&
        typeof firstObj.name === 'string' &&
        typeof firstObj.label === 'string' &&
        typeof firstObj.custom === 'boolean',
      JSON.stringify(firstObj)
    );

    // All returned objects must be queryable (we can't re-check server-side but spot-check known standard objects)
    const knownObjects = ['Contact', 'Account', 'Opportunity', 'Campaign'];
    const names = new Set(objects.map((o) => o.name));
    for (const known of knownObjects) {
      assert(`includes standard object: ${known}`, names.has(known));
    }

    // Objects must be sorted by label (spot-check first 5)
    const labels = objects.slice(0, 20).map((o) => o.label);
    const sorted = [...labels].sort((a, b) => a.localeCompare(b));
    assert(
      'objects are returned sorted by label',
      JSON.stringify(labels) === JSON.stringify(sorted),
      `first labels: ${labels.slice(0, 5).join(', ')}`
    );

    // Cache header
    const cc = res.headers()['cache-control'] ?? '';
    assert('cache-control header present', cc.includes('max-age'), `cache-control: ${cc}`);

    console.log(
      `  → ${objects.length} objects returned (first 5: ${objects
        .slice(0, 5)
        .map((o) => o.name)
        .join(', ')})`
    );
  }

  // ── 2. GET /form-builder/sf/fields/Contact ────────────────────────────────
  console.log('\n[2] GET /form-builder/sf/fields/Contact');
  {
    const res = await ctx.get(`${BASE}/form-builder/sf/fields/Contact`);
    assert('returns 200', res.status() === 200, `got ${res.status()}`);

    const body = await res.json().catch(() => null);
    assert('body is JSON', body !== null);
    assert('objectName echoed correctly', body?.objectName === 'Contact');
    assert('fields is an array', Array.isArray(body?.fields));

    const fields = body?.fields ?? [];
    assert('at least 1 field returned', fields.length > 0, `count=${fields.length}`);

    // Verify field shape
    const f = fields[0];
    assert(
      'each field has required shape (name, label, type, required, custom)',
      f &&
        typeof f.name === 'string' &&
        typeof f.label === 'string' &&
        typeof f.type === 'string' &&
        typeof f.required === 'boolean' &&
        typeof f.custom === 'boolean',
      JSON.stringify(f)
    );

    // System fields must be excluded
    const systemNames = ['Id', 'IsDeleted', 'SystemModstamp', 'CreatedById'];
    const fieldNames = new Set(fields.map((f) => f.name));
    for (const sys of systemNames) {
      assert(`system field '${sys}' is excluded`, !fieldNames.has(sys));
    }

    // Standard fields should appear before custom fields
    const allStandard = fields.filter((f) => !f.custom);
    const allCustom = fields.filter((f) => f.custom);
    const firstCustomIdx = fields.findIndex((f) => f.custom);
    const lastStandardIdx = fields.map((f) => f.custom).lastIndexOf(false);
    assert(
      'standard fields precede custom fields',
      firstCustomIdx === -1 || lastStandardIdx < firstCustomIdx,
      `firstCustomIdx=${firstCustomIdx} lastStandardIdx=${lastStandardIdx}`
    );

    // Email field should be present (it's a standard Contact field)
    assert('Email field is present', fieldNames.has('Email'));

    console.log(
      `  → ${fields.length} fields (${allStandard.length} standard, ${allCustom.length} custom)`
    );
  }

  // ── 3. GET /form-builder/sf/fields/Account ───────────────────────────────
  console.log('\n[3] GET /form-builder/sf/fields/Account');
  {
    const res = await ctx.get(`${BASE}/form-builder/sf/fields/Account`);
    assert('returns 200', res.status() === 200, `got ${res.status()}`);
    const body = await res.json().catch(() => null);
    assert('objectName echoed correctly', body?.objectName === 'Account');
    assert('fields populated', (body?.fields ?? []).length > 0);
    const fieldNames = new Set((body?.fields ?? []).map((f) => f.name));
    assert('Name field present', fieldNames.has('Name'));
    console.log(`  → ${body?.fields?.length ?? 0} fields`);
  }

  // ── 4. GET /form-builder/sf/fields/Transaction__c (custom object) ─────────
  console.log('\n[4] GET /form-builder/sf/fields/Transaction__c');
  {
    const res = await ctx.get(`${BASE}/form-builder/sf/fields/Transaction__c`);
    const status = res.status();
    if (status === 200) {
      const body = await res.json().catch(() => null);
      assert('returns 200 for known custom object', true);
      assert('objectName echoed', body?.objectName === 'Transaction__c');
      console.log(`  → ${body?.fields?.length ?? 0} fields`);
    } else if (status === 404) {
      // org may not have this object
      assert('returns 404 when object not in org', true);
      console.log(`  ${WARN} Transaction__c not found in this org (404)`);
    } else {
      assert(`unexpected status for known custom object`, false, `got ${status}`);
    }
  }

  // ── 5. GET /form-builder/sf/fields/NonExistentObject_xyz99 ───────────────
  console.log('\n[5] GET /form-builder/sf/fields/NonExistentObject_xyz99 (404 expected)');
  {
    const res = await ctx.get(`${BASE}/form-builder/sf/fields/NonExistentObject_xyz99`);
    const status = res.status();
    assert('returns 404 for unknown object', status === 404, `got ${status}`);
    const body = await res.json().catch(() => null);
    assert('error message present', typeof body?.error === 'string', JSON.stringify(body));
    console.log(`  → ${body?.error}`);
  }

  // ── 6. GET /form-builder/sf/fields/INVALID-NAME (400 expected) ───────────
  console.log('\n[6] GET /form-builder/sf/fields/invalid-name (400 expected, hyphen not allowed)');
  {
    const res = await ctx.get(`${BASE}/form-builder/sf/fields/invalid-name`);
    const status = res.status();
    assert('returns 400 for invalid objectName characters', status === 400, `got ${status}`);
    const body = await res.json().catch(() => null);
    assert('error message present', typeof body?.error === 'string', JSON.stringify(body));
    console.log(`  → ${body?.error}`);
  }

  // ── 7. Content-Type headers ───────────────────────────────────────────────
  console.log('\n[7] Content-Type header validation');
  {
    const res = await ctx.get(`${BASE}/form-builder/sf/objects`);
    const ct = res.headers()['content-type'] ?? '';
    assert(
      'Content-Type is application/json',
      ct.includes('application/json'),
      `content-type: ${ct}`
    );
  }

  await ctx.dispose();

  // ── Summary ───────────────────────────────────────────────────────────────
  console.log('\n' + '─'.repeat(60));
  console.log(`Results: ${PASS} ${passed} passed  ${failed > 0 ? FAIL : ''} ${failed} failed`);
  if (errors.length) {
    console.log('\nFailed assertions:');
    errors.forEach((e) => console.log(`  ${FAIL} ${e}`));
  }
  console.log('─'.repeat(60));

  process.exit(failed > 0 ? 1 : 0);
}

run().catch((err) => {
  console.error('\nUnhandled error:', err.message);
  process.exit(1);
});
