require('../preflight');

const { buildSalesforceConfig, SalesforceService } = require('../services/salesforceService');

let _svc = null;
function getSvc() {
  if (!_svc) _svc = new SalesforceService(buildSalesforceConfig());
  return _svc;
}

// SF field types that map to each broad category we use on the frontend for filtering.
// Kept here as authoritative reference; the frontend mirrors these.
const WRITABLE_SF_TYPES = new Set([
  'string',
  'textarea',
  'email',
  'phone',
  'url',
  'id',
  'reference',
  'picklist',
  'multipicklist',
  'combobox',
  'boolean',
  'double',
  'integer',
  'long',
  'currency',
  'percent',
  'date',
  'datetime',
  'time',
  'base64', // file bytes
]);

// System fields we never surface as mapping targets
const SYSTEM_FIELD_NAMES = new Set([
  'Id',
  'IsDeleted',
  'SystemModstamp',
  'CreatedById',
  'LastModifiedById',
  'CreatedDate',
  'LastModifiedDate',
  'LastActivityDate',
  'LastViewedDate',
  'LastReferencedDate',
  'MasterRecordId',
  'RecordTypeId',
]);

/**
 * GET /api/form-builder/sf/fields/{objectName}
 *
 * Describes the fields of the given Salesforce object and returns a filtered,
 * sorted list suitable for use in the form-builder field-mapping UI.
 *
 * Response: { objectName, fields: [{ name, label, type, required, custom, length, picklistValues }] }
 */
module.exports = async function donationFormSfFields(request) {
  const objectName = request?.params?.objectName;
  if (!objectName || !/^[A-Za-z][A-Za-z0-9_]*$/.test(objectName)) {
    return {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Invalid or missing objectName parameter.' }),
    };
  }

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
    const meta = await conn.describe(objectName);

    const fields = (meta.fields || [])
      .filter(
        (f) =>
          (f.createable || f.updateable) &&
          WRITABLE_SF_TYPES.has(f.type) &&
          !SYSTEM_FIELD_NAMES.has(f.name)
      )
      .map((f) => ({
        name: f.name,
        label: f.label,
        type: f.type,
        required: !f.nillable && !f.defaultedOnCreate,
        custom: f.custom,
        length: f.length || f.precision || null,
        picklistValues:
          (f.type === 'picklist' || f.type === 'multipicklist') && Array.isArray(f.picklistValues)
            ? f.picklistValues
                .filter((p) => p.active)
                .map((p) => ({ label: p.label, value: p.value }))
            : [],
      }))
      .sort((a, b) => {
        // Sort: standard fields first, then custom; alpha within each group
        if (a.custom !== b.custom) return a.custom ? 1 : -1;
        return a.label.localeCompare(b.label);
      });

    return {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'private, max-age=300',
      },
      body: JSON.stringify({ objectName, fields }),
    };
  } catch (err) {
    const isNotFound =
      err.errorCode === 'NOT_FOUND' ||
      err.statusCode === 404 ||
      (err.message &&
        (err.message.includes('NOT_FOUND') || err.message.includes('does not exist')));
    if (isNotFound) {
      return {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: `Salesforce object '${objectName}' not found.` }),
      };
    }
    _svc = null;
    return {
      status: 502,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        error: 'Failed to retrieve Salesforce fields.',
        details: err.message,
      }),
    };
  }
};

module.exports.__internals = {
  resetService: () => {
    _svc = null;
  },
};
