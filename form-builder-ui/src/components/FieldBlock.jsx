import React from 'react';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import FieldPreview from './FieldPreview';
import { getFieldMeta } from '../fieldTypes';

export default function FieldBlock({ col, row, pageIdx, isSelected, dispatch, accent }) {
  const field = col.field;

  const { attributes, listeners, setNodeRef, transform, transition, isDragging, isOver } = useSortable({
    id: col.id,
    data: {
      source: 'field',
      fieldId: field?.id,
      colId: col.id,
      rowId: row.id,
      pageIdx,
      label: field?.label,
    },
  });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.3 : 1,
  };

  if (!field) {
    return (
      <div style={style} className="vb-field-block vb-field-empty">
        Empty column
      </div>
    );
  }

  const meta = getFieldMeta(field.type);

  function handleClick(e) {
    if (e.defaultPrevented) return;
    dispatch({ type: 'SELECT_FIELD', payload: field.id });
  }

  function handleDelete(e) {
    e.stopPropagation();
    dispatch({ type: 'REMOVE_FIELD', payload: { pageIdx, fieldId: field.id } });
  }

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`vb-field-block${isSelected ? ' is-selected' : ''}${isDragging ? ' is-dragging' : ''}${isOver ? ' drag-over' : ''}`}
      onClick={handleClick}
      data-field-id={field.id}
    >
      {/* Overlay controls */}
      <div className="vb-field-overlay">
        <div className="vb-field-drag-handle" {...listeners} {...attributes} title="Drag to reorder">
          ⋮⋮
        </div>
        <button className="vb-field-ovr-btn vb-field-delete" onClick={handleDelete} title="Remove field">
          ✕
        </button>
      </div>

      {/* Badge */}
      <div className="vb-field-badge">
        <span>{meta.icon}</span>
        <span>{meta.label}</span>
        {field.required && <span className="vb-field-required">*</span>}
        {field.enabled === false && <span className="vb-field-hidden-tag">hidden</span>}
      </div>

      {/* Preview */}
      <div className="vb-field-preview-wrap">
        <FieldPreview field={field} accent={accent} />
      </div>

      {/* Column width badge */}
      <div className="vb-col-width-badge">{col.width}/12</div>
    </div>
  );
}
