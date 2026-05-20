import React, { useState } from 'react';
import { useDraggable } from '@dnd-kit/core';
import { FIELD_CATEGORIES } from '../fieldTypes';

// Color accent per category
const CAT_COLORS = {
  content: '#6366f1',
  basic: '#0ea5e9',
  selection: '#10b981',
  personal: '#f59e0b',
  advanced: '#8b5cf6',
  payment: '#ef4444',
};

function PaletteItem({ type, label, icon, desc, catColor }) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: `palette_${type}`,
    data: { source: 'palette', fieldType: type },
  });

  return (
    <div
      ref={setNodeRef}
      className={`vb-palette-item${isDragging ? ' is-dragging' : ''}`}
      {...listeners}
      {...attributes}
      title={desc}
    >
      <span className="vb-palette-icon" style={{ background: `${catColor}18`, color: catColor }}>
        {icon}
      </span>
      <span className="vb-palette-label">{label}</span>
    </div>
  );
}

export default function Sidebar() {
  const [query, setQuery] = useState('');
  const [collapsed, setCollapsed] = useState({ content: false, basic: false, selection: false, personal: false, advanced: true, payment: false });

  const q = query.trim().toLowerCase();

  const filteredCats = FIELD_CATEGORIES.map((cat) => ({
    ...cat,
    fields: cat.fields.filter(
      (f) => !q || f.label.toLowerCase().includes(q) || f.desc.toLowerCase().includes(q)
    ),
  })).filter((cat) => cat.fields.length > 0);

  function toggle(id) {
    setCollapsed((prev) => ({ ...prev, [id]: !prev[id] }));
  }

  return (
    <aside className="vb-sidebar">
      <div className="vb-sidebar-head">
        <h2 className="vb-sidebar-title">Blocks</h2>
        <div className="vb-sidebar-search">
          <svg className="vb-sidebar-search-icon" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
            <circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/>
          </svg>
          <input
            className="vb-sidebar-search-input"
            placeholder="Search blocks..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
      </div>

      <div className="vb-sidebar-body">
        {filteredCats.map((cat) => {
          const catColor = CAT_COLORS[cat.id] || '#888';
          return (
            <div key={cat.id} className="vb-palette-category">
              <button
                className="vb-palette-cat-header"
                onClick={() => toggle(cat.id)}
                style={{ '--cat-color': catColor }}
              >
                <div className="vb-palette-cat-label">
                  <span className="vb-palette-cat-dot" style={{ background: catColor }} />
                  <span>{cat.label}</span>
                </div>
                <span className="vb-palette-cat-arrow">{collapsed[cat.id] ? '›' : '‹'}</span>
              </button>
              {!collapsed[cat.id] && (
                <div className="vb-palette-grid">
                  {cat.fields.map((f) => (
                    <PaletteItem key={f.type} {...f} catColor={catColor} />
                  ))}
                </div>
              )}
            </div>
          );
        })}
        {filteredCats.length === 0 && (
          <div className="vb-sidebar-empty">
            <span>No blocks match &ldquo;{query}&rdquo;</span>
          </div>
        )}
      </div>

      <div className="vb-sidebar-hint">
        Drag any block from the palette above onto the canvas to add it to your form.
      </div>
    </aside>
  );
}
