import React, { useRef, useCallback } from 'react';
import { useDroppable } from '@dnd-kit/core';
import { SortableContext, horizontalListSortingStrategy } from '@dnd-kit/sortable';
import { clamp } from '../utils';
import FieldBlock from './FieldBlock';

// Resize handle between two adjacent columns
function ResizeHandle({ pageIdx, rowId, colAId, colBId, dispatch, rowRef }) {
  const pointerStart = useRef(null);

  const onPointerDown = useCallback(
    (e) => {
      e.preventDefault();
      const row = rowRef.current;
      const containerWidth = row ? row.getBoundingClientRect().width : window.innerWidth;
      const unitWidth = containerWidth / 12;

      pointerStart.current = { x: e.clientX, unitWidth };
      const onMove = (me) => {
        if (!pointerStart.current) return;
        const delta = me.clientX - pointerStart.current.x;
        const deltaUnits = Math.round(delta / pointerStart.current.unitWidth);
        if (deltaUnits !== 0) {
          dispatch({
            type: 'RESIZE_COLUMNS',
            payload: { pageIdx, rowId, colAId, colBId, deltaUnits },
          });
          pointerStart.current = { ...pointerStart.current, x: me.clientX };
        }
      };
      const onUp = () => {
        pointerStart.current = null;
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
      };
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
    },
    [pageIdx, rowId, colAId, colBId, dispatch]
  );

  return (
    <div
      className="vb-col-resize-handle"
      onPointerDown={onPointerDown}
      title="Drag to resize columns"
    />
  );
}

// Droppable zone for the row itself
function RowDropZone({ rowId, pageIdx }) {
  const { setNodeRef, isOver } = useDroppable({
    id: `row_${rowId}`,
    data: { type: 'row', rowId, pageIdx },
  });
  return <div ref={setNodeRef} className={`vb-row-drop-bg${isOver ? ' drag-over' : ''}`} />;
}

export default function Row({
  row,
  page,
  pageIdx,
  selectedFieldId,
  dispatch,
  accent,
  dragHandleProps,
}) {
  const rowRef = useRef(null);

  return (
    <div className="vb-row" ref={rowRef} data-row-id={row.id}>
      <RowDropZone rowId={row.id} pageIdx={pageIdx} />

      {/* Row drag handle */}
      <div className="vb-row-handle" {...dragHandleProps} title="Drag to reorder row">
        <svg width="12" height="16" viewBox="0 0 12 16" fill="none">
          <circle cx="3" cy="3" r="1.4" fill="currentColor" />
          <circle cx="9" cy="3" r="1.4" fill="currentColor" />
          <circle cx="3" cy="8" r="1.4" fill="currentColor" />
          <circle cx="9" cy="8" r="1.4" fill="currentColor" />
          <circle cx="3" cy="13" r="1.4" fill="currentColor" />
          <circle cx="9" cy="13" r="1.4" fill="currentColor" />
        </svg>
      </div>

      <SortableContext
        items={row.columns.map((c) => c.id)}
        strategy={horizontalListSortingStrategy}
      >
        <div
          className="vb-row-columns"
          style={{
            display: 'grid',
            gridTemplateColumns: row.columns.map((c) => `${c.width || 1}fr`).join(' '),
            gap: '8px',
          }}
        >
          {row.columns.map((col, ci) => (
            <React.Fragment key={col.id}>
              <FieldBlock
                col={col}
                row={row}
                pageIdx={pageIdx}
                isSelected={col.field?.id === selectedFieldId}
                dispatch={dispatch}
                accent={accent}
              />
              {ci < row.columns.length - 1 && (
                <ResizeHandle
                  pageIdx={pageIdx}
                  rowId={row.id}
                  colAId={col.id}
                  colBId={row.columns[ci + 1].id}
                  dispatch={dispatch}
                  rowRef={rowRef}
                />
              )}
            </React.Fragment>
          ))}
        </div>
      </SortableContext>

      {/* Row actions */}
      <div className="vb-row-actions">
        <button
          className="vb-row-action-btn"
          title="Delete row"
          onClick={() => {
            for (const col of row.columns) {
              if (col.field)
                dispatch({ type: 'REMOVE_FIELD', payload: { pageIdx, fieldId: col.field.id } });
            }
          }}
        >
          <svg width="11" height="11" viewBox="0 0 11 11" fill="none">
            <path
              d="M1 1l9 9M10 1l-9 9"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
            />
          </svg>
        </button>
      </div>
    </div>
  );
}
