import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AppCtx } from './lib/context.js';
import { api, isDemo } from './lib/api.js';
import { ViewCtx } from './components/ui.jsx';
import Overview from './views/Overview.jsx';
import Space from './views/Space.jsx';
import Duplicates from './views/Duplicates.jsx';
import Programs from './views/Programs.jsx';
import MoveDrive from './views/MoveDrive.jsx';
import Ledger from './views/Ledger.jsx';

const TABS = [
  { id: 'overview', label: 'Clean up', View: Overview },
  { id: 'space', label: 'Disk usage', View: Space },
  { id: 'dupes', label: 'Duplicates', View: Duplicates },
  { id: 'programs', label: 'Programs', View: Programs },
  { id: 'move', label: 'Move folders', View: MoveDrive },
  { id: 'ledger', label: 'History', View: Ledger },
];
const THEMES = ['system', 'light', 'dark'];
const THEME_LABEL = { system: 'Theme: Windows', light: 'Theme: Light', dark: 'Theme: Dark' };

function readTheme() {
  try {
    const t = localStorage.getItem('reclaim.theme');
    return THEMES.includes(t) ? t : 'system';
  } catch {
    return 'system';
  }
}

export default function App() {
  const [view, setView] = useState('overview');
  const [params, setParams] = useState({});
  // Views stay mounted after their first visit so running work keeps its state.
  const [visited, setVisited] = useState(() => new Set(['overview']));
  const [info, setInfo] = useState(null);
  const [theme, setTheme] = useState(readTheme);
  const [ledgerTick, setLedgerTick] = useState(0);
  const sessionStart = useRef(new Date().toISOString()).current;

  const refreshInfo = useCallback(() => api.info().then(setInfo).catch(() => {}), []);
  useEffect(() => {
    refreshInfo();
  }, [refreshInfo]);

  useEffect(() => {
    const el = document.documentElement;
    if (theme === 'system') el.removeAttribute('data-theme');
    else el.setAttribute('data-theme', theme);
    api.setTheme(theme).catch(() => {});
    try {
      localStorage.setItem('reclaim.theme', theme);
    } catch {
      /* per-viewer convenience only */
    }
  }, [theme]);

  // Each view keeps its own scroll position.
  const mainRef = useRef(null);
  const scrolls = useRef({});
  const viewRef = useRef(view);
  useEffect(() => {
    viewRef.current = view;
    if (mainRef.current) mainRef.current.scrollTop = scrolls.current[view] || 0;
  }, [view]);

  const go = useCallback((id, p = {}) => {
    if (mainRef.current) scrolls.current[viewRef.current] = mainRef.current.scrollTop;
    if (p.src || p.finalize || p.undo) scrolls.current[id] = 0;
    setParams({ ...p, view: id, nonce: Date.now() });
    setVisited((v) => (v.has(id) ? v : new Set([...v, id])));
    setView(id);
  }, []);

  /** Something was written to the history: refresh it. */
  const ledgerChanged = useCallback(() => setLedgerTick((t) => t + 1), []);

  const ctx = useMemo(
    () => ({ info, refreshInfo, go, params, ledgerTick, ledgerChanged, sessionStart }),
    [info, refreshInfo, go, params, ledgerTick, ledgerChanged, sessionStart],
  );

  return (
    <AppCtx.Provider value={ctx}>
      <div className="app">
        <header className="topbar">
          <span className="brand">Reclaim</span>
          <nav className="tabs" aria-label="Views">
            {TABS.map((t) => (
              <button key={t.id} className="tab" aria-current={view === t.id ? 'page' : undefined} onClick={() => go(t.id)}>
                {t.label}
              </button>
            ))}
          </nav>
          <div className="topbar-tools">
            {isDemo && <span className="demo-tag">Demo data</span>}
            <button className="btn small" onClick={() => setTheme(THEMES[(THEMES.indexOf(theme) + 1) % THEMES.length])} title="Follow Windows, or always light or dark">
              {THEME_LABEL[theme]}
            </button>
          </div>
        </header>
        <main className="scroll" ref={mainRef}>
          {TABS.filter((t) => visited.has(t.id)).map(({ id, View }) => (
            <div key={id} hidden={view !== id}>
              <ViewCtx.Provider value={{ active: view === id, id }}>
                <View />
              </ViewCtx.Provider>
            </div>
          ))}
        </main>
      </div>
    </AppCtx.Provider>
  );
}
