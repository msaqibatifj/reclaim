import React, { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../lib/api.js';
import { useApp } from '../lib/context.js';
import { bytes, regDate } from '../lib/format.js';
import { fadeRows } from '../lib/motion.js';
import Preview from '../components/Preview.jsx';
import { Button, Card, Notice, Num, Page, useView } from '../components/ui.jsx';

const SORTS = {
  size: (a, b) => b.size - a.size,
  name: (a, b) => a.name.localeCompare(b.name),
  installed: (a, b) => String(b.installDate).localeCompare(String(a.installDate)),
};

export default function Programs() {
  const { go, ledgerChanged } = useApp();
  const { active } = useView();
  const [list, setList] = useState(null);
  const [q, setQ] = useState('');
  const [sort, setSort] = useState('size');
  const [sel, setSel] = useState(null);
  const [phase, setPhase] = useState('list');
  const [receipt, setReceipt] = useState(null);
  const [error, setError] = useState(null);
  const tableRef = useRef(null);

  useEffect(() => {
    if (!active || list) return;
    api.programs().then(setList).catch((e) => {
      setError(e.message);
      setList([]);
    });
  }, [active, list]);

  const shown = useMemo(
    () => (list || []).filter((p) => !q || `${p.name} ${p.publisher}`.toLowerCase().includes(q.toLowerCase())).sort(SORTS[sort]),
    [list, q, sort],
  );
  useEffect(() => {
    fadeRows(tableRef.current?.querySelectorAll('tr.row') || []);
  }, [list]);

  const max = Math.max(1, ...shown.map((p) => p.size));
  const total = (list || []).reduce((n, p) => n + p.size, 0);

  async function commit() {
    const p = sel;
    setPhase('running');
    setError(null);
    try {
      await api.uninstall(p.id);
      const l = await api.ledger().catch(() => []);
      setReceipt(l[0] || null);
      ledgerChanged();
    } catch (e) {
      setError(e.message);
    } finally {
      setPhase('list');
    }
  }

  return (
    <Page
      title="Programs"
      sub={list ? <>Installed programs use <b><Num value={total} /></b>, as reported by their installers. Some programs don’t report a size.</> : 'Installed programs, largest first.'}
    >
      {error && <Notice tone="error">{error}</Notice>}
      {receipt && (
        <Notice tone="success" actions={<Button small onClick={() => go('ledger')}>View history</Button>}>
          Started the uninstaller for {receipt.subject}. Follow its window to finish.
        </Notice>
      )}

      {phase !== 'list' && sel && (
        <div style={{ marginTop: 16 }}>
          <Preview
            title={`Review: uninstall ${sel.name}`}
            groups={[
              {
                key: 'p',
                heading: 'Uninstall',
                undo: `reinstall ${sel.name} from its publisher. Its settings may be gone.`,
                items: [{ id: sel.id, title: sel.name, bytes: sel.size || null, dest: "the program's own uninstaller", paths: [{ path: sel.location || '(install folder not reported)', bytes: sel.size || null }] }],
              },
            ]}
            total={sel.size || 0}
            totalLabel="Reported size"
            onBack={() => setPhase('list')}
            busy={phase === 'running'}
            commitLabel={`Uninstall ${sel.name}`}
            onCommit={commit}
          >
            <p className="sub">The program’s own uninstaller opens in its own window. Reclaim doesn’t delete program files itself.</p>
          </Preview>
        </div>
      )}

      <div hidden={phase !== 'list'}>
        <Card>
          <div className="card-body form-row" style={{ gridTemplateColumns: 'minmax(0,1fr) auto' }}>
            <div className="field">
              <label htmlFor="prog-q">Search</label>
              <input id="prog-q" className="input" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Name or publisher" />
            </div>
            <div className="field">
              <label htmlFor="prog-sort">Sort by</label>
              <select id="prog-sort" className="input" value={sort} onChange={(e) => setSort(e.target.value)}>
                <option value="size">Size</option>
                <option value="name">Name</option>
                <option value="installed">Install date</option>
              </select>
            </div>
          </div>
          <table className="table" ref={tableRef} style={{ borderTop: '1px solid var(--border)' }}>
            <tbody>
              {!list &&
                Array.from({ length: 8 }, (_, i) => (
                  <tr key={i} className="ghost" aria-hidden="true">
                    <td colSpan={5}><div className="ghost-fill" /></td>
                  </tr>
                ))}
              {shown.map((p) => (
                <tr key={p.id + p.name} className="row">
                  <td className="name">
                    <div className="name-text">{p.name}</div>
                    <div className="sub ellipsis">{[p.publisher, p.installDate ? `installed ${regDate(p.installDate)}` : null].filter(Boolean).join(' · ')}</div>
                  </td>
                  <td className="bar-cell">{p.size > 0 && <div className="inline-bar" style={{ width: `${Math.max(1, (p.size / max) * 100)}%` }} />}</td>
                  <td className="size">{p.size ? bytes(p.size) : <span className="soft">—</span>}</td>
                  <td className="actions-cell">
                    <span className="btn-row" style={{ justifyContent: 'flex-end', flexWrap: 'nowrap' }}>
                      {p.location && <Button small onClick={() => api.open(p.location).catch((e) => setError(e.message))}>Folder</Button>}
                      {p.uninstall ? (
                        <Button small className="danger-outline" onClick={() => { setSel(p); setPhase('preview'); }}>Uninstall…</Button>
                      ) : (
                        <Button small onClick={() => api.openAppsSettings()} title="No uninstaller is registered; use Windows Settings">Settings ↗</Button>
                      )}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {list && shown.length === 0 && <div className="empty">No programs match.</div>}
        </Card>
      </div>
    </Page>
  );
}
