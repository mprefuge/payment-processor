require('../preflight');

const { buildSalesforceConfig, SalesforceService } = require('../services/salesforceService');

let _svc = null;
function getSvc() {
  if (!_svc) _svc = new SalesforceService(buildSalesforceConfig());
  return _svc;
}

/**
 * GET /api/form-builder/sf/objects
 *
 * Returns the list of Salesforce objects that:
 *  - are queryable + (createable OR updateable)
 *  - are not purely internal/hidden (customSetting=false, hidden=false)
 *
 * Response: { objects: [{ name, label, custom, keyPrefix }] }
 */
module.exports = async function donationFormSfObjects() {
  const config = buildSalesforceConfig();
  if (!config.clientId || !config.clientSecret) {
    return {
      status: 503,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Salesforce credentials are not configured on this server.' }),
    };
  }

  try {
    const conn = await getSvc().authenticate();
    const result = await conn.describeGlobal();

    const objects = (result.sobjects || [])
      .filter(
        (o) =>
          o.queryable &&
          (o.createable || o.updateable) &&
          !o.customSetting &&
          !o.hidden &&
          !o.isInterface,
      )
      .map((o) => ({
        name: o.name,
        label: o.label,
        custom: o.custom,
        keyPrefix: o.keyPrefix || null,
      }))
      .sort((a, b) => a.label.localeCompare(b.label));

    return {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'private, max-age=300',
      },
      body: JSON.stringify({ objects }),
    };
  } catch (err) {
    _svc = null; // reset so next request re-authenticates
    return {
      status: 502,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Failed to retrieve Salesforce objects.', details: err.message }),
    };
  }
};

module.exports.__internals = {
  resetService: () => { _svc = null; },
};
