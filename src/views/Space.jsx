import React, { useEffect, useMemo, useRef, useState } from 'react';
import { api, on } from '../lib/api.js';
import { useApp } from '../lib/context.js';
import { bytes, clock, day, midPath, num, pct } from '../lib/format.js';
import { fadeRows } from '../lib/motion.js';
import { Button, Card, Notice, Num, Page, useViewKeys } from '../components/ui.jsx';

// Mirrors mover.assertMovable; the main process re-checks before anything moves.
const SYSTEM_TREES = [/^[a-z]:\\windows(\\|$)/i, /^[a-z]:\\program files( \(x86\))?(\\|$)/i, /^[a-z]:\\programdata\\microsoft/i, /^[a-z]:\\recovery/i, /^[a-z]:\\system volume information/i];
const movable = (n) =>
  n.dir &&
  n.path.split('\\').filter(Boolean).length >= 2 &&
  !/^[a-z]:\\users$/i.test(n.path) &&
  !SYSTEM_TREES.some((r) => r.test(n.path)) &&
  !/\\users\\[^\\]+$/i.test(n.path) &&
  !/\\appdata(\\(local|roaming|locallow))?$/i.test(n.path) &&
  !/\\onedrive( - [^\\]*)?(\\|$)/i.test(n.path);
const GHOSTS = 10;

export default function Space() {
  const { info, go } = useApp();
  const drives = info?.drives || [];
  const [root, setRoot] = useState('');
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(null);
  const [stream, setStream] = useState([]); // top-level rows as they finish
  const [result, setResult] = useState(null);
  const [trail, setTrail] = useState([]);
  const [drilling, setDrilling] = useState(false);
  const [error, setError] = useState(null);
  const [started, setStarted] = useState(0);
  const [now, setNow] = useState(0);
  const tableRef = useRef(null);

  useEffect(() => {
    if (!root && drives.length) setRoot((drives.find((d) => d.system) || drives[0]).letter + '\\');
  }, [drives, root]);
  useEffect(() => on('scan:progress', setProgress), []);
  useEffect(() => on('scan:row', (r) => setStream((s) => [...s, r])), []);
  useEffect(() => {
    if (!busy) return undefined;
    const t = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(t);
  }, [busy]);

  const current = trail[trail.length - 1];
  const kids = current?.children || [];
  const rowsLive = useMemo(() => [...stream].sort((a, b) => b.size - a.size), [stream]);

  useEffect(() => {
    fadeRows(tableRef.current?.querySelectorAll('tr.row') || []);
  }, [rowsLive, current]);

  useViewKeys((e) => {
    if (e.key === 'Escape' && !busy && trail.length > 1) setTrail((t) => t.slice(0, -1));
  });

  async function scan() {
    if (busy || !root) return;
    setBusy(true);
    setError(null);
    setProgress(null);
    setStream([]);
    setStarted(Date.now());
    setNow(Date.now());
    try {
      const r = await api.scan(root, { maxDepth: 4 });
      setResult(r);
      setTrail([r.tree]);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function open(n) {
    if (!n?.dir || drilling || busy) return;
    if (n.truncated && !n.children?.length) {
      setDrilling(true);
      setError(null);
      try {
        const r = await api.scan(n.path, { maxDepth: 3 });
        if (r.aborted) return;
        n.children = r.tree.children;
        n.truncated = false;
      } catch (e) {
        setError(e.message);
        return;
      } finally {
        setDrilling(false);
      }
    }
    setTrail((t) => [...t, n]);
  }

  const shown = busy ? rowsLive : kids;
  const max = shown[0]?.size || 1;
  const cats = result ? Object.entries(result.categories).sort((a, b) => b[1] - a[1]) : [];
  const catTotal = cats.reduce((n, [, v]) => n + v, 0);

  return (
    <Page title="Disk usage" sub="See which folders take up the most space. This only reads sizes; nothing is changed.">
      <Card>
        <div className="card-body">
          <div className="form-row" style={{ gridTemplateColumns: 'minmax(0,1fr) auto auto' }}>
            <div className="field">
              <label htmlFor="scan-root">Drive or folder</label>
              <select id="scan-root" className="input" value={root} onChange={(e) => setRoot(e.target.value)} disabled={busy}>
                {root && !drives.some((d) => d.letter + '\\' === root) && <option value={root}>{root}</option>}
                {drives.map((d) => (
                  <option key={d.letter} value={d.letter + '\\'}>
                    {d.letter} {d.label} — {bytes(d.size - d.free)} used
                  </option>
                ))}
              </select>
            </div>
            <Button disabled={busy} onClick={async () => { const p = await api.pickFolder('Folder to scan'); if (p) setRoot(p); }}>
              Choose folder…
            </Button>
            {busy ? (
              <Button onClick={() => api.cancelScan()}>Stop</Button>
            ) : (
              <Button variant="primary" onClick={scan} disabled={!root}>
                {result ? 'Scan again' : 'Scan'}
              </Button>
            )}
          </div>
          {busy && (
            <div className="sub" style={{ marginTop: 12 }} aria-live="polite">
              Scanning… {num(progress?.files)} files · {bytes(progress?.bytes || 0)} · {clock(now - started)}
              <div className="ellipsis mono" title={progress?.current}>{midPath(progress?.current || root, 80)}</div>
            </div>
          )}
          {!busy && result && (
            <div className="sub" style={{ marginTop: 12 }}>
              {num(result.stats.files)} files, {bytes(result.stats.bytes)}, scanned in {clock(result.stats.ms)}.
              {result.stats.errors > 0 && ` ${num(result.stats.errors)} items couldn’t be read (access denied).`}
              {result.aborted && <span className="err"> Stopped early, so totals are incomplete.</span>}
            </div>
          )}
        </div>
      </Card>

      {error && <Notice tone="error">{error}</Notice>}
      {drilling && <Notice>Reading folder…</Notice>}

      {!busy && !result && (
        <Card>
          <div className="empty">Pick a drive and press Scan. A full system drive takes one to three minutes.</div>
        </Card>
      )}

      {(busy || result) && (
        <Card
          title={busy ? 'Folders (filling in as they finish)' : <span>{current?.name || result.root} — <Num value={current?.size ?? result.tree.size} /></span>}
          meta={busy ? `${stream.length} measured` : `${kids.length} item${kids.length === 1 ? '' : 's'}`}
        >
          {!busy && trail.length > 1 && (
            <nav className="crumbs" aria-label="Folder path">
              <Button small onClick={() => setTrail((t) => t.slice(0, -1))}>← Up</Button>
              {trail.map((n, i) => (
                <React.Fragment key={n.path + i}>
                  {i > 0 && <span className="sep">›</span>}
                  {i === trail.length - 1 ? (
                    <span>{i === 0 ? n.path : n.name}</span>
                  ) : (
                    <Button variant="link" onClick={() => setTrail(trail.slice(0, i + 1))}>{i === 0 ? n.path : n.name}</Button>
                  )}
                </React.Fragment>
              ))}
            </nav>
          )}
          <table className="table" ref={tableRef}>
            <thead>
              <tr>
                <th>Name</th>
                <th />
                <th className="right">Size</th>
                <th className="right">Share</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {shown.map((k) => {
                const id = k.path + k.name;
                const canOpen = !busy && k.dir && (k.children?.length || k.truncated);
                return (
                  <tr key={id} className={`row ${canOpen ? 'clickable' : ''}`} onClick={() => canOpen && open(k)} title={canOpen ? 'Open folder' : k.path}>
                    <td className="name">
                      <div className="name-line">
                        <span aria-hidden="true">{k.dir ? '📁' : '📄'}</span>
                        <span className="name-text">{k.name}</span>
                        {canOpen && <span className="soft" aria-hidden="true">›</span>}
                      </div>
                    </td>
                    <td className="bar-cell">
                      <div className="inline-bar" style={{ width: `${Math.max(1, (k.size / max) * 100)}%` }} />
                    </td>
                    <td className="size">{bytes(k.size)}</td>
                    <td className="num soft">{busy ? '' : `${pct(k.size, current?.size)}%`}</td>
                    <td className="actions-cell" onClick={(e) => e.stopPropagation()}>
                      {!busy && (
                        <span className="btn-row" style={{ justifyContent: 'flex-end', flexWrap: 'nowrap' }}>
                          <Button small onClick={() => api.reveal(k.path)} title="Show in File Explorer">Show</Button>
                          {movable(k) && <Button small onClick={() => go('move', { src: k.path, size: k.size })} title="Move to another drive">Move…</Button>}
                        </span>
                      )}
                    </td>
                  </tr>
                );
              })}
              {busy &&
                Array.from({ length: Math.max(0, GHOSTS - shown.length) }, (_, i) => (
                  <tr key={`g${i}`} className="ghost" aria-hidden="true">
                    <td colSpan={5}><div className="ghost-fill" /></td>
                  </tr>
                ))}
            </tbody>
          </table>
        </Card>
      )}

      {!busy && result && (
        <>
          <Card title="Largest files" meta={`Top ${Math.min(15, result.topFiles.length)}`}>
            <table className="table">
              <tbody>
                {result.topFiles.slice(0, 15).map((f) => (
                  <tr key={f.path} className="row">
                    <td className="name" title={f.path}>
                      <div className="name-text">{f.name}</div>
                      <div className="sub ellipsis">{midPath(f.path, 70)}</div>
                    </td>
                    <td className="date">{f.mtime ? day(new Date(f.mtime)) : '—'}</td>
                    <td className="size">{bytes(f.size)}</td>
                    <td className="actions-cell">
                      <Button small onClick={() => api.reveal(f.path)} aria-label={`Show ${f.name} in File Explorer`}>Show</Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>

          <Card title="By file type" meta={bytes(catTotal)}>
            <table className="table">
              <tbody>
                {cats.map(([c, v]) => (
                  <tr key={c} className="row">
                    <td className="name">{c}</td>
                    <td className="bar-cell">
                      <div className="inline-bar" style={{ width: `${Math.max(1, (v / (cats[0]?.[1] || 1)) * 100)}%` }} />
                    </td>
                    <td className="size">{bytes(v)}</td>
                    <td className="num soft">{pct(v, catTotal)}%</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        </>
      )}
    </Page>
  );
}
