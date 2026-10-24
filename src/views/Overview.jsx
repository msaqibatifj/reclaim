import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, on } from '../lib/api.js';
import { useApp } from '../lib/context.js';
import { bytes } from '../lib/format.js';
import { fadeRows } from '../lib/motion.js';
import Preview from '../components/Preview.jsx';
import { ActionBar, Box, Button, Card, DriveBar, GRADE, GradeTag, Notice, Num, Page, useView } from '../components/ui.jsx';

const SECTIONS = [
  ['Caches', 'Temporary files and caches'],
  ['Developer', 'Developer tools'],
  ['Games', 'Games'],
  ['Windows', 'Windows'],
];
const GRADE_ORDER = ['A', 'B', 'C'];
const GRADE_HEAD = { A: 'Safe — rebuilt automatically', B: 'Re-downloaded or rebuilt when needed', C: 'Your files — check each one' };
const GRADE_UNDO = { A: 'not needed; these rebuild on their own.', B: 'not needed; they re-download or rebuild when next used.', C: 'none. Make sure you don’t need these.' };
// Overlapping cleanups: choosing one deselects the other.
const PAIRS = { 'user-temp': 'user-temp-all', 'user-temp-all': 'user-temp', 'component-cleanup': 'component-resetbase', 'component-resetbase': 'component-cleanup' };

export default function Overview() {
  const { info, refreshInfo, go, ledgerChanged } = useApp();
  const admin = !!info?.admin;

  const [cleaners, setCleaners] = useState([]);
  const [sizes, setSizes] = useState({});
  const [procs, setProcs] = useState(new Set());
  const [selected, setSelected] = useState(new Set());
  const [expanded, setExpanded] = useState(null);
  const [phase, setPhase] = useState('list'); // list | preview | running
  const [preview, setPreview] = useState(null);
  const [log, setLog] = useState([]);
  const [results, setResults] = useState({});
  const [receipt, setReceipt] = useState(null);
  const [skippedLine, setSkippedLine] = useState(null);
  const [error, setError] = useState(null);
  const defaultsDone = useRef(false);
  const listRef = useRef(null);
  const logRef = useRef(null);
  const { active } = useView();

  const measure = useCallback((list, fresh = false) => {
    if (fresh) setSizes({});
    list.forEach((c) =>
      api
        .estimate(c.id, { fresh })
        .then((s) => setSizes((m) => ({ ...m, [c.id]: s })))
        .catch(() => setSizes((m) => ({ ...m, [c.id]: null }))),
    );
  }, []);

  const checkProcs = useCallback(() => api.processes().then((l) => setProcs(new Set(l))).catch(() => {}), []);

  useEffect(() => {
    api
      .cleaners()
      .then((list) => {
        setCleaners(list);
        measure(list);
      })
      .catch((e) => setError(e.message));
  }, [measure]);

  // Re-check which apps are running whenever this view is shown, and every 15 s while it is.
  useEffect(() => {
    if (!active) return undefined;
    checkProcs();
    const t = setInterval(checkProcs, 15000);
    return () => clearInterval(t);
  }, [active, checkProcs]);

  useEffect(() => on('clean:log', ({ line }) => setLog((l) => [...l.slice(-300), line])), []);
  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [log]);

  const lockedBy = useCallback((c) => (c.processes || []).find((p) => procs.has(p)), [procs]);
  const blocked = useCallback((c) => (c.admin && !admin) || !!lockedBy(c), [admin, lockedBy]);
  const recommended = useCallback(
    () => cleaners.filter((c) => c.grade === 'A' && !blocked(c) && !c.slow && (sizes[c.id] || 0) > 0).map((c) => c.id),
    [cleaners, sizes, blocked],
  );

  // Only "Safe" items are pre-selected, once their sizes are known (never slow DISM runs or blocked items).
  useEffect(() => {
    if (defaultsDone.current || !cleaners.length) return;
    if (cleaners.some((c) => c.grade === 'A' && sizes[c.id] === undefined)) return;
    defaultsDone.current = true;
    setSelected(new Set(recommended()));
  }, [cleaners, sizes, recommended]);

  // A selected item that becomes locked or blocked is deselected.
  useEffect(() => {
    setSelected((s) => {
      const n = new Set([...s].filter((id) => {
        const c = cleaners.find((x) => x.id === id);
        return c && !blocked(c);
      }));
      return n.size === s.size ? s : n;
    });
  }, [blocked, cleaners]);

  const sections = useMemo(
    () => SECTIONS.map(([key, title]) => [title, cleaners.filter((c) => c.section === key)]).filter(([, l]) => l.length),
    [cleaners],
  );
  const chosen = cleaners.filter((c) => selected.has(c.id));
  const pending = chosen.reduce((n, c) => n + (sizes[c.id] || 0), 0);
  const drives = info?.drives || [];
  const sys = drives.find((d) => d.system) || drives[0];
  const others = drives.filter((d) => d !== sys);
  const needsAdmin = info && !admin && info.platform === 'win32' && cleaners.some((c) => c.admin);

  useEffect(() => {
    if (phase === 'list') fadeRows(listRef.current?.querySelectorAll('tr.row') || []);
  }, [cleaners, phase]);

  const toggle = (id) => {
    const c = cleaners.find((x) => x.id === id);
    if (!c || blocked(c) || phase !== 'list') return;
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else {
        n.add(id);
        if (PAIRS[id]) n.delete(PAIRS[id]);
      }
      return n;
    });
  };

  async function openPreview() {
    if (!chosen.length) return;
    setPhase('preview');
    setPreview(null);
    setError(null);
    try {
      const p = await api.previewClean(chosen.map((c) => c.id));
      // The review measures fresh; make the drive bar match it exactly.
      setSizes((m) => ({ ...m, ...Object.fromEntries(p.filter((x) => x.kind === 'files').map((x) => [x.id, x.bytes])) }));
      setPreview(p);
    } catch (e) {
      setError(e.message);
      setPhase('list');
    }
  }

  async function commit() {
    const ids = chosen.map((c) => c.id);
    setPhase('running');
    setLog([]);
    setResults({});
    setReceipt(null);
    setSkippedLine(null);
    const since = new Date(Date.now() - 1000).toISOString();
    try {
      const r = await api.clean(ids);
      setResults(Object.fromEntries(r.map((x) => [x.id, x])));
      const mine = (await api.ledger().catch(() => [])).filter((x) => x.at >= since);
      setReceipt(mine.find((x) => x.verb !== 'Skipped') || null);
      setSkippedLine(mine.find((x) => x.verb === 'Skipped') || null);
      ledgerChanged();
    } catch (e) {
      setError(e.message);
    } finally {
      setSelected(new Set());
      setPhase('list');
      setPreview(null);
      refreshInfo();
      measure(cleaners, true);
    }
  }

  const retry = (id) => {
    setSelected(new Set([id]));
    setExpanded(id);
  };
  const relaunch = () => api.relaunchAdmin().catch((e) => setError(e.message));

  /* ---------- details under a row ---------- */
  const details = (c) => {
    const r = results[c.id];
    const lock = lockedBy(c);
    const facts = [
      ['What it is', c.description],
      ['If removed', c.breaks],
      ['Comes back?', c.back],
      ['Goes to', c.dest],
      ['Undo', c.undo],
    ].filter(([, v]) => v);
    return (
      <>
        <dl className="facts">
          {facts.map(([k, v]) => (
            <React.Fragment key={k}>
              <dt>{k}</dt>
              <dd>{v}</dd>
            </React.Fragment>
          ))}
        </dl>
        {lock && (
          <p className="err" style={{ marginTop: 8 }}>
            {lock} is running, so its files are locked. Close it, then{' '}
            <Button variant="link" onClick={checkProcs}>check again</Button>.
          </p>
        )}
        {c.admin && !admin && (
          <p style={{ marginTop: 8 }}>
            Windows protects this folder. <Button variant="link" onClick={relaunch}>Restart as administrator</Button> to clean it.
          </p>
        )}
        {c.slow && <p style={{ marginTop: 8 }}>Takes 10–20 minutes and can’t be stopped once started.</p>}
        {r?.error && (
          <p className="err" style={{ marginTop: 8 }}>
            Couldn’t finish: {r.error}. <Button variant="link" onClick={() => retry(c.id)}>Try again</Button>
          </p>
        )}
        {r?.locked && (
          <p className="err" style={{ marginTop: 8 }}>
            Skipped because {r.locked} was running. Close it and <Button variant="link" onClick={() => retry(c.id)}>try again</Button>.
          </p>
        )}
        {r?.skipped > 0 && (
          <p style={{ marginTop: 8 }}>
            Left {r.skipped} file(s), {bytes(r.skippedBytes)}, that were in use. <Button variant="link" onClick={() => retry(c.id)}>Try again</Button>
          </p>
        )}
      </>
    );
  };

  /* ---------- review groups ---------- */
  const previewGroups = useMemo(() => {
    if (!preview) return [];
    return GRADE_ORDER.map((g) => ({
      key: g,
      heading: GRADE_HEAD[g],
      note: g === 'C' ? GRADE.C.explain : null,
      undo: GRADE_UNDO[g],
      items: preview
        .filter((p) => p.grade === g)
        .map((p) => ({
          id: p.id,
          grade: p.grade,
          title: p.name,
          bytes: p.kind === 'files' ? p.bytes : sizes[p.id],
          dest: p.dest,
          paths: p.items.map((i) => ({ path: i.path, bytes: p.kind === 'command' ? null : i.bytes, files: i.files, note: i.scope })),
          warn: p.error,
        })),
    })).filter((g) => g.items.length);
  }, [preview, sizes]);

  return (
    <Page title="Clean up" sub="Choose what to remove. You’ll see exactly what changes before anything is deleted.">
      {sys && (
        <Card>
          <div className="card-body">
            <div className="soft small">{sys.letter} {sys.label}</div>
            <div className="big">
              <Num value={sys.free} /> free
            </div>
            <div style={{ marginTop: 12 }}>
              <DriveBar drive={sys} freeing={pending} />
            </div>
            <div className="legend">
              <span><span className="swatch" style={{ background: 'var(--bar-used)' }} />Used <b>{bytes(sys.size - sys.free - Math.min(pending, sys.size - sys.free))}</b></span>
              <span><span className="swatch" style={{ background: 'var(--ok)' }} />Selected to free <b>{bytes(pending)}</b></span>
              <span><span className="swatch" style={{ background: 'var(--surface-2)', outline: '1px solid var(--border)' }} />Free after cleanup <b>{bytes(sys.free + Math.min(pending, sys.size - sys.free))}</b></span>
            </div>
            {others.length > 0 && (
              <div className="sub" style={{ marginTop: 12 }}>
                {others.map((d) => `${d.letter} ${d.label}: ${bytes(d.free)} free of ${bytes(d.size)}`).join('  ·  ')}
              </div>
            )}
          </div>
        </Card>
      )}

      {error && <Notice tone="error">{error}</Notice>}
      {(receipt || skippedLine) && (
        <Notice tone="success" actions={<Button small onClick={() => go('ledger')}>View history</Button>}>
          {receipt ? `Done. ${receipt.verb} ${receipt.bytes ? bytes(receipt.bytes) : ''}.` : 'Done.'}
          {skippedLine && ` Skipped ${bytes(skippedLine.bytes)} (${skippedLine.subject}).`}
        </Notice>
      )}
      {needsAdmin && phase === 'list' && (
        <Notice actions={<Button small onClick={relaunch}>Restart as administrator</Button>}>
          A few Windows items need administrator rights and are turned off for now.
        </Notice>
      )}

      {phase === 'preview' && (
        <div style={{ marginTop: 16 }}>
          <Preview
            title={`Review: ${bytes(pending)} will be removed`}
            loading={!preview}
            groups={previewGroups}
            total={pending}
            totalLabel="Total to free"
            onBack={() => setPhase('list')}
            commitLabel={`Clean up ${bytes(pending)}`}
            onCommit={commit}
          />
        </div>
      )}

      {phase === 'running' && (
        <Card title="Cleaning up…" meta={<Button small onClick={() => api.cancelClean()}>Stop</Button>}>
          <div className="card-body">
            <div aria-live="polite">{log[log.length - 1] || 'Starting…'}</div>
            {log.length > 1 && (
              <details style={{ marginTop: 8 }}>
                <summary className="small">Show details</summary>
                <div className="log" ref={logRef} style={{ marginTop: 8 }}>
                  {log.map((l, i) => (
                    <div key={i} className={i === log.length - 1 ? 'now' : ''}>{l}</div>
                  ))}
                </div>
              </details>
            )}
          </div>
        </Card>
      )}

      <div hidden={phase !== 'list'} ref={listRef}>
        {!cleaners.length && !error && <Card><div className="empty">Looking for things to clean…</div></Card>}
        {sections.map(([title, list]) => (
          <Card key={title} title={title} meta={bytes(list.reduce((n, c) => n + (sizes[c.id] || 0), 0))}>
            <table className="table">
              <tbody>
                {list.map((c) => {
                  const lock = lockedBy(c);
                  const isBlocked = blocked(c);
                  const r = results[c.id];
                  const s = sizes[c.id];
                  const open = expanded === c.id;
                  return (
                    <React.Fragment key={c.id}>
                      <tr
                        className={`row ${isBlocked ? 'disabled' : 'clickable'} ${selected.has(c.id) ? 'selected' : ''}`}
                        onClick={() => toggle(c.id)}
                      >
                        <td className="check">
                          <Box checked={selected.has(c.id)} disabled={isBlocked} onChange={() => toggle(c.id)} label={c.name} />
                        </td>
                        <td className="name">
                          <div className="name-line">
                            <span className="name-text">{c.name}</span>
                            <GradeTag grade={c.grade} />
                            {lock && <span className="tag danger">Close {lock} first</span>}
                            {c.admin && !admin && !lock && <span className="tag">Needs administrator</span>}
                            {c.slow && <span className="tag">Slow</span>}
                            {(r?.error || r?.locked) && <span className="tag danger">Didn’t finish</span>}
                          </div>
                        </td>
                        <td className="size">
                          {s === undefined ? <span className="soft small">measuring…</span> : s === null ? <span className="soft">—</span> : bytes(s)}
                        </td>
                        <td className="actions-cell">
                          <Button
                            small
                            variant="link"
                            aria-expanded={open}
                            onClick={(e) => {
                              e.stopPropagation();
                              setExpanded(open ? null : c.id);
                            }}
                          >
                            {open ? 'Hide' : 'Details'}
                          </Button>
                        </td>
                      </tr>
                      {open && (
                        <tr className="details-row">
                          <td colSpan={4}>{details(c)}</td>
                        </tr>
                      )}
                    </React.Fragment>
                  );
                })}
              </tbody>
            </table>
          </Card>
        ))}

        {cleaners.length > 0 && (
          <ActionBar summary={chosen.length ? `${bytes(pending)} selected · ${chosen.length} item${chosen.length === 1 ? '' : 's'}` : 'Nothing selected'}>
            <Button onClick={() => setSelected(new Set(recommended()))}>Select safe items</Button>
            <Button onClick={() => setSelected(new Set())} disabled={!selected.size}>Clear</Button>
            <Button onClick={() => measure(cleaners, true)} title="Measure every item again">Refresh</Button>
            <Button variant="primary" disabled={!chosen.length || pending <= 0} onClick={openPreview}>
              Review and clean up →
            </Button>
          </ActionBar>
        )}
      </div>
    </Page>
  );
}
