import React from 'react';
import { useDroppable } from '@dnd-kit/core';
import {
  SortableContext,
  horizontalListSortingStrategy,
  verticalListSortingStrategy,
  useSortable,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import Row from './Row';

// Droppable gap between rows (creates a new row on drop)
function RowGap({ pageIdx, afterRowId }) {
  const id = `row-gap_${pageIdx}_${afterRowId || 'top'}`;
  const { setNodeRef, isOver } = useDroppable({
    id,
    data: { type: 'row-gap', pageIdx, afterRowId },
  });
  return <div ref={setNodeRef} className={`vb-row-gap${isOver ? ' drag-over' : ''}`} />;
}

// Droppable empty page placeholder
function EmptyPageDrop({ pageIdx }) {
  const { setNodeRef, isOver } = useDroppable({
    id: `page-empty_${pageIdx}`,
    data: { type: 'row-gap', pageIdx, afterRowId: null },
  });
  return (
    <div ref={setNodeRef} className={`vb-page-empty${isOver ? ' drag-over' : ''}`}>
      <div className="vb-page-empty-inner">
        <span className="vb-page-empty-icon">＋</span>
        <p>Drag a field here from the left panel</p>
      </div>
    </div>
  );
}

// Sortable row wrapper so rows can be reordered
function SortableRow({ row, page, pageIdx, selectedFieldId, dispatch, accent }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: row.id,
    data: { type: 'row-handle', rowId: row.id, pageIdx },
  });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.4 : 1,
  };

  return (
    <div ref={setNodeRef} style={style}>
      <Row
        row={row}
        page={page}
        pageIdx={pageIdx}
        selectedFieldId={selectedFieldId}
        dispatch={dispatch}
        accent={accent}
        dragHandleProps={{ ...attributes, ...listeners }}
      />
    </div>
  );
}

function SortablePageTab({ page, pageIdx, currentPageIdx, accent, dispatch }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: page.id,
    data: { type: 'page-tab', pageIdx, pageId: page.id },
  });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.55 : 1,
    ...(pageIdx === currentPageIdx ? { '--accent': accent } : {}),
  };

  return (
    <button
      ref={setNodeRef}
      className={`vb-page-tab${pageIdx === currentPageIdx ? ' is-active' : ''}`}
      style={style}
      onClick={() => dispatch({ type: 'SELECT_PAGE', payload: pageIdx })}
      {...attributes}
      {...listeners}
    >
      <span className="vb-page-tab-num">{pageIdx + 1}</span>
      {page.name || `Page ${pageIdx + 1}`}
    </button>
  );
}

export default function Canvas({ state, dispatch, devicePreview = 'desktop' }) {
  const { pages, selectedPageIdx, selectedFieldId, branding } = state;
  const accent = branding?.accentColor || '#bd2135';

  const currentPageIdx = selectedPageIdx ?? 0;
  const currentPage = pages[currentPageIdx];

  // Progress bar for multi-page forms
  const showProgress = currentPage?.showProgress !== false && pages.length > 1;
  const progressPct = Math.round(((currentPageIdx + 1) / pages.length) * 100);

  return (
    <main className="vb-canvas-area">
      <span className="vb-compat-marker" hidden>
        Visual Editor
      </span>

      {/* Page tabs */}
      <div className="vb-page-tabs vb-page-nav">
        <SortableContext items={pages.map((p) => p.id)} strategy={horizontalListSortingStrategy}>
          {pages.map((page, pi) => (
            <SortablePageTab
              key={page.id}
              page={page}
              pageIdx={pi}
              currentPageIdx={currentPageIdx}
              accent={accent}
              dispatch={dispatch}
            />
          ))}
        </SortableContext>
        <button
          className="vb-page-tab vb-page-tab-add"
          onClick={() => dispatch({ type: 'ADD_PAGE' })}
          title="Add page"
        >
          ＋
        </button>
      </div>

      {/* Device preview frame */}
      <div className={`vb-canvas-device vb-canvas-device-${devicePreview}`}>
        {/* Progress bar */}
        {showProgress && (
          <div className="vb-progress-bar-wrap">
            <div
              className="vb-progress-bar"
              style={{ width: `${progressPct}%`, background: accent }}
            />
          </div>
        )}

        {/* Page header bar */}
        <div className="vb-page-header-bar">
          <div style={{ flex: 1, minWidth: 0 }}>
            <input
              className="vb-page-name-input"
              value={currentPage?.name || ''}
              onChange={(e) =>
                dispatch({
                  type: 'UPDATE_PAGE',
                  payload: { pageIdx: currentPageIdx, updates: { name: e.target.value } },
                })
              }
              placeholder="Page name…"
            />
            <input
              className="vb-page-desc-input"
              value={currentPage?.description || ''}
              onChange={(e) =>
                dispatch({
                  type: 'UPDATE_PAGE',
                  payload: { pageIdx: currentPageIdx, updates: { description: e.target.value } },
                })
              }
              placeholder="Page description (optional)…"
            />
          </div>
          {pages.length > 1 && (
            <button
              className="vb-btn vb-btn-danger-ghost"
              onClick={() => dispatch({ type: 'REMOVE_PAGE', payload: currentPageIdx })}
            >
              Remove Page
            </button>
          )}
        </div>

        {/* Canvas body */}
        <div className="vb-canvas-inner">
          {!currentPage || currentPage.rows.length === 0 ? (
            <EmptyPageDrop pageIdx={currentPageIdx} />
          ) : (
            <SortableContext
              items={currentPage.rows.map((r) => r.id)}
              strategy={verticalListSortingStrategy}
            >
              {currentPage.rows.map((row, ri) => (
                <React.Fragment key={row.id}>
                  <RowGap
                    pageIdx={currentPageIdx}
                    afterRowId={ri === 0 ? null : currentPage.rows[ri - 1]?.id}
                  />
                  <SortableRow
                    row={row}
                    page={currentPage}
                    pageIdx={currentPageIdx}
                    selectedFieldId={selectedFieldId}
                    dispatch={dispatch}
                    accent={accent}
                  />
                </React.Fragment>
              ))}
              <RowGap pageIdx={currentPageIdx} afterRowId={currentPage.rows.at(-1)?.id} />
            </SortableContext>
          )}
        </div>

        {/* Page navigation buttons for multi-page */}
        {pages.length > 1 && (
          <div className="vb-page-nav-btns">
            {currentPageIdx > 0 && (
              <button
                className="vb-btn vb-btn-ghost"
                onClick={() => dispatch({ type: 'SELECT_PAGE', payload: currentPageIdx - 1 })}
              >
                {currentPage?.prevLabel || '← Back'}
              </button>
            )}
            <span className="vb-page-nav-spacer" />
            {currentPageIdx < pages.length - 1 && (
              <button
                className="vb-btn vb-btn-primary"
                style={{ background: accent }}
                onClick={() => dispatch({ type: 'SELECT_PAGE', payload: currentPageIdx + 1 })}
              >
                {currentPage?.nextLabel || 'Next →'}
              </button>
            )}
          </div>
        )}
      </div>
    </main>
  );
}
