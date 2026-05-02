const { randomUUID } = require('crypto');
const path = require('path');

const FileKeyValueStore = require('../idempotency/storage/fileKeyValueStore');
const { getBasePath } = require('../idempotency/storage/persistentStoreFactory');
const { getDefaultDonationFormConfig } = require('./defaultDonationFormConfig');

const STORAGE_FILE_NAME = 'donation-form-configs.json';

function clone(value) {
  return value === undefined ? value : JSON.parse(JSON.stringify(value));
}

function normalizeString(value, fallback) {
  if (typeof value !== 'string') {
    return fallback;
  }

  const trimmed = value.trim();
  return trimmed || fallback;
}

function normalizeBoolean(value, fallback) {
  if (typeof value === 'boolean') {
    return value;
  }

  return fallback;
}

function normalizeMode(value, fallback) {
  if (typeof value !== 'string') {
    return fallback;
  }

  const normalized = value.trim().toLowerCase();
  if (normalized === 'modal' || normalized === 'embedded') {
    return normalized;
  }

  return fallback;
}

function normalizeStringList(value, fallback) {
  if (!Array.isArray(value)) {
    return clone(fallback);
  }

  const normalized = value
    .map((item) => (typeof item === 'string' ? item.trim() : String(item || '').trim()))
    .filter(Boolean);

  return normalized.length ? normalized : clone(fallback);
}

function normalizeAmountPresets(value, fallback) {
  if (!Array.isArray(value)) {
    return clone(fallback);
  }

  const normalized = value
    .map((item) => Number(item))
    .filter((item) => Number.isFinite(item) && item > 0)
    .map((item) => Number(item.toFixed(2)));

  return normalized.length ? normalized : clone(fallback);
}

function normalizeSectionType(value, fallback) {
  if (typeof value !== 'string') {
    return fallback;
  }

  const normalized = value.trim().toLowerCase();
  if (
    normalized === 'hero' ||
    normalized === 'amount' ||
    normalized === 'donor' ||
    normalized === 'address' ||
    normalized === 'tribute' ||
    normalized === 'fees' ||
    normalized === 'submit' ||
    normalized === 'content'
  ) {
    return normalized;
  }

  return fallback;
}

function normalizeSectionSettings(value, type) {
  if (type !== 'content') {
    return undefined;
  }

  return {
    body: normalizeString(value && value.body, 'Add supporting copy for this step.'),
  };
}

function normalizeSectionIdList(value, validSectionIds) {
  if (!Array.isArray(value)) {
    return [];
  }

  const normalized = [];
  value.forEach((item) => {
    if (typeof item !== 'string') {
      return;
    }

    const trimmed = item.trim();
    if (!trimmed || !validSectionIds.has(trimmed) || normalized.includes(trimmed)) {
      return;
    }

    normalized.push(trimmed);
  });

  return normalized;
}

function normalizeSections(value, fallback) {
  const fallbackById = new Map(fallback.map((section) => [section.id, clone(section)]));
  const normalized = [];
  const seenIds = new Set();

  if (Array.isArray(value)) {
    value.forEach((item) => {
      if (!item || typeof item !== 'object') {
        return;
      }

      const rawId = typeof item.id === 'string' ? item.id.trim() : '';
      const fallbackSection = rawId ? fallbackById.get(rawId) : null;
      const fallbackType = fallbackSection ? fallbackSection.type || fallbackSection.id : 'content';
      const type = normalizeSectionType(item.type, fallbackType);
      if (!fallbackSection && type !== 'content') {
        return;
      }

      const id = rawId || (type === 'content' ? randomUUID() : type);
      if (!id || seenIds.has(id)) {
        return;
      }

      normalized.push({
        ...(fallbackSection || {}),
        id,
        type,
        label: normalizeString(
          item.label,
          fallbackSection ? fallbackSection.label : 'Content Block'
        ),
        description: normalizeString(
          item.description,
          fallbackSection ? fallbackSection.description : 'Supporting copy block.'
        ),
        enabled: normalizeBoolean(item.enabled, fallbackSection ? fallbackSection.enabled : true),
        settings: normalizeSectionSettings(item.settings, type),
      });
      seenIds.add(id);
      if (fallbackSection) {
        fallbackById.delete(id);
      }
    });
  }

  fallbackById.forEach((section) => {
    if (!seenIds.has(section.id)) {
      normalized.push(section);
    }
  });

  return normalized;
}

function normalizePages(value, fallback, sections) {
  const validSectionIds = new Set(sections.map((section) => section.id));
  const normalized = [];
  const seenPageIds = new Set();

  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      if (!item || typeof item !== 'object') {
        return;
      }

      const requestedId = typeof item.id === 'string' ? item.id.trim() : '';
      const id = requestedId || 'page_' + String(index + 1);
      if (seenPageIds.has(id)) {
        return;
      }

      normalized.push({
        id,
        name: normalizeString(item.name, 'Page ' + String(index + 1)),
        description: normalizeString(item.description, ''),
        sectionIds: normalizeSectionIdList(item.sectionIds, validSectionIds),
      });
      seenPageIds.add(id);
    });
  }

  if (!normalized.length) {
    fallback.forEach((page) => {
      normalized.push({
        id: page.id,
        name: page.name,
        description: page.description,
        sectionIds: normalizeSectionIdList(page.sectionIds, validSectionIds),
      });
    });
  }

  if (!normalized.length) {
    normalized.push({
      id: 'page_1',
      name: 'Page 1',
      description: '',
      sectionIds: [],
    });
  }

  const assignedIds = new Set();
  normalized.forEach((page) => {
    page.sectionIds = page.sectionIds.filter((sectionId) => {
      if (assignedIds.has(sectionId)) {
        return false;
      }

      assignedIds.add(sectionId);
      return true;
    });
  });

  const unassignedIds = sections
    .map((section) => section.id)
    .filter((sectionId) => !assignedIds.has(sectionId));

  if (unassignedIds.length) {
    normalized[normalized.length - 1].sectionIds =
      normalized[normalized.length - 1].sectionIds.concat(unassignedIds);
  }

  return normalized;
}

function normalizeDonationFormConfig(input = {}) {
  const defaults = getDefaultDonationFormConfig();
  const config = input && typeof input === 'object' ? input : {};
  const normalizedSections = normalizeSections(config.sections, defaults.sections);

  return {
    version: 1,
    name: normalizeString(config.name, defaults.name),
    branding: {
      organizationName: normalizeString(
        config.branding && config.branding.organizationName,
        defaults.branding.organizationName
      ),
      title: normalizeString(config.branding && config.branding.title, defaults.branding.title),
      description: normalizeString(
        config.branding && config.branding.description,
        defaults.branding.description
      ),
      logoUrl: normalizeString(
        config.branding && config.branding.logoUrl,
        defaults.branding.logoUrl
      ),
      accentColor: normalizeString(
        config.branding && config.branding.accentColor,
        defaults.branding.accentColor
      ),
      submitLabel: normalizeString(
        config.branding && config.branding.submitLabel,
        defaults.branding.submitLabel
      ),
    },
    display: {
      mode: normalizeMode(config.display && config.display.mode, defaults.display.mode),
      modalTriggerLabel: normalizeString(
        config.display && config.display.modalTriggerLabel,
        defaults.display.modalTriggerLabel
      ),
    },
    endpoints: {
      processDonationApi: normalizeString(
        config.endpoints && config.endpoints.processDonationApi,
        defaults.endpoints.processDonationApi
      ),
    },
    stripe: {
      livePublishableKey: normalizeString(
        config.stripe && config.stripe.livePublishableKey,
        defaults.stripe.livePublishableKey
      ),
      testPublishableKey: normalizeString(
        config.stripe && config.stripe.testPublishableKey,
        defaults.stripe.testPublishableKey
      ),
    },
    options: {
      allowRecurring: normalizeBoolean(
        config.options && config.options.allowRecurring,
        defaults.options.allowRecurring
      ),
      allowOrganizationGiving: normalizeBoolean(
        config.options && config.options.allowOrganizationGiving,
        defaults.options.allowOrganizationGiving
      ),
      collectAddress: normalizeBoolean(
        config.options && config.options.collectAddress,
        defaults.options.collectAddress
      ),
      enableTribute: normalizeBoolean(
        config.options && config.options.enableTribute,
        defaults.options.enableTribute
      ),
      enableFeeCoverage: normalizeBoolean(
        config.options && config.options.enableFeeCoverage,
        defaults.options.enableFeeCoverage
      ),
    },
    payment: {
      defaultFrequency: normalizeString(
        config.payment && config.payment.defaultFrequency,
        defaults.payment.defaultFrequency
      ),
      amountPresets: normalizeAmountPresets(
        config.payment && config.payment.amountPresets,
        defaults.payment.amountPresets
      ),
      categories: normalizeStringList(
        config.payment && config.payment.categories,
        defaults.payment.categories
      ),
    },
    sections: normalizedSections,
    pages: normalizePages(config.pages, defaults.pages || [], normalizedSections),
  };
}

function createDefaultStore() {
  const namespace = process.env.FORM_BUILDER_STORAGE_NAMESPACE || 'form-builder';
  const basePath = getBasePath(namespace);
  return new FileKeyValueStore({ filePath: path.join(basePath, STORAGE_FILE_NAME) });
}

class FormConfigStore {
  constructor({ storage } = {}) {
    this.storage = storage || createDefaultStore();
  }

  async save(configInput) {
    const input = configInput && typeof configInput === 'object' ? configInput : {};
    const requestedId = typeof input.id === 'string' ? input.id.trim() : '';
    const existing = requestedId ? await this.storage.get(requestedId) : null;
    const id = existing && existing.id ? existing.id : randomUUID();
    const normalizedConfig = normalizeDonationFormConfig(configInput);
    const now = new Date().toISOString();
    const record = {
      id,
      createdAt: existing && existing.createdAt ? existing.createdAt : now,
      updatedAt: now,
      config: normalizedConfig,
    };

    await this.storage.set(id, record);
    return clone(record);
  }

  async get(id) {
    if (!id) {
      return null;
    }

    const record = await this.storage.get(id);
    return record ? clone(record) : null;
  }

  async list() {
    const records = await this.storage.values();
    const sorted = records
      .filter((record) => record && record.id && record.config)
      .sort((a, b) => {
        const left = new Date(a.updatedAt || a.createdAt || 0).getTime();
        const right = new Date(b.updatedAt || b.createdAt || 0).getTime();
        return right - left;
      });

    return sorted.map((record) => ({
      id: record.id,
      name:
        (record.config && record.config.name) ||
        (record.config && record.config.branding && record.config.branding.title) ||
        'Untitled form',
      updatedAt: record.updatedAt || null,
      createdAt: record.createdAt || null,
      displayMode:
        record.config && record.config.display && record.config.display.mode
          ? record.config.display.mode
          : 'embedded',
    }));
  }

  async delete(id) {
    if (!id) {
      return false;
    }

    return this.storage.delete(id);
  }
}

module.exports = {
  FormConfigStore,
  createDefaultStore,
  normalizeDonationFormConfig,
};
