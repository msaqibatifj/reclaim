import React, { useEffect, useRef, useState } from 'react';
import { api } from '../lib/api.js';
import { useApp } from '../lib/context.js';
import { bytes, num, stamp } from '../lib/format.js';
import { fadeRows } from '../lib/motion.js';
import { Button, Card, Notice, Num, Page, useView } from '../components/ui.jsx';

// Verbs whose bytes actually left the disk (recycled files count once the bin is emptied; moves once the old copy is deleted).
const RECLAIMED = new Set(['Removed', 'Deleted old copy']);

const RULES = [
  ['You always review first', 'Every delete, move and uninstall shows you exactly what will change before it happens.'],
  ['Cleanups stay in their lane', 'Each cleanup lists its folders up front, and every file is checked to be inside them. Links are never followed.'],
  ['Your personal folders are off-limits', 'Documents, Desktop, Downloads, Pictures, Videos, Music, OneDrive, Windows, Program Files and drive roots are never cleaned.'],
  ['Files in use are skipped', 'Locked files are left alone, never forced. If an app is running, its cleanup waits until you close it.'],
  ['Moves keep the original', 'The old copy stays until you choose to delete it, and only after Reclaim checks the new location still works.'],
  ['One copy is always kept', 'The duplicate finder never removes the last copy of a file.'],
  ['Offline', 'No telemetry and no network calls.'],
];

export default function Ledger() {
  const { ledgerTick, ledgerChanged, sessionStart, go } = useApp();
  const { active } = useView();
  const [list, setList] = useState(null);
  const [msg, setMsg] = useState(null);
  const [working, setWorking] = useState(null);
  const [moves, setMoves] = useState([]);
  const listRef = useRef(null);

  useEffect(() => {
    if (!active && list) return;
    api.ledger().then(setList).catch((e) => setMsg({ err: true, text: e.message }));
    api.moves().then(setMoves).catch(() => {});
  }, [active, ledgerTick]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    fadeRows(listRef.current?.querySelectorAll('tr.row') || []);
  }, [list]);

  const session = (list || []).filter((r) => r.at >= sessionStart);
  const sum = (rs, pred) => rs.filter(pred).reduce((n, r) => n + (r.bytes || 0), 0);
  const sessionReclaimed = sum(session, (r) => RECLAIMED.has(r.verb));
  const allReclaimed = sum(list || [], (r) => RECLAIMED.has(r.verb));
  const inBin = sum(list || [], (r) => r.verb === 'Recycled' && !r.undone);
  const moved = sum(list || [], (r) => r.verb === 'Moved' && !r.undone);

  async function undo(r) {
    if (r.undo?.kind === 'move-back') {
      go('move', { undo: r.undo.moveId });
      return;
    }
    setWorking(r.id);
    setMsg(null);
    try {
      const res = await api.undoReceipt(r.id);
      setMsg({ err: !res.ok, text: res.ok ? `Restored ${res.restored} file(s) to their folders.` : `Restored ${res.restored}. ${res.failed.length} could not be restored: ${res.failed[0]?.error}.` });
      ledgerChanged();
    } catch (e) {
      setMsg({ err: true, text: e.message });
    } finally {
      setWorking(null);
    }
  }

  async function exportAs(fmt) {
    try {
      const p = await api.exportLedger(fmt);
      if (p) setMsg({ err: false, text: `Saved ${p}` });
    } catch (e) {
      setMsg({ err: true, text: e.message });
    }
  }

  return (
    <Page title="History" sub="Everything Reclaim has done, newest first, with a way to undo it where possible.">
      <Card>
        <div className="card-body">
          <div className="stats">
            <div className="stat"><div className="v"><Num value={sessionReclaimed} /></div><div className="k">Freed this session</div></div>
            <div className="stat"><div className="v"><Num value={allReclaimed} /></div><div className="k">Freed all time</div></div>
            <div className="stat"><div className="v"><Num value={inBin} /></div><div className="k">In the Recycle Bin</div></div>
            <div className="stat"><div className="v"><Num value={moved} /></div><div className="k">Moved to other drives</div></div>
          </div>
          <p className="sub" style={{ marginTop: 12 }}>Files in the Recycle Bin free their space when you empty it. Moved folders free space once you delete the old copy.</p>
        </div>
      </Card>

      {msg && <Notice tone={msg.err ? 'error' : 'success'}>{msg.text}</Notice>}

      <Card
        title="Activity"
        meta={
          <span className="btn-row">
            <Button small onClick={() => exportAs('txt')} disabled={!list?.length}>Export .txt</Button>
            <Button small onClick={() => exportAs('csv')} disabled={!list?.length}>Export .csv</Button>
          </span>
        }
      >
        {list && list.length === 0 && <div className="empty">Nothing yet. Cleanups, moves and uninstalls will show up here.</div>}
        {list && list.length > 0 && (
          <table className="table" ref={listRef}>
            <tbody>
              {list.map((r) => {
                const struck = !!r.undone;
                const pendingMove = r.undo?.kind === 'move-back' && moves.find((m) => m.id === r.undo.moveId)?.status === 'pending-cleanup';
                return (
                  <tr key={r.id} className={`row ${struck || r.verb === 'Skipped' ? 'disabled' : ''}`}>
                    <td className="date">{stamp(r.at)}</td>
                    <td className="name" title={`${r.subject}${r.dest ? ` → ${r.dest}` : ''}`}>
                      <div className="name-line">
                        <span style={{ fontWeight: 600, textDecoration: struck ? 'line-through' : undefined }}>{r.verb}</span>
                        {struck && <span className="tag">Undone</span>}
                      </div>
                      <div className="sub ellipsis">
                        {r.subject}
                        {r.dest ? ` → ${r.dest}` : ''}
                        {r.items ? ` · ${num(r.items)} items` : ''}
                      </div>
                      {r.note && <div className="sub">{r.note}</div>}
                    </td>
                    <td className="size">{r.bytes ? bytes(r.bytes) : ''}</td>
                    <td className="actions-cell">
                      <span className="btn-row" style={{ justifyContent: 'flex-end', flexWrap: 'nowrap' }}>
                        {!struck && r.undo?.kind === 'restore' && (
                          <Button small onClick={() => undo(r)} disabled={working === r.id}>{working === r.id ? 'Restoring…' : 'Undo'}</Button>
                        )}
                        {!struck && r.undo?.kind === 'move-back' && <Button small onClick={() => undo(r)}>Move back</Button>}
                        {!struck && pendingMove && (
                          <Button small className="danger-outline" onClick={() => go('move', { finalize: r.undo.moveId })}>Delete old copy</Button>
                        )}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </Card>

      <details style={{ marginTop: 20 }}>
        <summary>How Reclaim keeps your files safe</summary>
        <Card>
          <div className="card-body">
            <dl className="facts" style={{ gap: '8px 20px' }}>
              {RULES.map(([t, d]) => (
                <React.Fragment key={t}>
                  <dt style={{ color: 'var(--text)', fontWeight: 600 }}>{t}</dt>
                  <dd className="soft">{d}</dd>
                </React.Fragment>
              ))}
            </dl>
          </div>
        </Card>
      </details>
    </Page>
  );
}
