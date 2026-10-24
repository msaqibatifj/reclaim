import React, { useEffect, useMemo, useRef, useState } from 'react';
import { api, on } from '../lib/api.js';
import { useApp } from '../lib/context.js';
import { bytes, day, midPath, num } from '../lib/format.js';
import { fadeRows } from '../lib/motion.js';
import Preview from '../components/Preview.jsx';
import { ActionBar, Box, Button, Card, GRADE, Notice, Num, Page } from '../components/ui.jsx';

const MIN_SIZES = [
  [100 * 1024, '100 KB'],
  [1024 * 1024, '1 MB'],
  [10 * 1024 * 1024, '10 MB'],
  [100 * 1024 * 1024, '100 MB'],
];
const USER_DIRS = /\\(desktop|documents|downloads|pictures|videos|music)(\\|$)/i;

/** Default keeper: the oldest copy inside a user folder, else the oldest copy. */
function defaultKeep(files, home) {
  const inUser = files.filter((f) => (!home || f.path.toLowerCase().startsWith(home.toLowerCase())) && USER_DIRS.test(f.path));
  const pool = inUser.length ? inUser : files;
  return [...pool].sort((a, b) => a.mtime - b.mtime)[0].path;
}

export default function Duplicates() {
  const { info, go, ledgerChanged } = useApp();
  const [folders, setFolders] = useState([]);
  const [enabled, setEnabled] = useState(new Set());
  const [minSize, setMinSize] = useState(1024 * 1024);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(null);
  const [result, setResult] = useState(null);
  const [keep, setKeep] = useState({}); // groupIndex -> path
  const [marked, setMarked] = useState(new Set());
  const [phase, setPhase] = useState('list');
  const [receipt, setReceipt] = useState(null);
  const [message, setMessage] = useState(null);
  const listRef = useRef(null);

  useEffect(() => {
    api.dupeDefaults().then((f) => {
      setFolders(f);
      setEnabled(new Set(f));
    });
  }, []);
  useEffect(() => on('dupes:progress', setProgress), []);
  useEffect(() => {
    fadeRows(listRef.current?.querySelectorAll('tr.row') || []);
  }, [result]);

  async function search() {
    if (busy) return;
    setBusy(true);
    setResult(null);
    setMarked(new Set());
    setMessage(null);
    setProgress(null);
    try {
      const r = await api.dupes(folders.filter((f) => enabled.has(f)), { minSize });
      setResult(r);
      setKeep(Object.fromEntries(r.groups.map((g, i) => [i, defaultKeep(g.files, info?.home)])));
    } catch (e) {
      setMessage({ err: true, text: e.message });
    } finally {
      setBusy(false);
    }
  }

  const groups = result?.groups || [];
  const sizeOf = useMemo(() => new Map(groups.flatMap((g) => g.files.map((f) => [f.path, f.size]))), [groups]);
  const groupOf = useMemo(() => new Map(groups.flatMap((g, gi) => g.files.map((f) => [f.path, gi]))), [groups]);
  const pending = [...marked].reduce((n, p) => n + (sizeOf.get(p) || 0), 0);
  const extra = groups.reduce((n, g) => n + g.size * (g.files.length - 1), 0);

  const toggle = (p) => {
    const gi = groupOf.get(p);
    if (gi == null || keep[gi] === p || phase !== 'list') return;
    setMarked((s) => {
      const n = new Set(s);
      n.has(p) ? n.delete(p) : n.add(p);
      return n;
    });
  };
  const setKeeper = (gi, p) => {
    setKeep((k) => ({ ...k, [gi]: p }));
    setMarked((s) => {
      const n = new Set(s);
      n.delete(p);
      return n;
    });
  };
  // An explicit choice by the user; one copy in every group (the "keep" one) always stays.
  const markAllExtra = () => setMarked(new Set(groups.flatMap((g, gi) => g.files.filter((f) => f.path !== keep[gi]).map((f) => f.path))));
  const toggleFolder = (f) =>
    setEnabled((s) => {
      const n = new Set(s);
      n.has(f) ? n.delete(f) : n.add(f);
      return n;
    });

  async function commit() {
    setPhase('running');
    const paths = [...marked];
    try {
      const r = await api.trash(paths);
      const ok = new Set(r.filter((x) => x.ok).map((x) => x.path));
      const failed = r.filter((x) => !x.ok);
      setResult((res) => ({
        ...res,
        groups: res.groups.map((g) => ({ ...g, files: g.files.filter((f) => !ok.has(f.path)) })).filter((g) => g.files.length > 1),
      }));
      setMarked(new Set());
      setMessage(failed.length ? { err: true, text: `Couldn’t move ${failed.length} file(s) to the Recycle Bin: ${failed[0].error}.` } : null);
      const list = await api.ledger().catch(() => []);
      setReceipt(list[0] || null);
      ledgerChanged();
    } catch (e) {
      setMessage({ err: true, text: e.message });
    } finally {
      setPhase('list');
    }
  }
  // keep "keep" indexes in sync after groups shrink
  useEffect(() => {
    if (!result) return;
    setKeep((k) => {
      const next = {};
      result.groups.forEach((g, i) => {
        const prev = Object.values(k).find((p) => g.files.some((f) => f.path === p));
        next[i] = prev || defaultKeep(g.files, info?.home);
      });
      return next;
    });
  }, [result]); // eslint-disable-line react-hooks/exhaustive-deps

  async function undo() {
    if (!receipt) return;
    try {
      const r = await api.undoReceipt(receipt.id);
      setMessage({ err: !r.ok, text: r.ok ? `Restored ${r.restored} file(s) to their folders.` : `Restored ${r.restored}; ${r.failed.length} could not be restored: ${r.failed[0]?.error}.` });
      setReceipt(null);
      ledgerChanged();
    } catch (e) {
      setMessage({ err: true, text: e.message });
    }
  }

  const previewGroups = [
    {
      key: 'C',
      heading: 'Extra copies → Recycle Bin',
      note: GRADE.C.explain,
      undo: 'restore them from History, or from the Recycle Bin.',
      items: groups
        .map((g, gi) => ({ g, gi, paths: g.files.filter((f) => marked.has(f.path)) }))
        .filter((x) => x.paths.length)
        .map(({ g, gi, paths }) => ({
          id: g.hash || String(gi),
          title: `Copies of ${midPath(keep[gi], 56)}`,
          bytes: paths.reduce((n, f) => n + f.size, 0),
          dest: 'Recycle Bin',
          paths: paths.map((f) => ({ path: f.path, bytes: f.size })),
        })),
    },
  ];

  return (
    <Page title="Duplicates" sub="Find files with exactly the same contents. One copy of each is always kept, and removed copies go to the Recycle Bin.">
      <Card title="Where to look" meta={`${enabled.size} folder${enabled.size === 1 ? '' : 's'}`}>
        <table className="table">
          <tbody>
            {folders.map((f) => (
              <tr key={f} className="row clickable" onClick={() => !busy && toggleFolder(f)}>
                <td className="check">
                  <Box checked={enabled.has(f)} disabled={busy} label={`Search ${f}`} onChange={() => toggleFolder(f)} />
                </td>
                <td className="name" title={f}>
                  <span className="name-text">{midPath(f, 80)}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="card-body btn-row" style={{ borderTop: '1px solid var(--border)' }}>
          <Button disabled={busy} onClick={async () => { const p = await api.pickFolder('Add a folder to search'); if (p && !folders.includes(p)) { setFolders((x) => [...x, p]); setEnabled((s) => new Set([...s, p])); } }}>
            Add folder…
          </Button>
          <label className="soft small" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            Skip files smaller than
            <select className="input" style={{ width: 'auto' }} value={minSize} onChange={(e) => setMinSize(Number(e.target.value))} disabled={busy}>
              {MIN_SIZES.map(([v, l]) => (
                <option key={v} value={v}>{l}</option>
              ))}
            </select>
          </label>
          <span className="spacer" />
          {busy ? (
            <Button onClick={() => api.cancelDupes()}>Stop</Button>
          ) : (
            <Button variant="primary" onClick={search} disabled={!enabled.size}>
              {result ? 'Search again' : 'Find duplicates'}
            </Button>
          )}
        </div>
        {busy && (
          <div className="card-body sub" style={{ borderTop: '1px solid var(--border)' }} aria-live="polite">
            Searching… {progress?.total ? `checked ${num(progress.done)} of ${num(progress.total)} possible matches` : `${num(progress?.done)} files found so far`}
          </div>
        )}
      </Card>

      {message && <Notice tone={message.err ? 'error' : 'success'}>{message.text}</Notice>}
      {receipt && (
        <Notice tone="success" actions={<><Button small onClick={undo}>Undo</Button><Button small onClick={() => go('ledger')}>View history</Button></>}>
          Moved {bytes(receipt.bytes)} to the Recycle Bin.
        </Notice>
      )}

      {phase !== 'list' && (
        <div style={{ marginTop: 16 }}>
          <Preview
            title={`Review: ${bytes(pending)} to the Recycle Bin`}
            groups={previewGroups}
            total={pending}
            onBack={() => setPhase('list')}
            busy={phase === 'running'}
            commitLabel={`Move ${bytes(pending)} to Recycle Bin`}
            onCommit={commit}
          />
        </div>
      )}

      <div hidden={phase !== 'list'} ref={listRef}>
        {result && !busy && groups.length === 0 && <Card><div className="empty">No duplicate files in these folders.</div></Card>}
        {result && !busy && groups.length > 0 && (
          <Notice actions={<Button small onClick={markAllExtra}>Select all extra copies</Button>}>
            <b><Num value={extra} /></b> could be freed from {num(groups.length)} sets of identical files. Choose which copy to keep in each set.
          </Notice>
        )}
        {groups.map((g, gi) => (
          <Card key={g.hash || gi} title={`${g.files.length} identical copies · ${bytes(g.size)} each`} meta={`${bytes(g.size * (g.files.length - 1))} extra`}>
            <table className="table">
              <thead>
                <tr>
                  <th style={{ width: 1 }}>Keep</th>
                  <th>Location</th>
                  <th>Modified</th>
                  <th />
                  <th className="right" style={{ width: 1 }}>Remove</th>
                </tr>
              </thead>
              <tbody>
                {g.files.map((f) => {
                  const isKeep = keep[gi] === f.path;
                  return (
                    <tr key={f.path} className={`row ${isKeep ? '' : 'clickable'} ${marked.has(f.path) ? 'selected' : ''}`} onClick={() => toggle(f.path)}>
                      <td onClick={(e) => e.stopPropagation()}>
                        <input
                          type="radio"
                          className="box"
                          name={`keep-${gi}`}
                          checked={isKeep}
                          onChange={() => setKeeper(gi, f.path)}
                          aria-label={`Keep ${f.path}`}
                        />
                      </td>
                      <td className="name" title={f.path}>
                        <div className="name-line">
                          <span className="name-text">{midPath(f.path, 72)}</span>
                          {isKeep && <span className="tag safe">Kept</span>}
                        </div>
                      </td>
                      <td className="date">{day(new Date(f.mtime))}</td>
                      <td className="actions-cell" onClick={(e) => e.stopPropagation()}>
                        <Button small onClick={() => api.reveal(f.path)} title="Show in File Explorer">Show</Button>
                      </td>
                      <td className="check right">
                        <Box checked={marked.has(f.path)} disabled={isKeep} onChange={() => toggle(f.path)} label={isKeep ? `Kept copy ${f.path}` : `Remove ${f.path}`} />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </Card>
        ))}
        {result && groups.length > 0 && (
          <ActionBar summary={marked.size ? `${bytes(pending)} selected · ${marked.size} file${marked.size === 1 ? '' : 's'}` : 'Nothing selected'}>
            <Button onClick={() => setMarked(new Set())} disabled={!marked.size}>Clear</Button>
            <Button variant="primary" disabled={!marked.size} onClick={() => setPhase('preview')}>
              Review and remove →
            </Button>
          </ActionBar>
        )}
      </div>
    </Page>
  );
}
