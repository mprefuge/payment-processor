import { describe, it, expect } from 'vitest';

const {
  FormConfigStore,
  normalizeDonationFormConfig,
} = require('../src/services/formBuilder/formConfigStore');

const createMemoryStorage = () => {
  const map = new Map();
  return {
    async get(key) {
      return map.has(key) ? JSON.parse(JSON.stringify(map.get(key))) : null;
    },
    async set(key, value) {
      map.set(key, JSON.parse(JSON.stringify(value)));
      return value;
    },
  };
};

describe('formConfigStore', () => {
  it('normalizes sparse configs with defaults', () => {
    const normalized = normalizeDonationFormConfig({
      branding: { title: 'Micah Test Builder' },
      payment: { amountPresets: [250, 'bad', 0, 50] },
      sections: [{ id: 'submit', label: 'Complete Gift', enabled: true }],
    });

    expect(normalized.branding.title).toBe('Micah Test Builder');
    expect(normalized.branding.submitLabel).toBe('Donate now');
    expect(normalized.payment.amountPresets).toEqual([250, 50]);
    expect(normalized.sections[0].id).toBe('submit');
    expect(normalized.sections.some((section) => section.id === 'hero')).toBe(true);
  });

  it('saves and retrieves a config record', async () => {
    const store = new FormConfigStore({ storage: createMemoryStorage() });

    const saved = await store.save({
      name: 'Micah Test Form',
      payment: { categories: ['General Giving', 'Micah Test Campaign'] },
    });

    expect(saved.id).toBeTruthy();
    expect(saved.config.name).toBe('Micah Test Form');
    expect(saved.config.payment.categories).toEqual(['General Giving', 'Micah Test Campaign']);

    const loaded = await store.get(saved.id);
    expect(loaded).toEqual(saved);
  });
});
