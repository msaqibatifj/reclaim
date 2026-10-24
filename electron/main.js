'use strict';
// More libuv threads = faster scans (each file needs an lstat). Must be set before any fs call.
process.env.UV_THREADPOOL_SIZE = process.env.UV_THREADPOOL_SIZE || '16';
const { app, BrowserWindow, Menu, ipcMain, shell, dialog, nativeTheme } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const { scan } = require('./lib/scanner');
const { buildCleaners, toMeta } = require('./lib/cleaners');
const mover = require('./lib/mover');
const { findDuplicates } = require('./lib/duplicates');
const system = require('./lib/system');
const safety = require('./lib/safety');
const recycle = require('./lib/recycle');
const { receipt, exportReceipts } = require('./lib/receipts');

// Dev mode only from an unpackaged checkout; an env var must never make a release load localhost.
const isDev = !app.isPackaged && !!process.env.RECLAIM_DEV;
const DEV_URL = 'http://localhost:5173';
let win;
let adminCache = null;

const getAdmin = async () => (adminCache ??= await system.isAdmin());

if (!app.requestSingleInstanceLock()) {
  // Two instances could run two cleanups or moves against the same folders.
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.focus();
  });
  app.whenReady().then(() => {
    if (!isDev) Menu.setApplicationMenu(null);
    registerIpc();
    createWindow();
    app.on('activate', () => BrowserWindow.getAllWindows().length === 0 && createWindow());
  });
}
app.on('window-all-closed', () => process.platform !== 'darwin' && app.quit());

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 960,
    minHeight: 640,
    title: 'Reclaim',
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#14161C' : '#F4F1EA', // paper, so there is no flash before the UI paints
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });
  win.once('ready-to-show', () => win.show());

  const indexFile = path.join(__dirname, '..', 'dist', 'index.html');
  if (isDev) win.loadURL(DEV_URL);
  else win.loadFile(indexFile);

  // Never navigate away from the app; open https links in the default browser instead.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  const appUrl = isDev ? DEV_URL : require('node:url').pathToFileURL(indexFile).href;
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith(appUrl)) e.preventDefault();
  });
  win.on('closed', () => (win = null));
}

/* ------------------------------------------------------------------ */

function registerIpc() {
  let sysFilesCache = null;
  const systemFiles = async () => (sysFilesCache ??= await system.systemFiles());
  const cleaners = buildCleaners(process.env, {
    hiberfilSize: async () => (await systemFiles()).find((f) => f.name === 'hiberfil.sys')?.size ?? 0,
  });
  const byId = new Map(cleaners.map((c) => [c.id, c]));
  const ledger = new mover.Ledger(path.join(app.getPath('userData'), 'moves.json'));
  // Receipts reuse the same atomic JSON list store.
  const receipts = new mover.Ledger(path.join(app.getPath('userData'), 'receipts.json'));
  const record = (fields) => {
    const r = receipt(fields);
    receipts.add(r);
    return r;
  };
  const jobs = new Map(); // name -> AbortController (scans: newest replaces older)
  const busy = new Set(); // names of exclusive jobs currently running (clean, move)

  const startJob = (name) => {
    jobs.get(name)?.abort();
    const ac = new AbortController();
    jobs.set(name, ac);
    return ac;
  };
  /** Run fn as an exclusive job: a second request while one runs is rejected, never interleaved. */
  const exclusive = async (name, message, fn) => {
    if (busy.has(name)) throw new Error(message);
    busy.add(name);
    try {
      return await fn();
    } finally {
      busy.delete(name);
    }
  };
  const send = (e, channel, payload) => !e.sender.isDestroyed() && e.sender.send(channel, payload);

  /* system */
  ipcMain.handle('sys:info', async () => ({
    platform: process.platform,
    admin: await getAdmin(),
    drives: await system.getDrives().catch(() => []),
    home: app.getPath('home'),
    systemDrive: process.env.SystemDrive || 'C:',
    version: app.getVersion(),
  }));
  ipcMain.handle('sys:processes', () => system.runningProcesses());
  // Manual theme override also themes the native title bar.
  ipcMain.handle('sys:setTheme', (_e, t) => {
    nativeTheme.themeSource = ['light', 'dark'].includes(t) ? t : 'system';
  });
  ipcMain.handle('sys:systemFiles', () => {
    sysFilesCache = null; // refresh: hibernation may have been turned off
    return systemFiles();
  });

  /* scanning */
  ipcMain.handle('scan:start', async (e, root, opts = {}) => {
    if (typeof root !== 'string' || !path.isAbsolute(root)) throw new Error('Choose a drive or folder to scan.');
    const ac = startJob('scan');
    return scan(root, {
      maxDepth: Math.min(Math.max(Number(opts.maxDepth) || 4, 1), 6),
      signal: ac.signal,
      onProgress: (p) => send(e, 'scan:progress', p),
      onRow: (r) => send(e, 'scan:row', r),
    });
  });
  ipcMain.handle('scan:cancel', () => jobs.get('scan')?.abort());

  /* cleaners */
  // Overview and Cleanup both ask for estimates at start-up; share one walk per cleaner.
  const estimates = new Map(); // id -> { at, promise }
  const ESTIMATE_TTL = 60 * 1000;
  ipcMain.handle('clean:list', () => cleaners.map(toMeta));
  ipcMain.handle('clean:estimate', async (_e, id, opts = {}) => {
    const c = byId.get(id);
    if (!c) throw new Error(`Unknown cleaner ${id}`);
    const hit = estimates.get(id);
    if (!opts.fresh && hit && Date.now() - hit.at < ESTIMATE_TTL) return hit.promise;
    const promise = Promise.resolve()
      .then(() => c.estimate())
      .catch(() => null);
    estimates.set(id, { at: Date.now(), promise });
    return promise;
  });
  ipcMain.handle('clean:preview', async (_e, ids) => {
    const out = [];
    for (const id of Array.isArray(ids) ? ids : []) {
      const c = byId.get(id);
      if (!c) continue;
      let items = [];
      let error = null;
      try {
        items = await c.preview();
      } catch (err) {
        error = err.message;
      }
      const bytes = items.reduce((n, i) => n + (i.bytes || 0), 0);
      out.push({ ...toMeta(c), items, bytes, error });
    }
    return out;
  });
  ipcMain.handle('clean:run', (e, ids, opts = {}) =>
    exclusive('clean', 'A cleanup is already running.', async () => {
      const ac = startJob('clean');
      const admin = await getAdmin();
      const running = new Set(await system.runningProcesses().catch(() => []));
      const results = [];
      for (const id of Array.isArray(ids) ? ids : []) {
        const c = byId.get(id);
        if (!c) continue;
        const log = (line) => send(e, 'clean:log', { id, line });
        if (ac.signal.aborted) break;
        if (c.admin && !admin) {
          results.push({ id, needsAdmin: true });
          log(`Skipped ${c.name}: needs administrator rights`);
          continue;
        }
        const lockedBy = (c.processes || []).find((p) => running.has(p));
        if (lockedBy) {
          results.push({ id, locked: lockedBy });
          log(`Skipped ${c.name}: ${lockedBy} is running`);
          continue;
        }
        try {
          log(`Starting: ${c.name}`);
          const r = await c.run({ dryRun: !!opts.dryRun, onLog: log, signal: ac.signal });
          results.push({ id, ...r });
          log(r.error ? `Failed: ${r.error}` : 'Done');
        } catch (err) {
          results.push({ id, error: err.message });
          log(`Failed: ${err.message}`);
        }
      }
      estimates.clear();
      sysFilesCache = null;
      if (!opts.dryRun) {
        const done = results.filter((r) => !r.error && !r.needsAdmin && !r.locked);
        const freed = done.reduce((n, r) => n + (r.freed || 0), 0);
        const items = done.reduce((n, r) => n + (r.files || 0), 0);
        if (done.length) {
          const names = done.map((r) => byId.get(r.id).name);
          record({ verb: 'Removed', bytes: freed, items, subject: names.length > 2 ? `${names.slice(0, 2).join(', ')} +${names.length - 2}` : names.join(', '), dest: 'permanent delete', note: 'Caches rebuild on their own; no undo needed.' });
        }
        const skippedBytes = results.reduce((n, r) => n + (r.skippedBytes || 0), 0);
        const skipped = results.reduce((n, r) => n + (r.skipped || 0), 0);
        const locked = results.filter((r) => r.locked).map((r) => r.locked);
        if (skipped || locked.length) {
          record({ verb: 'Skipped', bytes: skippedBytes, items: skipped, subject: [skipped ? `${skipped} in use` : '', locked.length ? `locked by ${[...new Set(locked)].join(', ')}` : ''].filter(Boolean).join('; ') });
        }
      }
      return results;
    }),
  );
  ipcMain.handle('clean:cancel', () => jobs.get('clean')?.abort());

  /* move to another drive */
  const moveMsg = 'Another move is in progress. Wait for it to finish first.';
  ipcMain.handle('move:plan', (_e, src, dest) => mover.planMove(src, dest));
  ipcMain.handle('move:run', (e, src, dest) =>
    exclusive('move', moveMsg, async () => {
      // executeMove re-validates (fresh tree walk) right before touching anything.
      const entry = await mover.executeMove(await mover.planMove(src, dest), {
        onStep: (s) => send(e, 'move:step', s),
        onLog: (l) => send(e, 'move:log', l),
        onProgress: (p) => send(e, 'move:progress', p),
      });
      ledger.add(entry);
      record({ verb: 'Moved', bytes: entry.bytes, items: entry.files, subject: path.basename(entry.src), dest: entry.dest, note: `Old copy kept at ${entry.old}`, undo: { kind: 'move-back', moveId: entry.id } });
      return entry;
    }),
  );
  ipcMain.handle('move:list', () => ledger.load());
  ipcMain.handle('move:finalize', (_e, id) =>
    exclusive('move', moveMsg, async () => {
      const entry = ledger.get(id);
      if (!entry) throw new Error('Unknown move');
      const updated = await mover.finalizeMove(entry);
      ledger.update(updated);
      record({ verb: 'Deleted old copy', bytes: entry.bytes, items: entry.files, subject: path.basename(entry.src), dest: 'permanent delete', note: entry.old });
      return updated;
    }),
  );
  const moveBack = (e, id) =>
    exclusive('move', moveMsg, async () => {
      const entry = ledger.get(id);
      if (!entry) throw new Error('Unknown move');
      send(e, 'move:step', 'Moving back');
      const updated = await mover.undoMove(entry, {
        onLog: (l) => send(e, 'move:log', l),
        onProgress: (p) => send(e, 'move:progress', p),
      });
      ledger.update(updated);
      for (const r of receipts.load()) if (r.undo?.moveId === id && !r.undone) receipts.update({ ...r, undone: new Date().toISOString() });
      record({ verb: 'Moved back', bytes: entry.bytes, items: entry.files, subject: path.basename(entry.src), dest: entry.src });
      return updated;
    });
  ipcMain.handle('move:undo', (e, id) => moveBack(e, id));

  /* duplicates */
  // The main process remembers the last result so it can enforce "keep at least one copy"
  // itself instead of trusting the UI.
  let dupeGroups = []; // array of Set<normalised path>
  ipcMain.handle('dupes:defaults', () => system.defaultUserFolders(app.getPath('home')).filter((p) => fs.existsSync(p)));
  ipcMain.handle('dupes:start', async (e, roots, opts = {}) => {
    const ac = startJob('dupes');
    const r = await findDuplicates(Array.isArray(roots) ? roots : [], {
      minSize: Math.max(Number(opts.minSize) || 1024 * 1024, 1),
      signal: ac.signal,
      onProgress: (p) => send(e, 'dupes:progress', p),
    });
    dupeGroups = r.groups.map((g) => new Set(g.files.map((f) => safety.norm(f.path))));
    return r;
  });
  ipcMain.handle('dupes:cancel', () => jobs.get('dupes')?.abort());
  ipcMain.handle('dupes:trash', async (_e, paths) => {
    const out = [];
    for (const p of Array.isArray(paths) ? paths : []) {
      try {
        if (typeof p !== 'string') throw new Error('Invalid path');
        const key = safety.norm(p);
        const group = dupeGroups.find((g) => g.has(key));
        if (!group) throw new Error('Not part of the last duplicate search');
        if (group.size < 2) throw new Error('This is the last remaining copy; it was kept');
        mover.assertMovable(p); // same system-folder protection as moves
        const size = (await fs.promises.lstat(p).catch(() => null))?.size || 0;
        await shell.trashItem(p);
        group.delete(key);
        out.push({ path: p, ok: true, size });
      } catch (err) {
        out.push({ path: p, ok: false, error: err.message });
      }
    }
    const ok = out.filter((x) => x.ok);
    if (ok.length) {
      record({
        verb: 'Recycled',
        bytes: ok.reduce((n, x) => n + x.size, 0),
        items: ok.length,
        subject: ok.length === 1 ? path.basename(ok[0].path) : `${ok.length} duplicate copies`,
        dest: 'Recycle Bin',
        note: 'Space is freed when the Recycle Bin is emptied.',
        undo: { kind: 'restore', paths: ok.map((x) => x.path) },
      });
    }
    return out;
  });

  /* programs */
  let programCache = [];
  ipcMain.handle('programs:list', async () => (programCache = await system.installedPrograms()));
  ipcMain.handle('programs:uninstall', async (_e, id) => {
    // Look the command up ourselves; never run a string sent by the renderer.
    const p = programCache.find((x) => x.id === id);
    if (!p?.uninstall) throw new Error('No uninstaller registered for this program');
    const child = spawn('cmd.exe', ['/d', '/s', '/c', `"${p.uninstall}"`], {
      detached: true,
      stdio: 'ignore',
      windowsHide: false,
      windowsVerbatimArguments: true,
    });
    child.on('error', () => {});
    child.unref();
    record({ verb: 'Uninstaller started', bytes: p.size, items: 1, subject: p.name, dest: "the program's own uninstaller", note: 'Reclaim does not delete program files directly.' });
    return true;
  });
  ipcMain.handle('programs:openSettings', () => shell.openExternal('ms-settings:appsfeatures'));

  /* ledger */
  ipcMain.handle('ledger:list', () => receipts.load());
  ipcMain.handle('ledger:export', async (_e, format) => {
    const fmt = format === 'csv' ? 'csv' : 'txt';
    const r = await dialog.showSaveDialog(win, {
      title: 'Export ledger',
      defaultPath: path.join(app.getPath('documents'), `reclaim-ledger.${fmt}`),
      filters: [fmt === 'csv' ? { name: 'CSV', extensions: ['csv'] } : { name: 'Text', extensions: ['txt'] }],
    });
    if (r.canceled || !r.filePath) return null;
    await fs.promises.writeFile(r.filePath, exportReceipts(receipts.load(), fmt), 'utf8');
    return r.filePath;
  });
  ipcMain.handle('ledger:undo', async (e, id) => {
    const r = receipts.get(id);
    if (!r?.undo || r.undone) throw new Error('Nothing to undo for this line.');
    if (r.undo.kind === 'move-back') {
      await moveBack(e, r.undo.moveId);
      return { ok: true };
    }
    if (r.undo.kind === 'restore') {
      const res = await recycle.restore(r.undo.paths);
      const ok = res.filter((x) => x.ok);
      const failed = res.filter((x) => !x.ok);
      if (ok.length) {
        // Partly restored: keep the line undoable for the files that are still in the bin.
        receipts.update(failed.length ? { ...r, undo: { kind: 'restore', paths: failed.map((x) => x.path) } } : { ...r, undone: new Date().toISOString() });
        record({ verb: 'Restored', bytes: 0, items: ok.length, subject: ok.length === 1 ? path.basename(ok[0].path) : `${ok.length} files`, dest: 'original folders' });
      }
      return { ok: failed.length === 0, restored: ok.length, failed };
    }
    throw new Error('Unknown undo');
  });

  /* shell helpers */
  ipcMain.handle('shell:reveal', (_e, p) => {
    if (typeof p === 'string' && path.isAbsolute(p)) shell.showItemInFolder(p);
  });
  ipcMain.handle('shell:open', async (_e, p) => {
    // Only folders: openPath on a file would execute it.
    if (typeof p !== 'string' || !path.isAbsolute(p)) throw new Error('Invalid path');
    const st = await fs.promises.stat(p).catch(() => null);
    if (!st?.isDirectory()) throw new Error('Folder not found');
    const err = await shell.openPath(p);
    if (err) throw new Error(err);
  });
  ipcMain.handle('dialog:pickFolder', async (_e, title) => {
    const r = await dialog.showOpenDialog(win, { title: typeof title === 'string' ? title : 'Choose a folder', properties: ['openDirectory', 'createDirectory'] });
    return r.canceled ? null : r.filePaths[0];
  });

  /* elevation */
  ipcMain.handle('admin:relaunch', async () => {
    if (process.platform !== 'win32') return false;
    if (isDev) throw new Error('In development, start your terminal as Administrator and run "npm run dev" again.');
    if (busy.size) throw new Error('Wait for the running cleanup or move to finish first.');
    const exe = process.execPath.replace(/'/g, "''");
    // Let the elevated copy take the single-instance lock; take it back if elevation fails.
    app.releaseSingleInstanceLock();
    // Start-Process throws if the UAC prompt is declined; only quit once the elevated copy started.
    const code = await new Promise((resolve) => {
      const ps = spawn('powershell', ['-NoProfile', '-NonInteractive', '-Command', `try { Start-Process -FilePath '${exe}' -Verb RunAs -ErrorAction Stop; exit 0 } catch { exit 1 }`], {
        windowsHide: true,
      });
      ps.on('error', () => resolve(1));
      ps.on('close', resolve);
    });
    if (code !== 0) {
      app.requestSingleInstanceLock();
      throw new Error('Administrator access was not granted.');
    }
    setTimeout(() => app.quit(), 300);
    return true;
  });
}
