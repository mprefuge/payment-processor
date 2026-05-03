import { useReducer, useCallback } from 'react';
import { arrayMove } from '@dnd-kit/sortable';
import { createId, recalculateColumnWidths, deepClone } from './utils';
import { createDefaultField } from './fieldTypes';

// ─── Default config ──────────────────────────────────────────────────────────

function makeDefaultConfig() {
  const aId = createId('field');
  const fId = createId('field');
  const cId = createId('field');
  const dId = createId('field');
  return {
    name: 'Untitled Form',
    display: { mode: 'embedded' },
    branding: {
      accentColor: '#bd2135',
      logoUrl: '',
      title: 'Support Our Mission',
      subtitle: 'Your gift makes a difference.',
    },
    payment: {
      currency: 'USD',
      amountPresets: [25, 50, 100, 250],
      allowCustomAmount: true,
      processingFeePercent: 2.9,
      processingFeeFixed: 0.3,
    },
    pages: [
      {
        id: 'page_1',
        name: 'Donation',
        description: '',
        rows: [
          {
            id: createId('row'),
            columns: recalculateColumnWidths([
              {
                id: createId('col'),
                field: {
                  ...createDefaultField('amount_pills'),
                  id: aId,
                },
              },
            ]),
          },
          {
            id: createId('row'),
            columns: recalculateColumnWidths([
              {
                id: createId('col'),
                field: {
                  ...createDefaultField('donation_frequency'),
                  id: fId,
                },
              },
              {
                id: createId('col'),
                field: {
                  ...createDefaultField('category'),
                  id: cId,
                },
              },
            ]),
          },
        ],
      },
      {
        id: 'page_2',
        name: 'Donor Info',
        description: '',
        rows: [
          {
            id: createId('row'),
            columns: recalculateColumnWidths([
              {
                id: createId('col'),
                field: {
                  ...createDefaultField('full_name'),
                  id: dId,
                },
              },
            ]),
          },
          {
            id: createId('row'),
            columns: recalculateColumnWidths([
              { id: createId('col'), field: { ...createDefaultField('email'), id: createId('field') } },
              { id: createId('col'), field: { ...createDefaultField('phone'), id: createId('field') } },
            ]),
          },
        ],
      },
      {
        id: 'page_3',
        name: 'Payment',
        description: '',
        rows: [
          {
            id: createId('row'),
            columns: recalculateColumnWidths([
              { id: createId('col'), field: { ...createDefaultField('cover_fee'), id: createId('field') } },
            ]),
          },
          {
            id: createId('row'),
            columns: recalculateColumnWidths([
              { id: createId('col'), field: { ...createDefaultField('payment_method'), id: createId('field') } },
            ]),
          },
          {
            id: createId('row'),
            columns: recalculateColumnWidths([
              { id: createId('col'), field: { ...createDefaultField('card_input'), id: createId('field') } },
            ]),
          },
        ],
      },
    ],
  };
}

function createInitialState() {
  return {
    ...makeDefaultConfig(),
    formId: null,
    selectedPageIdx: 0,
    selectedFieldId: null,
    dirty: false,
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function findField(state, fieldId) {
  for (let pi = 0; pi < state.pages.length; pi++) {
    const page = state.pages[pi];
    for (const row of page.rows) {
      for (const col of row.columns) {
        if (col.field?.id === fieldId) return { pi, row, col };
      }
    }
  }
  return null;
}

function mapPages(pages, pageIdx, rowId, mapColumns) {
  return pages.map((page, pi) => {
    if (pi !== pageIdx) return page;
    return {
      ...page,
      rows: page.rows.map((row) => {
        if (row.id !== rowId) return row;
        return mapColumns(row);
      }),
    };
  });
}

// ─── Reducer ─────────────────────────────────────────────────────────────────

function reducer(state, action) {
  switch (action.type) {
    // ── Field additions ────────────────────────────────────────────────────

    case 'ADD_FIELD_TO_ROW': {
      const { pageIdx, rowId, field } = action.payload;
      const newField = { ...field, id: createId('field') };
      const newCol = { id: createId('col'), field: newField };
      const pages = mapPages(state.pages, pageIdx, rowId, (row) => ({
        ...row,
        columns: recalculateColumnWidths([...row.columns, newCol]),
      }));
      return { ...state, pages, selectedFieldId: newField.id, dirty: true };
    }

    case 'ADD_FIELD_BEFORE': {
      const { pageIdx, rowId, beforeFieldId, field } = action.payload;
      const newField = { ...field, id: createId('field') };
      const newCol = { id: createId('col'), field: newField };
      const pages = mapPages(state.pages, pageIdx, rowId, (row) => {
        const cols = [...row.columns];
        const idx = cols.findIndex((c) => c.field?.id === beforeFieldId);
        cols.splice(idx >= 0 ? idx : cols.length, 0, newCol);
        return { ...row, columns: recalculateColumnWidths(cols) };
      });
      return { ...state, pages, selectedFieldId: newField.id, dirty: true };
    }

    case 'ADD_FIELD_IN_NEW_ROW': {
      const { pageIdx, afterRowId, field } = action.payload;
      const newField = { ...field, id: createId('field') };
      const newRow = {
        id: createId('row'),
        columns: [{ id: createId('col'), width: 12, field: newField }],
      };
      const pages = state.pages.map((page, pi) => {
        if (pi !== pageIdx) return page;
        const rows = [...page.rows];
        const afterIdx = afterRowId ? rows.findIndex((r) => r.id === afterRowId) : -1;
        rows.splice(afterIdx >= 0 ? afterIdx + 1 : rows.length, 0, newRow);
        return { ...page, rows };
      });
      return { ...state, pages, selectedFieldId: newField.id, dirty: true };
    }

    // ── Field removal ──────────────────────────────────────────────────────

    case 'REMOVE_FIELD': {
      const { pageIdx, fieldId } = action.payload;
      const pages = state.pages.map((page, pi) => {
        if (pi !== pageIdx) return page;
        const rows = page.rows
          .map((row) => {
            const columns = row.columns.filter((c) => c.field?.id !== fieldId);
            if (!columns.length) return null;
            return { ...row, columns: recalculateColumnWidths(columns) };
          })
          .filter(Boolean);
        return { ...page, rows };
      });
      return {
        ...state,
        pages,
        selectedFieldId: state.selectedFieldId === fieldId ? null : state.selectedFieldId,
        dirty: true,
      };
    }

    // ── Field reorder / move ───────────────────────────────────────────────

    case 'REORDER_FIELDS_IN_ROW': {
      const { pageIdx, rowId, fromFieldId, toFieldId } = action.payload;
      const pages = mapPages(state.pages, pageIdx, rowId, (row) => {
        const fromIdx = row.columns.findIndex((c) => c.field?.id === fromFieldId);
        const toIdx = row.columns.findIndex((c) => c.field?.id === toFieldId);
        if (fromIdx < 0 || toIdx < 0) return row;
        return { ...row, columns: arrayMove(row.columns, fromIdx, toIdx) };
      });
      return { ...state, pages, dirty: true };
    }

    case 'MOVE_FIELD_TO_ROW': {
      const { fromPageIdx, fromRowId, fieldId, toPageIdx, toRowId, beforeFieldId } = action.payload;
      let movedCol = null;

      // Remove from source
      let pages = state.pages.map((page, pi) => {
        if (pi !== fromPageIdx) return page;
        const rows = page.rows
          .map((row) => {
            if (row.id !== fromRowId) return row;
            const idx = row.columns.findIndex((c) => c.field?.id === fieldId);
            if (idx < 0) return row;
            movedCol = { ...row.columns[idx], id: createId('col') };
            const columns = row.columns.filter((c) => c.field?.id !== fieldId);
            if (!columns.length) return null;
            return { ...row, columns: recalculateColumnWidths(columns) };
          })
          .filter(Boolean);
        return { ...page, rows };
      });

      if (!movedCol) return state;

      // Insert into target
      pages = pages.map((page, pi) => {
        if (pi !== toPageIdx) return page;
        const rows = page.rows.map((row) => {
          if (row.id !== toRowId) return row;
          const cols = [...row.columns];
          if (beforeFieldId) {
            const bidx = cols.findIndex((c) => c.field?.id === beforeFieldId);
            cols.splice(bidx >= 0 ? bidx : cols.length, 0, movedCol);
          } else {
            cols.push(movedCol);
          }
          return { ...row, columns: recalculateColumnWidths(cols) };
        });
        return { ...page, rows };
      });

      return { ...state, pages, dirty: true };
    }

    case 'MOVE_FIELD_TO_NEW_ROW': {
      const { fromPageIdx, fromRowId, fieldId, toPageIdx, afterRowId } = action.payload;
      let movedField = null;

      let pages = state.pages.map((page, pi) => {
        if (pi !== fromPageIdx) return page;
        const rows = page.rows
          .map((row) => {
            if (row.id !== fromRowId) return row;
            const col = row.columns.find((c) => c.field?.id === fieldId);
            if (!col) return row;
            movedField = col.field;
            const columns = row.columns.filter((c) => c.field?.id !== fieldId);
            if (!columns.length) return null;
            return { ...row, columns: recalculateColumnWidths(columns) };
          })
          .filter(Boolean);
        return { ...page, rows };
      });

      if (!movedField) return state;

      const newRow = {
        id: createId('row'),
        columns: [{ id: createId('col'), width: 12, field: movedField }],
      };
      pages = pages.map((page, pi) => {
        if (pi !== toPageIdx) return page;
        const rows = [...page.rows];
        const afterIdx = afterRowId ? rows.findIndex((r) => r.id === afterRowId) : -1;
        rows.splice(afterIdx >= 0 ? afterIdx + 1 : rows.length, 0, newRow);
        return { ...page, rows };
      });

      return { ...state, pages, dirty: true };
    }

    // ── Column resize ──────────────────────────────────────────────────────

    case 'RESIZE_COLUMNS': {
      const { pageIdx, rowId, colAId, colBId, deltaUnits } = action.payload;
      const pages = mapPages(state.pages, pageIdx, rowId, (row) => {
        const colA = row.columns.find((c) => c.id === colAId);
        const colB = row.columns.find((c) => c.id === colBId);
        if (!colA || !colB) return row;
        const newAWidth = Math.max(2, Math.min(colA.width + deltaUnits, 10));
        const newBWidth = Math.max(2, colA.width + colB.width - newAWidth);
        return {
          ...row,
          columns: row.columns.map((c) => {
            if (c.id === colAId) return { ...c, width: newAWidth };
            if (c.id === colBId) return { ...c, width: newBWidth };
            return c;
          }),
        };
      });
      return { ...state, pages, dirty: true };
    }

    // ── Field settings ─────────────────────────────────────────────────────

    case 'UPDATE_FIELD': {
      const { fieldId, updates } = action.payload;
      const ref = findField(state, fieldId);
      if (!ref) return state;
      const pages = state.pages.map((page, pi) => {
        if (pi !== ref.pi) return page;
        return {
          ...page,
          rows: page.rows.map((row) => ({
            ...row,
            columns: row.columns.map((col) => {
              if (col.field?.id !== fieldId) return col;
              const newField = { ...col.field, ...updates };
              if (updates.settings) newField.settings = { ...col.field.settings, ...updates.settings };
              return { ...col, field: newField };
            }),
          })),
        };
      });
      return { ...state, pages, dirty: true };
    }

    // ── UI selection ───────────────────────────────────────────────────────

    case 'SELECT_FIELD':
      return { ...state, selectedFieldId: action.payload };

    case 'SELECT_PAGE':
      return { ...state, selectedPageIdx: action.payload, selectedFieldId: null };

    // ── Pages ──────────────────────────────────────────────────────────────

    case 'ADD_PAGE': {
      const newPage = {
        id: createId('page'),
        name: `Page ${state.pages.length + 1}`,
        description: '',
        rows: [],
      };
      return {
        ...state,
        pages: [...state.pages, newPage],
        selectedPageIdx: state.pages.length,
        selectedFieldId: null,
        dirty: true,
      };
    }

    case 'REMOVE_PAGE': {
      if (state.pages.length <= 1) return state;
      const pages = state.pages.filter((_, i) => i !== action.payload);
      const selectedPageIdx = Math.min(state.selectedPageIdx, pages.length - 1);
      return { ...state, pages, selectedPageIdx, selectedFieldId: null, dirty: true };
    }

    case 'UPDATE_PAGE': {
      const { pageIdx, updates } = action.payload;
      const pages = state.pages.map((p, i) => (i === pageIdx ? { ...p, ...updates } : p));
      return { ...state, pages, dirty: true };
    }

    case 'REORDER_PAGES': {
      const { from, to } = action.payload;
      const pages = arrayMove(state.pages, from, to);
      return { ...state, pages, selectedPageIdx: to, dirty: true };
    }

    case 'REORDER_ROWS': {
      const { pageIdx, fromIdx, toIdx } = action.payload;
      const pages = state.pages.map((page, pi) => {
        if (pi !== pageIdx) return page;
        return { ...page, rows: arrayMove(page.rows, fromIdx, toIdx) };
      });
      return { ...state, pages, dirty: true };
    }

    // ── Global settings ────────────────────────────────────────────────────

    case 'UPDATE_SETTINGS': {
      const { key, updates } = action.payload;
      if (key === 'root') return { ...state, ...updates, dirty: true };
      return { ...state, [key]: { ...state[key], ...updates }, dirty: true };
    }

    // ── Persistence ────────────────────────────────────────────────────────

    case 'LOAD_CONFIG': {
      const cfg = action.payload;
      return {
        ...createInitialState(),
        ...cfg,
        formId: cfg.id || cfg.formId || null,
        name: cfg.name || 'Untitled Form',
        selectedPageIdx: 0,
        selectedFieldId: null,
        dirty: false,
      };
    }

    case 'MARK_SAVED':
      return { ...state, dirty: false, formId: action.payload ?? state.formId };

    case 'RESET':
      return createInitialState();

    default:
      return state;
  }
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

export function useEditorState() {
  const [state, dispatch] = useReducer(reducer, null, createInitialState);

  const selectedField = useCallback(() => {
    if (!state.selectedFieldId) return null;
    for (const page of state.pages) {
      for (const row of page.rows) {
        for (const col of row.columns) {
          if (col.field?.id === state.selectedFieldId) return col.field;
        }
      }
    }
    return null;
  }, [state.selectedFieldId, state.pages]);

  const selectedPageIdx = useCallback(() => {
    if (!state.selectedFieldId) return state.selectedPageIdx;
    for (let pi = 0; pi < state.pages.length; pi++) {
      for (const row of state.pages[pi].rows) {
        for (const col of row.columns) {
          if (col.field?.id === state.selectedFieldId) return pi;
        }
      }
    }
    return state.selectedPageIdx;
  }, [state.selectedFieldId, state.pages, state.selectedPageIdx]);

  return { state, dispatch, selectedField, selectedPageIdx };
}
