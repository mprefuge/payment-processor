import React, { useState, useCallback } from 'react';
import {
  DndContext,
  DragOverlay,
  closestCenter,
  PointerSensor,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import { SortableContext, verticalListSortingStrategy, arrayMove } from '@dnd-kit/sortable';

import { useEditorState } from './useEditorState';
import { createDefaultField, getFieldMeta } from './fieldTypes';
import Topbar from './components/Topbar';
import Sidebar from './components/Sidebar';
import Canvas from './components/Canvas';
import Inspector from './components/Inspector';
import './main.css';

export default function App() {
  const { state, dispatch } = useEditorState();
  const [activeDrag, setActiveDrag] = useState(null);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } })
  );

  const handleDragStart = useCallback(({ active }) => {
    setActiveDrag(active.data.current);
  }, []);

  const handleDragEnd = useCallback(
    ({ active, over }) => {
      setActiveDrag(null);
      if (!over) return;

      const aData = active.data.current;
      const oData = over.data.current;
      if (!aData || !oData) return;

      if (aData.source === 'palette') {
        // ── Dropped from the sidebar palette ───────────────────────────────────
        const field = createDefaultField(aData.fieldType);

        if (oData.type === 'field') {
          // Drop onto an existing field → insert before it in its row
          dispatch({
            type: 'ADD_FIELD_BEFORE',
            payload: { pageIdx: oData.pageIdx, rowId: oData.rowId, beforeFieldId: oData.fieldId, field },
          });
        } else if (oData.type === 'row') {
          // Drop onto row background → append to that row
          dispatch({
            type: 'ADD_FIELD_TO_ROW',
            payload: { pageIdx: oData.pageIdx, rowId: oData.rowId, field },
          });
        } else if (oData.type === 'row-gap') {
          // Drop between rows or on empty page → new row
          dispatch({
            type: 'ADD_FIELD_IN_NEW_ROW',
            payload: { pageIdx: oData.pageIdx, afterRowId: oData.afterRowId, field },
          });
        }
      } else if (aData.source === 'field') {
        // ── Moving an existing canvas field ────────────────────────────────────
        const { fieldId, rowId: fromRowId, pageIdx: fromPageIdx } = aData;

        if (oData.type === 'field' && oData.fieldId !== fieldId) {
          if (oData.rowId === fromRowId && oData.pageIdx === fromPageIdx) {
            // Same row reorder
            dispatch({
              type: 'REORDER_FIELDS_IN_ROW',
              payload: { pageIdx: fromPageIdx, rowId: fromRowId, fromFieldId: fieldId, toFieldId: oData.fieldId },
            });
          } else {
            // Cross-row move, insert before target field
            dispatch({
              type: 'MOVE_FIELD_TO_ROW',
              payload: {
                fromPageIdx,
                fromRowId,
                fieldId,
                toPageIdx: oData.pageIdx,
                toRowId: oData.rowId,
                beforeFieldId: oData.fieldId,
              },
            });
          }
        } else if (oData.type === 'row' && (oData.rowId !== fromRowId || oData.pageIdx !== fromPageIdx)) {
          // Move to different row (append to end)
          dispatch({
            type: 'MOVE_FIELD_TO_ROW',
            payload: {
              fromPageIdx,
              fromRowId,
              fieldId,
              toPageIdx: oData.pageIdx,
              toRowId: oData.rowId,
              beforeFieldId: null,
            },
          });
        } else if (oData.type === 'row-gap') {
          // Move field to a new standalone row
          dispatch({
            type: 'MOVE_FIELD_TO_NEW_ROW',
            payload: { fromPageIdx, fromRowId, fieldId, toPageIdx: oData.pageIdx, afterRowId: oData.afterRowId },
          });
        } else if (oData.type === 'row-handle') {
          // Reorder rows via drag handle
          const toRowId = oData.rowId;
          const toPageIdx = oData.pageIdx;
          if (toPageIdx === fromPageIdx && toRowId !== fromRowId) {
            const page = state.pages[fromPageIdx];
            if (page) {
              const fromIdx = page.rows.findIndex((r) => r.id === fromRowId);
              const toIdx = page.rows.findIndex((r) => r.id === toRowId);
              if (fromIdx >= 0 && toIdx >= 0) {
                dispatch({ type: 'REORDER_ROWS', payload: { pageIdx: fromPageIdx, fromIdx, toIdx } });
              }
            }
          }
        }
      }
    },
    [state, dispatch]
  );

  const selectedPage = state.pages[state.selectedPageIdx] ?? state.pages[0];
  const accent = state.branding?.accentColor || '#bd2135';

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
    >
      <div className="vb-app">
        <Topbar state={state} dispatch={dispatch} />
        <div className="vb-body">
          <Sidebar isDragging={!!activeDrag} />
          <Canvas
            state={state}
            dispatch={dispatch}
            page={selectedPage}
            pageIdx={state.selectedPageIdx}
            accent={accent}
          />
          <Inspector state={state} dispatch={dispatch} />
        </div>
      </div>

      <DragOverlay dropAnimation={null}>
        {activeDrag?.source === 'palette' && (
          <div className="vb-drag-overlay palette">
            <span>{getFieldMeta(activeDrag.fieldType).icon}</span>
            <span>{getFieldMeta(activeDrag.fieldType).label}</span>
          </div>
        )}
        {activeDrag?.source === 'field' && (
          <div className="vb-drag-overlay field">
            <span>{getFieldMeta(activeDrag.fieldType)?.icon || '▦'}</span>
            <span>{activeDrag.label}</span>
          </div>
        )}
      </DragOverlay>
    </DndContext>
  );
}
