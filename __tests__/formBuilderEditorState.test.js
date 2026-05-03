import { describe, it, expect } from 'vitest';
import { __internals } from '../form-builder-ui/src/useEditorState.js';
import { createDefaultField } from '../form-builder-ui/src/fieldTypes.js';

const { reducer, createInitialState } = __internals;

function reduce(state, type, payload) {
  return reducer(state, { type, payload });
}

function getFieldIds(page) {
  return page.rows.flatMap((row) => row.columns.map((col) => col.field?.id).filter(Boolean));
}

describe('form builder editor state workflows', () => {
  it('adds and removes pages with safe last-page guard', () => {
    const initial = createInitialState();
    const withPage = reduce(initial, 'ADD_PAGE');

    expect(withPage.pages).toHaveLength(initial.pages.length + 1);
    expect(withPage.selectedPageIdx).toBe(initial.pages.length);
    expect(withPage.dirty).toBe(true);

    const onePageState = { ...initial, pages: [initial.pages[0]], selectedPageIdx: 0 };
    const guarded = reduce(onePageState, 'REMOVE_PAGE', 0);

    expect(guarded.pages).toHaveLength(1);
    expect(guarded).toBe(onePageState);
  });

  it('updates page metadata', () => {
    const initial = createInitialState();
    const updated = reduce(initial, 'UPDATE_PAGE', {
      pageIdx: 0,
      updates: { name: 'Micah Test Updated Page', description: 'Custom description' },
    });

    expect(updated.pages[0].name).toBe('Micah Test Updated Page');
    expect(updated.pages[0].description).toBe('Custom description');
    expect(updated.dirty).toBe(true);
  });

  it('reorders pages and keeps selected index aligned to drop position', () => {
    const initial = createInitialState();
    const reordered = reduce(initial, 'REORDER_PAGES', { from: 0, to: 2 });

    expect(reordered.pages[2].id).toBe(initial.pages[0].id);
    expect(reordered.selectedPageIdx).toBe(2);
  });

  it('adds fields to an existing row and before another field', () => {
    const initial = createInitialState();
    const page = initial.pages[0];
    const row = page.rows[1];
    const beforeFieldId = row.columns[0].field.id;

    const added = reduce(initial, 'ADD_FIELD_TO_ROW', {
      pageIdx: 0,
      rowId: row.id,
      field: createDefaultField('text'),
    });

    expect(added.pages[0].rows[1].columns).toHaveLength(row.columns.length + 1);

    const inserted = reduce(added, 'ADD_FIELD_BEFORE', {
      pageIdx: 0,
      rowId: row.id,
      beforeFieldId,
      field: createDefaultField('number'),
    });

    expect(inserted.pages[0].rows[1].columns[0].field.type).toBe('number');
    expect(inserted.dirty).toBe(true);
  });

  it('adds new rows at top when dropped on first gap and after target row when provided', () => {
    const initial = createInitialState();
    const firstRowId = initial.pages[0].rows[0].id;

    const toTop = reduce(initial, 'ADD_FIELD_IN_NEW_ROW', {
      pageIdx: 0,
      afterRowId: null,
      field: createDefaultField('textarea'),
    });

    expect(toTop.pages[0].rows[0].columns[0].field.type).toBe('textarea');

    const afterFirst = reduce(initial, 'ADD_FIELD_IN_NEW_ROW', {
      pageIdx: 0,
      afterRowId: firstRowId,
      field: createDefaultField('checkbox'),
    });

    expect(afterFirst.pages[0].rows[1].columns[0].field.type).toBe('checkbox');
  });

  it('removes fields and deletes empty row, while clearing selected field', () => {
    const initial = createInitialState();
    const page = initial.pages[2];
    const rowWithSingleField = page.rows[0];
    const fieldId = rowWithSingleField.columns[0].field.id;

    const stateWithSelected = { ...initial, selectedFieldId: fieldId };
    const removed = reduce(stateWithSelected, 'REMOVE_FIELD', { pageIdx: 2, fieldId });

    expect(removed.pages[2].rows).toHaveLength(page.rows.length - 1);
    expect(removed.selectedFieldId).toBe(null);
    expect(removed.dirty).toBe(true);
  });

  it('reorders fields in same row and preserves all field ids', () => {
    const initial = createInitialState();
    const row = initial.pages[0].rows[1];
    const fromFieldId = row.columns[0].field.id;
    const toFieldId = row.columns[1].field.id;

    const reordered = reduce(initial, 'REORDER_FIELDS_IN_ROW', {
      pageIdx: 0,
      rowId: row.id,
      fromFieldId,
      toFieldId,
    });

    const ids = getFieldIds(reordered.pages[0]);
    expect(ids).toContain(fromFieldId);
    expect(ids).toContain(toFieldId);
    expect(reordered.pages[0].rows[1].columns[1].field.id).toBe(fromFieldId);
  });

  it('moves fields across rows and pages', () => {
    const initial = createInitialState();
    const sourceRow = initial.pages[0].rows[1];
    const targetRow = initial.pages[1].rows[1];
    const movedFieldId = sourceRow.columns[0].field.id;

    const moved = reduce(initial, 'MOVE_FIELD_TO_ROW', {
      fromPageIdx: 0,
      fromRowId: sourceRow.id,
      fieldId: movedFieldId,
      toPageIdx: 1,
      toRowId: targetRow.id,
      beforeFieldId: targetRow.columns[0].field.id,
    });

    expect(getFieldIds(moved.pages[0])).not.toContain(movedFieldId);
    expect(moved.pages[1].rows[1].columns[0].field.id).toBe(movedFieldId);
  });

  it('moves fields to new rows at top and after specific rows', () => {
    const initial = createInitialState();
    const sourceRow = initial.pages[1].rows[1];
    const fieldId = sourceRow.columns[0].field.id;

    const moveTop = reduce(initial, 'MOVE_FIELD_TO_NEW_ROW', {
      fromPageIdx: 1,
      fromRowId: sourceRow.id,
      fieldId,
      toPageIdx: 1,
      afterRowId: null,
    });

    expect(moveTop.pages[1].rows[0].columns[0].field.id).toBe(fieldId);

    const afterId = initial.pages[1].rows[0].id;
    const moveAfter = reduce(initial, 'MOVE_FIELD_TO_NEW_ROW', {
      fromPageIdx: 1,
      fromRowId: sourceRow.id,
      fieldId,
      toPageIdx: 1,
      afterRowId: afterId,
    });

    expect(moveAfter.pages[1].rows[1].columns[0].field.id).toBe(fieldId);
  });

  it('resizes adjacent columns within bounds', () => {
    const initial = createInitialState();
    const row = initial.pages[0].rows[1];
    const [colA, colB] = row.columns;

    const resized = reduce(initial, 'RESIZE_COLUMNS', {
      pageIdx: 0,
      rowId: row.id,
      colAId: colA.id,
      colBId: colB.id,
      deltaUnits: 2,
    });

    const updatedRow = resized.pages[0].rows[1];
    const aWidth = updatedRow.columns.find((c) => c.id === colA.id).width;
    const bWidth = updatedRow.columns.find((c) => c.id === colB.id).width;

    expect(aWidth).toBeGreaterThanOrEqual(2);
    expect(aWidth).toBeLessThanOrEqual(10);
    expect(bWidth).toBeGreaterThanOrEqual(2);
    expect(aWidth + bWidth).toBe(colA.width + colB.width);
  });

  it('normalizes malformed loaded configs so page/row rendering remains safe', () => {
    const initial = createInitialState();
    const loaded = reduce(initial, 'LOAD_CONFIG', {
      id: 'cfg_malformed',
      name: 'Micah Test Malformed',
      pages: [
        {
          id: 'page_bad',
          name: 'Broken Page',
          rows: [
            { id: 'row_ok', columns: [{ field: { type: 'email', label: 'Email' } }] },
            { id: 'row_empty', columns: [] },
          ],
        },
        {
          id: 'page_rows_missing',
          name: 'Missing Rows',
        },
      ],
    });

    expect(loaded.formId).toBe('cfg_malformed');
    expect(loaded.name).toBe('Micah Test Malformed');
    expect(Array.isArray(loaded.pages)).toBe(true);
    expect(loaded.pages[0].rows.length).toBeGreaterThan(0);
    expect(Array.isArray(loaded.pages[1].rows)).toBe(true);
    expect(loaded.pages[1].rows).toHaveLength(0);
    expect(loaded.pages[0].rows[0].columns[0].field.id).toBeTruthy();
    expect(loaded.pages[0].rows[0].columns[0].field.settings).toBeTruthy();
  });

  it('falls back to default pages when loaded config has no valid pages', () => {
    const initial = createInitialState();
    const loaded = reduce(initial, 'LOAD_CONFIG', {
      id: 'cfg_no_pages',
      name: 'Micah Test Empty',
      pages: null,
    });

    expect(loaded.formId).toBe('cfg_no_pages');
    expect(loaded.pages.length).toBeGreaterThan(0);
    expect(loaded.pages[0].rows.length).toBeGreaterThan(0);
    expect(loaded.dirty).toBe(false);
  });
});
