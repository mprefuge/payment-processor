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

function normalizeSections(value, fallback) {
  const fallbackById = new Map(fallback.map((section) => [section.id, clone(section)]));
  const normalized = [];

  if (Array.isArray(value)) {
    value.forEach((item) => {
      if (!item || typeof item !== 'object') {
        return;
      }

      const fallbackSection = fallbackById.get(item.id);
      if (!fallbackSection) {
        return;
      }

      normalized.push({
        ...fallbackSection,
        label: normalizeString(item.label, fallbackSection.label),
        description: normalizeString(item.description, fallbackSection.description),
        enabled: normalizeBoolean(item.enabled, fallbackSection.enabled),
      });
      fallbackById.delete(item.id);
    });
  }

  fallbackById.forEach((section) => {
    normalized.push(section);
  });

  return normalized;
}

function normalizeDonationFormConfig(input = {}) {
  const defaults = getDefaultDonationFormConfig();
  const config = input && typeof input === 'object' ? input : {};

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
    sections: normalizeSections(config.sections, defaults.sections),
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
