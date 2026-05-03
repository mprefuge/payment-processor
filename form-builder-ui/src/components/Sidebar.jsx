import React, { useState } from 'react';
import { useDraggable } from '@dnd-kit/core';
import { FIELD_CATEGORIES, getFieldMeta } from '../fieldTypes';

function PaletteItem({ type, label, icon, desc }) {
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
      <span className="vb-palette-icon">{icon}</span>
      <span className="vb-palette-label">{label}</span>
    </div>
  );
}

export default function Sidebar() {
  const [query, setQuery] = useState('');
  const [collapsed, setCollapsed] = useState({});

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
          <span className="vb-sidebar-search-icon">⌕</span>
          <input
            className="vb-sidebar-search-input"
            placeholder="Search fields…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
      </div>
      <div className="vb-sidebar-body">
        {filteredCats.map((cat) => (
          <div key={cat.id} className="vb-palette-category">
            <button
              className="vb-palette-cat-header"
              onClick={() => toggle(cat.id)}
            >
              <span>{cat.label}</span>
              <span className="vb-palette-cat-arrow">{collapsed[cat.id] ? '▸' : '▾'}</span>
            </button>
            {!collapsed[cat.id] && (
              <div className="vb-palette-grid">
                {cat.fields.map((f) => (
                  <PaletteItem key={f.type} {...f} />
                ))}
              </div>
            )}
          </div>
        ))}
        {filteredCats.length === 0 && (
          <p className="vb-sidebar-empty">No fields match "{query}"</p>
        )}
      </div>
      <div className="vb-sidebar-hint">
        Drag a field onto the canvas, or click a field card to edit its settings.
      </div>
    </aside>
  );
}
