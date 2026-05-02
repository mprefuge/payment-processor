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
    async values() {
      return Array.from(map.values()).map((value) => JSON.parse(JSON.stringify(value)));
    },
    async delete(key) {
      return map.delete(key);
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

  it('lists records and updates existing ids in place', async () => {
    const store = new FormConfigStore({ storage: createMemoryStorage() });

    const first = await store.save({ name: 'Micah Test Form One' });
    const second = await store.save({ name: 'Micah Test Form Two' });

    const listed = await store.list();
    expect(listed.length).toBe(2);
    expect(listed.some((record) => record.id === first.id)).toBe(true);
    expect(listed.some((record) => record.id === second.id)).toBe(true);

    const updated = await store.save({ id: first.id, name: 'Micah Test Form One Updated' });
    expect(updated.id).toBe(first.id);
    expect(updated.config.name).toBe('Micah Test Form One Updated');

    const reloaded = await store.get(first.id);
    expect(reloaded.config.name).toBe('Micah Test Form One Updated');
  });

  it('deletes saved records by id', async () => {
    const store = new FormConfigStore({ storage: createMemoryStorage() });
    const saved = await store.save({ name: 'Micah Test Delete Form' });

    const deleted = await store.delete(saved.id);
    expect(deleted).toBe(true);

    const loaded = await store.get(saved.id);
    expect(loaded).toBeNull();
  });

  it('normalizes page structures and custom content sections', async () => {
    const store = new FormConfigStore({ storage: createMemoryStorage() });

    const saved = await store.save({
      name: 'Micah Test Multi Page Form',
      sections: [
        { id: 'hero', label: 'Custom Hero' },
        {
          type: 'content',
          label: 'Why This Matters',
          description: 'Campaign context',
          settings: { body: 'Line one\nLine two' },
        },
      ],
      pages: [
        {
          id: 'page_intro',
          name: 'Intro',
          description: 'Opening page',
          sectionIds: ['hero'],
        },
      ],
    });

    expect(saved.config.pages.length).toBeGreaterThan(0);
    expect(saved.config.pages[0].name).toBe('Intro');
    expect(saved.config.sections.some((section) => section.id === 'hero')).toBe(true);
    expect(saved.config.sections.some((section) => section.type === 'content')).toBe(true);
    expect(saved.config.pages.some((page) => page.sectionIds.includes('hero'))).toBe(true);
  });
});
