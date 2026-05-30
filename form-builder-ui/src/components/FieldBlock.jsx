import React from 'react';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import FieldPreview from './FieldPreview';
import { getFieldMeta, FIELD_CATEGORIES } from '../fieldTypes';

// Map category id → color (matches Sidebar CAT_COLORS)
const CAT_COLORS = {
  content: '#6366f1',
  basic: '#0ea5e9',
  selection: '#10b981',
  personal: '#f59e0b',
  advanced: '#8b5cf6',
  payment: '#ef4444',
};

function getCatColor(type) {
  for (const cat of FIELD_CATEGORIES) {
    if (cat.fields.some((f) => f.type === type)) return CAT_COLORS[cat.id] || '#9ca3af';
  }
  return '#9ca3af';
}

export default function FieldBlock({ col, row, pageIdx, isSelected, dispatch, accent }) {
  const field = col.field;

  const { attributes, listeners, setNodeRef, transform, transition, isDragging, isOver } =
    useSortable({
      id: col.id,
      data: {
        type: 'field',
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
      <div ref={setNodeRef} style={style} className="vb-field-block vb-field-empty">
        <span>Drop field here</span>
      </div>
    );
  }

  const meta = getFieldMeta(field.type);
  const catColor = getCatColor(field.type);

  function handleClick(e) {
    if (e.defaultPrevented) return;
    dispatch({ type: 'SELECT_FIELD', payload: field.id });
  }

  function handleDelete(e) {
    e.stopPropagation();
    e.preventDefault();
    dispatch({ type: 'REMOVE_FIELD', payload: { pageIdx, fieldId: field.id } });
  }

  function handleDuplicate(e) {
    e.stopPropagation();
    e.preventDefault();
    dispatch({ type: 'DUPLICATE_FIELD', payload: { pageIdx, rowId: row.id, colId: col.id } });
  }

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`vb-field-block${isSelected ? ' is-selected' : ''}${isDragging ? ' is-dragging' : ''}${isOver ? ' drag-over' : ''}`}
      onClick={handleClick}
      data-field-id={field.id}
    >
      {/* Top overlay bar */}
      <div className="vb-field-overlay">
        <div
          className="vb-field-drag-handle"
          {...listeners}
          {...attributes}
          title="Drag to reorder"
        >
          <svg width="12" height="16" viewBox="0 0 12 16" fill="none">
            <circle cx="3" cy="3" r="1.4" fill="currentColor" />
            <circle cx="9" cy="3" r="1.4" fill="currentColor" />
            <circle cx="3" cy="8" r="1.4" fill="currentColor" />
            <circle cx="9" cy="8" r="1.4" fill="currentColor" />
            <circle cx="3" cy="13" r="1.4" fill="currentColor" />
            <circle cx="9" cy="13" r="1.4" fill="currentColor" />
          </svg>
        </div>
        <div className="vb-field-ovr-actions">
          <button className="vb-field-ovr-btn" onClick={handleDuplicate} title="Duplicate field">
            <svg width="13" height="13" viewBox="0 0 13 13" fill="none">
              <rect
                x="4"
                y="4"
                width="8"
                height="8"
                rx="1.5"
                stroke="currentColor"
                strokeWidth="1.4"
              />
              <path
                d="M9 4V2.5A1.5 1.5 0 007.5 1H2.5A1.5 1.5 0 001 2.5v5A1.5 1.5 0 002.5 9H4"
                stroke="currentColor"
                strokeWidth="1.4"
              />
            </svg>
          </button>
          <button
            className="vb-field-ovr-btn vb-field-delete"
            onClick={handleDelete}
            title="Remove field"
          >
            <svg width="13" height="13" viewBox="0 0 13 13" fill="none">
              <path
                d="M2 2l9 9M11 2l-9 9"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
              />
            </svg>
          </button>
        </div>
      </div>

      {/* Type badge */}
      <div className="vb-field-badge" style={{ '--cat-color': catColor }}>
        <span className="vb-field-badge-dot" style={{ background: catColor }} />
        <span className="vb-field-badge-icon">{meta.icon}</span>
        <span className="vb-field-badge-label">{meta.label}</span>
        {field.required && <span className="vb-field-required">*</span>}
        {field.enabled === false && <span className="vb-field-hidden-tag">hidden</span>}
        {field.conditions?.length > 0 && (
          <span className="vb-field-cond-tag" title="Has conditional logic">
            if
          </span>
        )}
      </div>

      {/* Label shown above preview (unless content type handles it itself) */}
      {field.label &&
        !['heading', 'paragraph', 'divider', 'spacer', 'html_embed', 'section_header'].includes(
          field.type
        ) && (
          <div className="vb-field-label-preview">
            {field.label}
            {field.required && <span style={{ color: accent, marginLeft: 2 }}>*</span>}
          </div>
        )}

      {/* WYSIWYG Preview */}
      <div className="vb-field-preview-wrap">
        <FieldPreview field={field} accent={accent} />
      </div>

      {/* Column width badge */}
      <div className="vb-col-width-badge">{col.width}/12</div>
    </div>
  );
}
