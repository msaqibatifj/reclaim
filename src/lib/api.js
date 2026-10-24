/**
 * Thin wrapper over the Electron preload bridge.
 * When the UI runs in a plain browser (`npm run dev:web`) it falls back to a mock
 * backend with demo data, so the interface can be developed without Windows.
 */
import { createMock } from './mock.js';

const bridge = typeof window !== 'undefined' && window.reclaim ? window.reclaim : null;
export const isDemo = !bridge;
const backend = bridge || createMock();

// Electron prefixes errors from the main process with "Error invoking remote method 'x': Error: ".
const clean = (e) => {
  const msg = String(e?.message || e).replace(/^Error invoking remote method '[^']+': (?:\w*Error: )?/, '');
  return Object.assign(new Error(msg), { cause: e });
};
export const invoke = (channel, ...args) => backend.invoke(channel, ...args).catch((e) => Promise.reject(clean(e)));
export const on = (channel, cb) => backend.on(channel, cb);

export const api = {
  info: () => invoke('sys:info'),
  systemFiles: () => invoke('sys:systemFiles'),
  processes: () => invoke('sys:processes'),
  setTheme: (t) => invoke('sys:setTheme', t),
  previewClean: (ids) => invoke('clean:preview', ids),
  ledger: () => invoke('ledger:list'),
  exportLedger: (format) => invoke('ledger:export', format),
  undoReceipt: (id) => invoke('ledger:undo', id),
  scan: (root, opts) => invoke('scan:start', root, opts),
  cancelScan: () => invoke('scan:cancel'),
  cleaners: () => invoke('clean:list'),
  estimate: (id, opts) => invoke('clean:estimate', id, opts),
  clean: (ids, opts) => invoke('clean:run', ids, opts),
  cancelClean: () => invoke('clean:cancel'),
  planMove: (src, dest) => invoke('move:plan', src, dest),
  move: (src, dest) => invoke('move:run', src, dest),
  moves: () => invoke('move:list'),
  finalizeMove: (id) => invoke('move:finalize', id),
  undoMove: (id) => invoke('move:undo', id),
  dupeDefaults: () => invoke('dupes:defaults'),
  dupes: (roots, opts) => invoke('dupes:start', roots, opts),
  cancelDupes: () => invoke('dupes:cancel'),
  programs: () => invoke('programs:list'),
  uninstall: (id) => invoke('programs:uninstall', id),
  openAppsSettings: () => invoke('programs:openSettings'),
  reveal: (p) => invoke('shell:reveal', p),
  open: (p) => invoke('shell:open', p),
  trash: (paths) => invoke('dupes:trash', paths),
  pickFolder: (title) => invoke('dialog:pickFolder', title),
  relaunchAdmin: () => invoke('admin:relaunch'),
};
