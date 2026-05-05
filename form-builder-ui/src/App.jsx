import React, { useState, useCallback, useEffect } from 'react';
import {
  DndContext,
  DragOverlay,
  closestCenter,
  PointerSensor,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import { SortableContext, horizontalListSortingStrategy } from '@dnd-kit/sortable';

import { useEditorState } from './useEditorState';
import { createDefaultField, getFieldMeta } from './fieldTypes';
import Topbar from './components/Topbar';
import Sidebar from './components/Sidebar';
import Canvas from './components/Canvas';
import Inspector from './components/Inspector';
import './main.css';

export default function App() {
  const { state, dispatch, canUndo, canRedo } = useEditorState();
  const [activeDrag, setActiveDrag] = useState(null);
  const [devicePreview, setDevicePreview] = useState('desktop'); // desktop | tablet | mobile

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));

  // Keyboard shortcuts: Ctrl+Z / Ctrl+Y / Ctrl+Shift+Z
  useEffect(() => {
    function onKey(e) {
      const ctrl = e.ctrlKey || e.metaKey;
      if (ctrl && e.key === 'z' && !e.shiftKey) {
        e.preventDefault();
        dispatch({ type: 'UNDO' });
      } else if (ctrl && (e.key === 'y' || (e.key === 'z' && e.shiftKey))) {
        e.preventDefault();
        dispatch({ type: 'REDO' });
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [dispatch]);

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
        const field = createDefaultField(aData.fieldType);

        if (oData.type === 'field') {
          dispatch({
            type: 'ADD_FIELD_BEFORE',
            payload: {
              pageIdx: oData.pageIdx,
              rowId: oData.rowId,
              beforeFieldId: oData.fieldId,
              field,
            },
          });
        } else if (oData.type === 'row') {
          dispatch({
            type: 'ADD_FIELD_TO_ROW',
            payload: { pageIdx: oData.pageIdx, rowId: oData.rowId, field },
          });
        } else if (oData.type === 'row-gap') {
          dispatch({
            type: 'ADD_FIELD_IN_NEW_ROW',
            payload: { pageIdx: oData.pageIdx, afterRowId: oData.afterRowId, field },
          });
        }
      } else if (aData.source === 'field') {
        const { fieldId, rowId: fromRowId, pageIdx: fromPageIdx } = aData;

        if (oData.type === 'field' && oData.fieldId !== fieldId) {
          if (oData.rowId === fromRowId && oData.pageIdx === fromPageIdx) {
            dispatch({
              type: 'REORDER_FIELDS_IN_ROW',
              payload: {
                pageIdx: fromPageIdx,
                rowId: fromRowId,
                fromFieldId: fieldId,
                toFieldId: oData.fieldId,
              },
            });
          } else {
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
        } else if (
          oData.type === 'row' &&
          (oData.rowId !== fromRowId || oData.pageIdx !== fromPageIdx)
        ) {
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
          dispatch({
            type: 'MOVE_FIELD_TO_NEW_ROW',
            payload: {
              fromPageIdx,
              fromRowId,
              fieldId,
              toPageIdx: oData.pageIdx,
              afterRowId: oData.afterRowId,
            },
          });
        }
      } else if (aData.type === 'row-handle') {
        const { pageIdx } = aData;
        const page = state.pages[pageIdx];
        if (!page) return;
        const activeRowId = aData.rowId || active.id;
        const overRowId =
          oData?.rowId ||
          (typeof over.id === 'string' && over.id.startsWith('row_') ? over.id.slice(4) : over.id);
        const fromIdx = page.rows.findIndex((r) => r.id === activeRowId);
        const toIdx = page.rows.findIndex((r) => r.id === overRowId);
        if (fromIdx >= 0 && toIdx >= 0 && fromIdx !== toIdx) {
          dispatch({ type: 'REORDER_ROWS', payload: { pageIdx, fromIdx, toIdx } });
        }
      } else if (aData.type === 'page-tab') {
        const fromIdx = state.pages.findIndex((p) => p.id === active.id);
        const toIdx = state.pages.findIndex((p) => p.id === over.id);
        if (fromIdx >= 0 && toIdx >= 0 && fromIdx !== toIdx) {
          dispatch({ type: 'REORDER_PAGES', payload: { from: fromIdx, to: toIdx } });
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
        <Topbar
          state={state}
          dispatch={dispatch}
          canUndo={canUndo}
          canRedo={canRedo}
          devicePreview={devicePreview}
          setDevicePreview={setDevicePreview}
        />
        <div className="vb-body">
          <Sidebar isDragging={!!activeDrag} />
          <Canvas
            state={state}
            dispatch={dispatch}
            page={selectedPage}
            pageIdx={state.selectedPageIdx}
            accent={accent}
            devicePreview={devicePreview}
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
            <span>{getFieldMeta(activeDrag.fieldType)?.icon || 'â–¦'}</span>
            <span>{activeDrag.label}</span>
          </div>
        )}
      </DragOverlay>
    </DndContext>
  );
}
