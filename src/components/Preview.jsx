import React from 'react';
import { bytes, midPath, num } from '../lib/format.js';
import { Button, Card, GradeTag, useViewKeys } from './ui.jsx';

/**
 * Review step (DESIGN.md §4). Shown in place of the list before anything changes.
 * Lists what changes, where it goes and how to undo it, with a total that matches the
 * drive bar. Back (or Esc) keeps the selection.
 *
 * groups: [{ key, heading, note?, undo, items: [{ id, grade?, title, bytes, dest, paths:[{path,bytes,files,note}], warn? }] }]
 */
export default function Preview({ title, groups, total, onBack, commitLabel, onCommit, busy, loading, children, totalLabel = 'Total', danger = true }) {
  useViewKeys((e) => {
    if (e.key === 'Escape' && !busy) onBack();
  });

  return (
    <div aria-label="Review">
      <Card title={title} meta="Nothing has changed yet">
        {loading && <div className="empty">Checking exactly what would change…</div>}

        {!loading &&
          groups.map((g) => (
            <div key={g.key} className="review-group">
              <div className="card-body">
                <div>
                  <div style={{ fontWeight: 600 }}>{g.heading}</div>
                  {g.note && <div className="sub">{g.note}</div>}
                </div>
                {g.items.map((it) => (
                  <div key={it.id} className="review-item">
                    <div className="head">
                      <span>{it.title}</span>
                      {it.grade && <GradeTag grade={it.grade} />}
                      <span className="sub">→ {it.dest}</span>
                      <span className="size">{bytes(it.bytes)}</span>
                    </div>
                    {it.paths?.length > 0 && (
                      <details style={{ marginTop: 4 }}>
                        <summary className="small">
                          Show {it.paths.length === 1 ? 'location' : `${it.paths.length} locations`}
                        </summary>
                        <ul className="review-paths">
                          {it.paths.map((p, i) => (
                            <li key={p.path + i} title={p.path}>
                              <span className="p">{midPath(p.path, 80)}</span>
                              {p.note && <span>{p.note}</span>}
                              {p.files != null && <span>{num(p.files)} files</span>}
                              {p.bytes != null && <span>{bytes(p.bytes)}</span>}
                            </li>
                          ))}
                        </ul>
                      </details>
                    )}
                    {it.paths?.length === 0 && <div className="sub">Nothing to remove right now.</div>}
                    {it.warn && <div className="sub err">{it.warn}</div>}
                  </div>
                ))}
                {g.undo && <div className="sub">Undo: {g.undo}</div>}
              </div>
            </div>
          ))}

        {!loading && (
          <div className="review-total">
            <span>{totalLabel}</span>
            <span>{bytes(total)}</span>
          </div>
        )}
        {children && <div className="card-body" style={{ borderTop: '1px solid var(--border)' }}>{children}</div>}
      </Card>

      <div className="action-bar">
        <Button onClick={onBack} disabled={busy}>
          ← Back
        </Button>
        <span className="spacer" />
        <Button variant={danger ? 'danger' : 'primary'} onClick={onCommit} disabled={busy || loading || !onCommit}>
          {commitLabel}
        </Button>
      </div>
    </div>
  );
}
