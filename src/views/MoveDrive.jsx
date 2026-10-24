import React, { useEffect, useState } from 'react';
import { api, on } from '../lib/api.js';
import { useApp } from '../lib/context.js';
import { baseName, bytes, day, midPath, num } from '../lib/format.js';
import Preview from '../components/Preview.jsx';
import { Button, Card, Notice, Page } from '../components/ui.jsx';

const RUN_STEPS = ['Copying files', 'Verifying copy', 'Renaming original', 'Creating junction'];
const STATUS = {
  'pending-cleanup': ['Old copy still on drive', 'check'],
  done: ['Done', 'safe'],
  undone: ['Moved back', ''],
};

export default function MoveDrive() {
  const { info, params, refreshInfo, go, ledgerChanged } = useApp();
  const drives = info?.drives || [];
  const target = drives.filter((d) => !d.system).sort((a, b) => b.free - a.free)[0];

  const [src, setSrc] = useState('');
  const [dest, setDest] = useState('');
  const [destAuto, setDestAuto] = useState(true);
  const [hint, setHint] = useState(null); // size known from the Disk usage view
  const [plan, setPlan] = useState(null);
  const [phase, setPhase] = useState('form'); // form | planning | preview | running | finalize | undo | working
  const [step, setStep] = useState(null);
  const [progress, setProgress] = useState(null);
  const [log, setLog] = useState([]);
  const [error, setError] = useState(null);
  const [history, setHistory] = useState([]);
  const [focus, setFocus] = useState(null); // history entry for finalize/undo
  const [receipt, setReceipt] = useState(null);

  const loadHistory = () => api.moves().then(setHistory).catch(() => {});
  useEffect(() => {
    loadHistory();
  }, []);
  useEffect(() => on('move:step', setStep), []);
  useEffect(() => on('move:progress', setProgress), []);
  useEffect(() => on('move:log', (l) => setLog((x) => [...x.slice(-200), l])), []);

  const busy = ['running', 'working', 'planning'].includes(phase);

  // Arrivals from Disk usage ("Move…") or History ("Delete old copy" / "Move back").
  useEffect(() => {
    if (params?.view !== 'move' || busy) return;
    if (params.src) {
      setSrc(params.src);
      setHint(params.size ?? null);
      setPhase('form');
    }
    if (params.finalize || params.undo) {
      api.moves().then((h) => {
        setHistory(h);
        const e = h.find((x) => x.id === (params.finalize || params.undo));
        if (e) {
          setFocus(e);
          setPhase(params.finalize ? 'finalize' : 'undo');
        }
      });
    }
  }, [params]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    setPlan(null);
    if (src && target && (destAuto || !dest)) {
      setDest(`${target.letter}\\Reclaim\\${baseName(src)}`);
      setDestAuto(true);
    }
  }, [src, target?.letter]); // eslint-disable-line react-hooks/exhaustive-deps

  async function preview() {
    setPhase('planning');
    setError(null);
    try {
      const p = await api.planMove(src.trim(), dest.trim());
      setPlan(p);
      setPhase(p.ok ? 'preview' : 'form');
    } catch (e) {
      setError(e.message);
      setPhase('form');
    }
  }

  const afterAction = async () => {
    const l = await api.ledger().catch(() => []);
    setReceipt(l[0] || null);
    ledgerChanged();
    loadHistory();
    refreshInfo();
  };

  async function run() {
    setPhase('running');
    setError(null);
    setProgress(null);
    setLog([]);
    setStep(RUN_STEPS[0]);
    try {
      await api.move(plan.src, plan.dest);
      setPlan(null);
      setSrc('');
      setHint(null);
      await afterAction();
    } catch (e) {
      setError(e.message);
    } finally {
      setPhase('form');
      setStep(null);
      setProgress(null);
    }
  }

  async function runFocus(kind) {
    setPhase('working');
    setError(null);
    setProgress(null);
    try {
      if (kind === 'finalize') await api.finalizeMove(focus.id);
      else await api.undoMove(focus.id);
      await afterAction();
    } catch (e) {
      setError(e.message);
    } finally {
      setPhase('form');
      setFocus(null);
      setProgress(null);
    }
  }

  const sys = drives.find((d) => d.system);
  const planErrors = plan && !plan.ok ? plan.errors : [];
  const copied = progress?.total ? `${bytes(progress.copied)} of ${bytes(progress.total)}` : null;
  const pct = progress?.total ? (progress.copied / progress.total) * 100 : 0;

  /* ---------- review sheets ---------- */
  let sheet = null;
  if (phase === 'preview' || (phase === 'running' && plan)) {
    sheet = (
      <Preview
        title={`Review: move ${baseName(plan.src)} (${bytes(plan.bytes)})`}
        danger={false}
        groups={[
          {
            key: 'move',
            heading: 'Move to another drive',
            undo: 'use “Move back” in the list below or in History.',
            items: [
              {
                id: 'm',
                title: baseName(plan.src),
                bytes: plan.bytes,
                dest: midPath(plan.dest, 48),
                paths: [
                  { path: plan.src, bytes: plan.bytes, files: plan.files, note: 'copied, then renamed to *.reclaim-old' },
                  { path: plan.dest, note: 'files live here' },
                  { path: plan.src, note: 'shortcut (junction) left here' },
                ],
              },
            ],
          },
        ]}
        total={plan.bytes}
        totalLabel="To move"
        onBack={() => setPhase('form')}
        busy={phase === 'running'}
        commitLabel={phase === 'running' ? `${step || 'Moving'}…` : `Move ${bytes(plan.bytes)}`}
        onCommit={run}
      >
        <ol className="steps">
          {plan.steps.map((s, i) => (
            <li key={s} className={phase === 'running' && i === RUN_STEPS.indexOf(step) ? 'now' : ''}>{s}</li>
          ))}
        </ol>
        {plan.warnings.map((w) => (
          <p key={w} className="sub" style={{ marginTop: 8 }}>{w}</p>
        ))}
        {phase === 'running' && (
          <>
            {progress?.total > 0 && <div className="progress"><div style={{ width: `${pct}%` }} /></div>}
            <p className="sub" style={{ marginTop: 8 }}>
              {copied ? `${copied} copied. ` : ''}Keep Reclaim open. If anything fails, the original is put back.
            </p>
          </>
        )}
      </Preview>
    );
  } else if ((phase === 'finalize' || phase === 'undo' || phase === 'working') && focus) {
    const fin = phase === 'finalize' || (phase === 'working' && focus._kind === 'finalize');
    sheet = (
      <Preview
        title={fin ? `Review: delete the old copy (${bytes(focus.bytes)})` : `Review: move ${baseName(focus.src)} back (${bytes(focus.bytes)})`}
        danger={fin}
        groups={[
          fin
            ? { key: 'f', heading: 'Permanently delete the old copy', undo: 'not possible. Your data stays at the new location; Reclaim checks it is still there first.', items: [{ id: 'f', title: `Old copy of ${baseName(focus.src)}`, bytes: focus.bytes, dest: 'permanent delete', paths: [{ path: focus.old, bytes: focus.bytes, files: focus.files }] }] }
            : { key: 'u', heading: 'Copy back and remove the shortcut', undo: 'move it again from this page.', items: [{ id: 'u', title: baseName(focus.src), bytes: focus.bytes, dest: midPath(focus.src, 48), paths: [{ path: focus.dest, note: 'copied back from' }, { path: focus.src, note: `needs ${bytes(focus.bytes)} free here` }] }] },
        ]}
        total={focus.bytes}
        totalLabel={fin ? `Frees on ${sys?.letter || 'C:'}` : 'To copy back'}
        onBack={() => { setPhase('form'); setFocus(null); }}
        busy={phase === 'working'}
        commitLabel={phase === 'working' ? 'Working…' : fin ? `Delete old copy (${bytes(focus.bytes)})` : `Move back ${bytes(focus.bytes)}`}
        onCommit={() => {
          setFocus((f) => ({ ...f, _kind: fin ? 'finalize' : 'undo' }));
          runFocus(fin ? 'finalize' : 'undo');
        }}
      >
        {phase === 'working' && copied && <p className="sub">{copied}</p>}
      </Preview>
    );
  }

  return (
    <Page
      title="Move folders"
      sub="Move a big folder (like a game library or download cache) to another drive. A shortcut called a junction is left behind, so apps keep working without reinstalling — as long as that drive stays connected."
    >
      {error && <Notice tone="error">{error}</Notice>}
      {planErrors.length > 0 && (
        <Notice tone="error">
          Can’t move this folder. {planErrors.join(' ')}
        </Notice>
      )}
      {receipt && (
        <Notice tone="success" actions={<Button small onClick={() => go('ledger')}>View history</Button>}>
          {receipt.verb} {bytes(receipt.bytes)}{receipt.dest ? ` → ${receipt.dest}` : ''}.
        </Notice>
      )}

      {sheet ? (
        <div style={{ marginTop: 16 }}>{sheet}</div>
      ) : (
        <Card title="Move a folder">
          <div className="card-body">
            <div className="form-row">
              <div className="field">
                <label htmlFor="mv-src">Folder to move</label>
                <input id="mv-src" className="input" value={src} onChange={(e) => { setSrc(e.target.value); setHint(null); }} placeholder="For example C:\Users\you\AppData\Local\npm-cache" disabled={busy} aria-invalid={planErrors.length > 0} />
              </div>
              <Button disabled={busy} onClick={async () => { const p = await api.pickFolder('Folder to move'); if (p) { setSrc(p); setHint(null); } }}>Browse…</Button>
            </div>
            <div className="form-row">
              <div className="field">
                <label htmlFor="mv-dest">New location</label>
                <input id="mv-dest" className="input" value={dest} onChange={(e) => { setDest(e.target.value); setDestAuto(false); setPlan(null); }} placeholder="Filled in for you once you pick a folder" disabled={busy} />
              </div>
              <Button disabled={busy} onClick={async () => { const p = await api.pickFolder('Choose where to put it'); if (p) { setDest(`${p.replace(/[\\/]+$/, '')}\\${baseName(src) || 'Moved'}`); setDestAuto(false); setPlan(null); } }}>Browse…</Button>
            </div>
            {!target && drives.length > 0 && <p className="sub" style={{ marginTop: 12 }}>Only one drive was found. Connect another drive to move folders to it.</p>}
            <div className="btn-row" style={{ marginTop: 16 }}>
              {hint != null && <span className="sub">About {bytes(hint)}</span>}
              <span className="spacer" />
              <Button variant="primary" disabled={!src || !dest || busy} onClick={preview}>
                {phase === 'planning' ? 'Measuring…' : 'Review move →'}
              </Button>
            </div>
          </div>
        </Card>
      )}

      <Card title="Moved folders" meta={history.length || ''}>
        {history.length === 0 ? (
          <div className="empty">Nothing moved yet. Good candidates: game libraries, package caches, big project folders, screen recordings.</div>
        ) : (
          <table className="table">
            <tbody>
              {history.map((m) => (
                <tr key={m.id} className="row">
                  <td className="name" title={`${m.src} → ${m.dest}`}>
                    <div className="name-line">
                      <span className="name-text">{baseName(m.src)}</span>
                      <span className={`tag ${STATUS[m.status]?.[1] || ''}`}>{STATUS[m.status]?.[0]}</span>
                    </div>
                    <div className="sub ellipsis">{midPath(m.src, 40)} → {midPath(m.dest, 40)} · {day(m.createdAt)}</div>
                    {m.status === 'pending-cleanup' && (
                      <div className="sub">Space on {sys?.letter || 'C:'} is freed once you delete the old copy. Open the app that uses this folder first to check it still works.</div>
                    )}
                  </td>
                  <td className="size">{bytes(m.bytes)}</td>
                  <td className="actions-cell">
                    <span className="btn-row" style={{ justifyContent: 'flex-end', flexWrap: 'nowrap' }}>
                      <Button small onClick={() => api.reveal(m.dest)}>Show</Button>
                      {m.status !== 'undone' && <Button small disabled={busy} onClick={() => { setFocus(m); setPhase('undo'); }}>Move back</Button>}
                      {m.status === 'pending-cleanup' && <Button small className="danger-outline" disabled={busy} onClick={() => { setFocus(m); setPhase('finalize'); }}>Delete old copy</Button>}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      {log.length > 0 && phase !== 'running' && (
        <details style={{ marginTop: 16 }}>
          <summary className="small">Copy log ({num(log.length)} lines)</summary>
          <div className="log" style={{ marginTop: 8 }}>{log.join('\n')}</div>
        </details>
      )}
    </Page>
  );
}
