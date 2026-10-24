'use strict';
/**
 * Catalog of cleanups. Two kinds:
 *  - "files":   delete the contents of well-known cache/temp folders (guarded by safety.js)
 *  - "command": run a Windows maintenance command (powercfg, DISM, ...) with fixed argv, no shell
 *
 * Every cleaner has: id, name, description, risk ('safe' | 'low' | 'caution'),
 * admin (needs elevation), closeApps (apps that should be closed first).
 */
const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const { spawn } = require('node:child_process');
const { assertSafeRoot } = require('./safety');
const { deleteContents, safeReaddir, safeLstat, dirSize } = require('./fsx');

const DAY = 24 * 60 * 60 * 1000;

const exists = async (p) => !!(await safeLstat(p));

async function freeBytes(p) {
  try {
    const s = await fsp.statfs(p);
    return Number(s.bavail) * Number(s.bsize);
  } catch {
    return 0;
  }
}

/** Run a program with fixed argv (no shell), streaming lines to onLog. */
function runProgram(cmd, args, { onLog, signal } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args, { windowsHide: true });
    } catch (e) {
      return resolve({ code: -1, error: e.message });
    }
    const emit = (buf) => {
      const text = buf.toString().replace(/\r/g, '\n');
      for (const line of text.split('\n')) if (line.trim()) onLog?.(line.trim());
    };
    child.stdout.on('data', emit);
    child.stderr.on('data', emit);
    child.on('error', (e) => resolve({ code: -1, error: e.message }));
    const onAbort = () => child.kill();
    child.on('close', (code) => {
      signal?.removeEventListener('abort', onAbort);
      resolve({ code });
    });
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/* ---------- target resolvers for file cleaners ---------- */

async function chromiumTargets(userDataDir) {
  const out = [];
  const entries = (await safeReaddir(userDataDir)) || [];
  const profiles = entries.filter((e) => e.isDirectory() && (e.name === 'Default' || /^Profile \d+$/.test(e.name)));
  const sub = ['Cache', 'Code Cache', 'GPUCache', 'DawnCache', 'GrShaderCache', path.join('Service Worker', 'CacheStorage')];
  for (const p of profiles) {
    for (const s of sub) {
      const root = path.join(userDataDir, p.name, s);
      if (await exists(root)) out.push({ root });
    }
  }
  return out;
}

function buildCleaners(env = process.env, deps = {}) {
  const home = env.USERPROFILE || env.HOME || require('node:os').homedir();
  const local = env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
  const sysRoot = env.SystemRoot || 'C:\\Windows';
  const programData = env.ProgramData || 'C:\\ProgramData';
  const sysDrive = env.SystemDrive || 'C:';
  const run = deps.runProgram || runProgram;

  /** @type {Array<object>} */
  const list = [];

  const fileCleaner = (meta, getTargets) =>
    list.push({
      kind: 'files',
      ...meta,
      async resolve() {
        const targets = await getTargets();
        return targets.map((t) => ({ ...t, root: assertSafeRoot(t.root, { env }) }));
      },
      async estimate() {
        let freed = 0;
        for (const t of await this.resolve()) {
          const r = await deleteContents(t.root, { dryRun: true, olderThanMs: t.olderThanMs || 0, match: t.match, shallowOnly: t.shallowOnly });
          freed += r.freed;
        }
        return freed;
      },
      /** Exactly which folders change, and how much each frees (for the Preview sheet). */
      async preview() {
        const out = [];
        for (const t of await this.resolve()) {
          const r = await deleteContents(t.root, { dryRun: true, olderThanMs: t.olderThanMs || 0, match: t.match, shallowOnly: t.shallowOnly });
          if (r.files) out.push({ path: t.root, bytes: r.freed, files: r.files, scope: t.match ? 'matching files only' : t.olderThanMs ? `older than ${Math.round(t.olderThanMs / DAY)} days` : 'contents' });
        }
        return out;
      },
      async run({ dryRun = false, onLog, signal } = {}) {
        const total = { freed: 0, files: 0, skipped: 0, skippedBytes: 0 };
        for (const t of await this.resolve()) {
          if (signal?.aborted) break;
          onLog?.(`${dryRun ? 'Scanning' : 'Cleaning'} ${t.root}`);
          const r = await deleteContents(t.root, { dryRun, olderThanMs: t.olderThanMs || 0, match: t.match, shallowOnly: t.shallowOnly, signal });
          total.freed += r.freed;
          total.files += r.files;
          total.skipped += r.skipped;
          total.skippedBytes += r.skippedBytes;
        }
        if (total.skipped) onLog?.(`${total.skipped} file(s) were in use and were skipped`);
        return total;
      },
    });

  const commandCleaner = (meta, impl) =>
    list.push({
      kind: 'command',
      ...meta,
      estimate: impl.estimate || (async () => null),
      async preview() {
        const bytes = await (impl.estimate || (async () => null)).call(impl).catch(() => null);
        return [{ path: impl.target || meta.name, bytes, files: null, scope: impl.action || 'Windows command' }];
      },
      async run(ctx = {}) {
        if (ctx.dryRun) return { freed: 0, files: 0, skipped: 0, dryRun: true };
        const before = await freeBytes(sysDrive + '\\');
        const r = await impl.run(ctx);
        const after = await freeBytes(sysDrive + '\\');
        return { freed: Math.max(0, after - before), files: 0, skipped: 0, ...r };
      },
    });

  /* ----- safe: temp and caches ----- */

  fileCleaner(
    {
      id: 'user-temp',
      name: 'User temp files',
      description: 'Leftovers from installers and apps in your Temp folder. Files modified in the last 2 days are kept so running apps are not disturbed.',
      risk: 'safe',
      admin: false,
      closeApps: [],
      group: 'Windows',
    },
    async () => [{ root: path.join(local, 'Temp'), olderThanMs: 2 * DAY }],
  );

  fileCleaner(
    {
      id: 'user-temp-all',
      name: 'User temp files (including recent)',
      description: 'Everything in your Temp folder, regardless of age. Best run right after a restart, before opening other apps. Files in use are skipped automatically.',
      risk: 'low',
      admin: false,
      closeApps: ['Browsers', 'VS Code', 'Docker'],
      group: 'Windows',
    },
    async () => [{ root: path.join(local, 'Temp'), olderThanMs: 0 }],
  );

  fileCleaner(
    {
      id: 'windows-temp',
      name: 'Windows temp files',
      description: 'System temp folder (C:\\Windows\\Temp), older than 2 days.',
      risk: 'safe',
      admin: true,
      closeApps: [],
      group: 'Windows',
    },
    async () => [{ root: path.join(sysRoot, 'Temp'), olderThanMs: 2 * DAY }],
  );

  fileCleaner(
    {
      id: 'crash-dumps',
      name: 'Crash dumps and error reports',
      description: 'Memory dumps and Windows Error Reporting files left by crashed apps.',
      risk: 'safe',
      admin: true,
      closeApps: [],
      group: 'Windows',
    },
    async () => [
      { root: path.join(local, 'CrashDumps') },
      { root: path.join(sysRoot, 'Minidump') },
      { root: path.join(sysRoot, 'LiveKernelReports'), match: (n) => /\.dmp$/i.test(n) },
      { root: path.join(programData, 'Microsoft', 'Windows', 'WER') },
    ],
  );

  fileCleaner(
    {
      id: 'shader-cache',
      name: 'GPU shader caches',
      description: 'DirectX, NVIDIA and AMD shader caches. Games rebuild them the first time they run.',
      risk: 'safe',
      admin: false,
      closeApps: ['Games'],
      group: 'Windows',
    },
    async () => [
      { root: path.join(local, 'D3DSCache') },
      { root: path.join(local, 'NVIDIA', 'DXCache') },
      { root: path.join(local, 'NVIDIA', 'GLCache') },
      { root: path.join(local, 'AMD', 'DxCache') },
    ],
  );

  fileCleaner(
    {
      id: 'chrome-cache',
      name: 'Chrome cache',
      description: 'Cached web files for every Chrome profile. Logins, history, bookmarks and extensions are untouched.',
      risk: 'safe',
      admin: false,
      closeApps: ['Chrome'],
      group: 'Browsers',
    },
    () => chromiumTargets(path.join(local, 'Google', 'Chrome', 'User Data')),
  );

  fileCleaner(
    {
      id: 'edge-cache',
      name: 'Edge cache',
      description: 'Cached web files for every Edge profile. Logins, history and bookmarks are untouched.',
      risk: 'safe',
      admin: false,
      closeApps: ['Edge'],
      group: 'Browsers',
    },
    () => chromiumTargets(path.join(local, 'Microsoft', 'Edge', 'User Data')),
  );

  fileCleaner(
    {
      id: 'brave-cache',
      name: 'Brave cache',
      description: 'Cached web files for every Brave profile.',
      risk: 'safe',
      admin: false,
      closeApps: ['Brave'],
      group: 'Browsers',
    },
    () => chromiumTargets(path.join(local, 'BraveSoftware', 'Brave-Browser', 'User Data')),
  );

  /* ----- developer caches ----- */

  fileCleaner(
    {
      id: 'npm-cache',
      name: 'npm cache',
      description: 'Downloaded packages npm keeps for offline installs. Rebuilt automatically.',
      risk: 'safe',
      admin: false,
      closeApps: [],
      group: 'Developer',
    },
    async () => [{ root: path.join(local, 'npm-cache', '_cacache') }],
  );

  fileCleaner(
    {
      id: 'pip-cache',
      name: 'pip cache',
      description: 'Python wheel and HTTP cache. Rebuilt automatically.',
      risk: 'safe',
      admin: false,
      closeApps: [],
      group: 'Developer',
    },
    async () => [{ root: path.join(local, 'pip', 'cache') }],
  );

  fileCleaner(
    {
      id: 'yarn-nuget-cache',
      name: 'Yarn and NuGet caches',
      description: 'Package download caches for Yarn and NuGet. Rebuilt automatically.',
      risk: 'safe',
      admin: false,
      closeApps: [],
      group: 'Developer',
    },
    async () => [
      { root: path.join(local, 'Yarn', 'Cache') },
      { root: path.join(local, 'NuGet', 'v3-cache') },
    ],
  );

  fileCleaner(
    {
      id: 'roblox-cache',
      name: 'Roblox cache',
      description: 'Roblox asset cache and downloads. Installed Player/Studio versions and your places are kept.',
      risk: 'low',
      admin: false,
      closeApps: ['Roblox Player', 'Roblox Studio'],
      group: 'Games',
    },
    async () => [
      { root: path.join(local, 'Roblox', 'rbx-storage') },
      { root: path.join(local, 'Roblox', 'Downloads') },
      { root: path.join(local, 'Roblox'), match: (n) => /^rbx-storage\.(db|db-shm|db-wal|id)$/i.test(n), shallowOnly: true },
    ],
  );

  /* ----- Windows update caches ----- */

  list.push({
    kind: 'files',
    id: 'windows-update-cache',
    name: 'Windows Update download cache',
    description: 'Already-installed update downloads in SoftwareDistribution\\Download. Windows Update services are paused while this runs, then restarted.',
    risk: 'low',
    admin: true,
    closeApps: [],
    group: 'Windows',
    async resolve() {
      return [{ root: assertSafeRoot(path.join(sysRoot, 'SoftwareDistribution', 'Download'), { env }) }];
    },
    async estimate() {
      const [t] = await this.resolve();
      return (await deleteContents(t.root, { dryRun: true })).freed;
    },
    async preview() {
      const [t] = await this.resolve();
      const r = await deleteContents(t.root, { dryRun: true });
      return r.files ? [{ path: t.root, bytes: r.freed, files: r.files, scope: 'contents; services paused' }] : [];
    },
    async run({ dryRun = false, onLog, signal } = {}) {
      const [t] = await this.resolve();
      if (dryRun) return deleteContents(t.root, { dryRun: true });
      onLog?.('Stopping Windows Update services');
      await run('net', ['stop', 'wuauserv'], { onLog });
      await run('net', ['stop', 'bits'], { onLog });
      try {
        onLog?.(`Cleaning ${t.root}`);
        return await deleteContents(t.root, { signal });
      } finally {
        onLog?.('Restarting Windows Update services');
        await run('net', ['start', 'bits'], { onLog });
        await run('net', ['start', 'wuauserv'], { onLog });
      }
    },
  });

  /* ----- command cleaners ----- */

  commandCleaner(
    {
      id: 'recycle-bin',
      name: 'Empty Recycle Bin',
      description: 'Permanently removes everything currently in the Recycle Bin.',
      risk: 'low',
      admin: false,
      closeApps: [],
      group: 'Windows',
      confirmText: 'This permanently deletes everything in the Recycle Bin.',
    },
    {
      target: 'Recycle Bin (all drives)',
      action: 'Clear-RecycleBin',
      async estimate() {
        let out = '';
        const r = await run(
          'powershell',
          ['-NoProfile', '-NonInteractive', '-Command', '(New-Object -ComObject Shell.Application).NameSpace(10).Items() | ForEach-Object { $_.Size } | Measure-Object -Sum | Select-Object -ExpandProperty Sum'],
          { onLog: (l) => (out += l) },
        );
        const n = Number(out);
        return r.code === 0 && Number.isFinite(n) ? n : null;
      },
      async run({ onLog }) {
        // The bin spans every drive, so free-space deltas on C: undercount; report its measured size.
        const before = await this.estimate().catch(() => null);
        const r = await run('powershell', ['-NoProfile', '-NonInteractive', '-Command', 'Clear-RecycleBin -Force -ErrorAction SilentlyContinue'], { onLog });
        if (r.code !== 0) return { error: r.error || `Exit code ${r.code}` };
        return before != null ? { freed: before } : {};
      },
    },
  );

  commandCleaner(
    {
      id: 'hibernate-off',
      name: 'Turn off hibernation',
      description: 'Deletes hiberfil.sys (about 40-75% of your RAM). You lose the Hibernate option; Sleep and Shut down still work. Reversible with "powercfg -h on".',
      risk: 'low',
      admin: true,
      closeApps: [],
      group: 'Windows',
      confirmText: 'Hibernate will be disabled. Run "powercfg -h on" in an admin terminal to bring it back.',
    },
    {
      target: path.join(sysDrive + '\\', 'hiberfil.sys'),
      action: 'powercfg -h off',
      async estimate() {
        const f = path.join(sysDrive + '\\', 'hiberfil.sys');
        return deps.hiberfilSize ? deps.hiberfilSize(f) : null;
      },
      async run({ onLog }) {
        const r = await run('powercfg', ['-h', 'off'], { onLog });
        return r.code === 0 ? {} : { error: r.error || `powercfg exited with ${r.code}` };
      },
    },
  );

  commandCleaner(
    {
      id: 'component-cleanup',
      name: 'Clean up Windows component store',
      description: 'Runs DISM StartComponentCleanup to remove superseded Windows update files from WinSxS. Takes 10-20 minutes. Safe, and installed updates stay uninstallable.',
      risk: 'safe',
      admin: true,
      closeApps: [],
      group: 'Windows',
      slow: true,
    },
    {
      target: path.join(sysRoot, 'WinSxS'),
      action: 'DISM /StartComponentCleanup',
      async run({ onLog }) {
        // Not cancellable on purpose: killing DISM mid-cleanup can leave the component store inconsistent.
        const r = await run('Dism.exe', ['/Online', '/Cleanup-Image', '/StartComponentCleanup'], { onLog });
        return r.code === 0 ? {} : { error: r.error || `DISM exited with ${r.code}` };
      },
    },
  );

  commandCleaner(
    {
      id: 'component-resetbase',
      name: 'Component store deep clean (ResetBase)',
      description: 'DISM StartComponentCleanup /ResetBase. Frees more space but makes currently installed Windows updates permanent: you will not be able to uninstall them afterwards.',
      risk: 'caution',
      admin: true,
      closeApps: [],
      group: 'Windows',
      slow: true,
      confirmText: 'Currently installed Windows updates will no longer be uninstallable. New updates are unaffected.',
    },
    {
      target: path.join(sysRoot, 'WinSxS'),
      action: 'DISM /StartComponentCleanup /ResetBase',
      async run({ onLog }) {
        // Not cancellable on purpose: killing DISM mid-cleanup can leave the component store inconsistent.
        const r = await run('Dism.exe', ['/Online', '/Cleanup-Image', '/StartComponentCleanup', '/ResetBase'], { onLog });
        return r.code === 0 ? {} : { error: r.error || `DISM exited with ${r.code}` };
      },
    },
  );

  for (const c of list) Object.assign(c, MARGIN[c.id] || {});
  return list;
}

/**
 * Margin notes and safety grades (see DESIGN.md §5).
 *  grade A = regenerates (pre-selected), B = costs a download/rebuild, C = only you can judge.
 *  section groups rows; from/back/breaks/undo fill the consequence column; dest says where bytes go;
 *  processes: if any is running, the item is shown as locked and skipped.
 */
const PERMANENT = 'Permanent delete';
const MARGIN = {
  'user-temp': { grade: 'A', section: 'Caches', from: 'Installers and apps', back: 'Apps recreate what they need.', breaks: 'Nothing. Files from the last 2 days are kept.', undo: 'None needed.', dest: PERMANENT },
  'windows-temp': { grade: 'A', section: 'Caches', from: 'Windows services and installers', back: 'Recreated as needed.', breaks: 'Nothing. Files from the last 2 days are kept.', undo: 'None needed.', dest: PERMANENT },
  'crash-dumps': { grade: 'A', section: 'Caches', from: 'Windows Error Reporting', back: 'Only if something crashes again.', breaks: 'Crash reports you have not sent yet are gone.', undo: 'None.', dest: PERMANENT },
  'chrome-cache': { grade: 'A', section: 'Caches', from: 'Google Chrome', back: 'Rebuilds as you browse.', breaks: 'Pages load from the network once. Signed-in sessions remain.', undo: 'None needed.', dest: PERMANENT, processes: ['chrome.exe'] },
  'edge-cache': { grade: 'A', section: 'Caches', from: 'Microsoft Edge', back: 'Rebuilds as you browse.', breaks: 'Pages load from the network once. Signed-in sessions remain.', undo: 'None needed.', dest: PERMANENT, processes: ['msedge.exe'] },
  'brave-cache': { grade: 'A', section: 'Caches', from: 'Brave', back: 'Rebuilds as you browse.', breaks: 'Pages load from the network once. Signed-in sessions remain.', undo: 'None needed.', dest: PERMANENT, processes: ['brave.exe'] },
  'windows-update-cache': { grade: 'A', section: 'Caches', from: 'Windows Update', back: 'Only for future updates.', breaks: 'Nothing once updates have finished installing.', undo: 'None needed.', dest: PERMANENT },
  'component-cleanup': { grade: 'A', section: 'Caches', from: 'Windows Update (WinSxS)', back: 'No. Superseded versions only.', breaks: 'Nothing. Installed updates stay uninstallable.', undo: 'None needed.', dest: 'Removed by DISM' },
  'shader-cache': { grade: 'B', section: 'Games', from: 'DirectX, NVIDIA and AMD drivers', back: 'Rebuilt when each game first runs.', breaks: 'The first launch of each game stutters while shaders compile.', undo: 'None. Rebuilds itself.', dest: PERMANENT },
  'roblox-cache': { grade: 'B', section: 'Games', from: 'Roblox Player and Studio', back: 'Assets re-download as you play.', breaks: 'Slower first load of each experience.', undo: 'None. Re-downloads.', dest: PERMANENT, processes: ['robloxplayerbeta.exe', 'robloxstudiobeta.exe'] },
  'npm-cache': { grade: 'B', section: 'Developer', from: 'npm', back: 'Packages re-download on the next install.', breaks: 'Offline installs until the cache refills.', undo: 'None. Re-downloads.', dest: PERMANENT },
  'pip-cache': { grade: 'B', section: 'Developer', from: 'pip', back: 'Wheels re-download on the next install.', breaks: 'Offline installs until the cache refills.', undo: 'None. Re-downloads.', dest: PERMANENT },
  'yarn-nuget-cache': { grade: 'B', section: 'Developer', from: 'Yarn and NuGet', back: 'Packages re-download on the next restore.', breaks: 'Offline restores until the cache refills.', undo: 'None. Re-downloads.', dest: PERMANENT },
  'user-temp-all': { grade: 'B', section: 'Windows', from: 'Installers and apps', back: 'Apps recreate what they need.', breaks: 'An app open right now can lose its scratch files. Best right after a restart.', undo: 'None.', dest: PERMANENT },
  'hibernate-off': { grade: 'B', section: 'Windows', from: 'Windows power settings', back: 'Only if you turn hibernation on again.', breaks: 'Hibernate and Fast Startup stop working. Sleep and Shut down still work.', undo: 'Run "powercfg -h on" as administrator.', dest: 'Deleted by powercfg' },
  'recycle-bin': { grade: 'C', section: 'Windows', from: 'You, when you deleted files', back: 'No.', breaks: 'Files in the Recycle Bin can no longer be restored.', undo: 'None. This is permanent.', dest: PERMANENT },
  'component-resetbase': { grade: 'C', section: 'Windows', from: 'Windows Update (WinSxS)', back: 'No.', breaks: 'Installed Windows updates can no longer be uninstalled.', undo: 'None.', dest: 'Removed by DISM' },
};

/** Strip functions so a cleaner can be sent over IPC. */
const toMeta = (c) => ({
  id: c.id,
  name: c.name,
  description: c.description,
  risk: c.risk,
  admin: c.admin,
  closeApps: c.closeApps,
  group: c.group,
  kind: c.kind,
  slow: !!c.slow,
  cancellable: c.kind !== 'command' || !c.slow,
  confirmText: c.confirmText || null,
  grade: c.grade || 'B',
  section: c.section || c.group,
  from: c.from || '',
  back: c.back || '',
  breaks: c.breaks || '',
  undo: c.undo || '',
  dest: c.dest || PERMANENT,
  processes: c.processes || [],
});

module.exports = { buildCleaners, toMeta, runProgram, freeBytes, DAY };
