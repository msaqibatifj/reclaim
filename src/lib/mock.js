/* Demo backend used when the UI runs outside Electron. All data here is synthetic. */
const GB = 1024 ** 3;
const MB = 1024 ** 2;

function node(name, path, size, children = []) {
  const kids = children.sort((a, b) => b.size - a.size);
  const total = kids.length ? kids.reduce((n, k) => n + k.size, 0) + size : size;
  return { name, path, size: total, files: Math.round(total / (180 * 1024)), dir: true, children: kids };
}
const leaf = (name, path, size) => ({ name, path, size, files: Math.max(1, Math.round(size / (300 * 1024))), dir: true, children: [], truncated: true });

function demoTree() {
  const U = 'C:\\Users\\demo';
  const L = `${U}\\AppData\\Local`;
  return node('C:\\', 'C:\\', 0, [
    node('Windows', 'C:\\Windows', 0, [
      leaf('WinSxS', 'C:\\Windows\\WinSxS', 12.8 * GB),
      leaf('System32', 'C:\\Windows\\System32', 12.1 * GB),
      leaf('SystemApps', 'C:\\Windows\\SystemApps', 1.4 * GB),
      leaf('SysWOW64', 'C:\\Windows\\SysWOW64', 1.1 * GB),
      leaf('assembly', 'C:\\Windows\\assembly', 0.8 * GB),
      leaf('SoftwareDistribution', 'C:\\Windows\\SoftwareDistribution', 2.3 * GB),
    ]),
    node('Users', 'C:\\Users', 0, [
      node('demo', U, 0, [
        node('AppData', `${U}\\AppData`, 0, [
          node('Local', L, 0, [
            leaf('Temp', `${L}\\Temp`, 9.7 * GB),
            leaf('Roblox', `${L}\\Roblox`, 6.0 * GB),
            leaf('Google', `${L}\\Google`, 5.3 * GB),
            leaf('Python', `${L}\\Python`, 1.8 * GB),
            leaf('npm-cache', `${L}\\npm-cache`, 1.7 * GB),
            leaf('Programs', `${L}\\Programs`, 1.6 * GB),
            leaf('NVIDIA', `${L}\\NVIDIA`, 1.1 * GB),
            leaf('pip', `${L}\\pip`, 0.7 * GB),
            leaf('Discord', `${L}\\Discord`, 0.6 * GB),
          ]),
          leaf('Roaming', `${U}\\AppData\\Roaming`, 3.2 * GB),
        ]),
        leaf('Videos', `${U}\\Videos`, 1.3 * GB),
        leaf('Desktop', `${U}\\Desktop`, 0.9 * GB),
        leaf('Downloads', `${U}\\Downloads`, 0.4 * GB),
      ]),
    ]),
    node('Program Files', 'C:\\Program Files', 0, [
      leaf('Microsoft Office', 'C:\\Program Files\\Microsoft Office', 3.4 * GB),
      leaf('Google', 'C:\\Program Files\\Google', 1.2 * GB),
      leaf('WindowsApps', 'C:\\Program Files\\WindowsApps', 2.1 * GB),
      leaf('WSL', 'C:\\Program Files\\WSL', 0.6 * GB),
    ]),
    { name: 'pagefile.sys', path: 'C:\\pagefile.sys', size: 6.5 * GB, files: 1, dir: false, children: [] },
    { name: 'hiberfil.sys', path: 'C:\\hiberfil.sys', size: 4.7 * GB, files: 1, dir: false, children: [] },
    leaf('ProgramData', 'C:\\ProgramData', 1.6 * GB),
    leaf('Recovery', 'C:\\Recovery', 1.2 * GB),
    leaf('Program Files (x86)', 'C:\\Program Files (x86)', 0.7 * GB),
    leaf('Riot Games', 'C:\\Riot Games', 0.7 * GB),
  ]);
}

function findNode(tree, path) {
  if (tree.path.toLowerCase() === path.toLowerCase()) return tree;
  for (const c of tree.children || []) {
    const f = findNode(c, path);
    if (f) return f;
  }
  return null;
}

const P = 'Permanent delete';
const L = 'C:\\Users\\demo\\AppData\\Local';
// id, name, description, grade, section, admin, est, slow, kind, from, back, breaks, undo, dest, processes, paths
const CLEANERS = [
  ['user-temp', 'User temp files', 'Leftovers from installers and apps in your Temp folder. Files from the last 2 days are kept.', 'A', 'Caches', false, 6.1 * GB, false, 'files', 'Installers and apps', 'Apps recreate what they need.', 'Nothing. Files from the last 2 days are kept.', 'None needed.', P, [], [`${L}\\Temp`]],
  ['windows-temp', 'Windows temp files', 'System temp folder (C:\\Windows\\Temp), older than 2 days.', 'A', 'Caches', true, 0.4 * GB, false, 'files', 'Windows services and installers', 'Recreated as needed.', 'Nothing. Files from the last 2 days are kept.', 'None needed.', P, [], ['C:\\Windows\\Temp']],
  ['crash-dumps', 'Crash dumps and error reports', 'Memory dumps and Windows Error Reporting files left by crashed apps.', 'A', 'Caches', true, 0.08 * GB, false, 'files', 'Windows Error Reporting', 'Only if something crashes again.', 'Crash reports you have not sent yet are gone.', 'None.', P, [], [`${L}\\CrashDumps`, 'C:\\ProgramData\\Microsoft\\Windows\\WER']],
  ['chrome-cache', 'Chrome cache', 'Cached web files for every Chrome profile. Logins, history, bookmarks and extensions are untouched.', 'A', 'Caches', false, 4.1 * GB, false, 'files', 'Google Chrome', 'Rebuilds as you browse.', 'Pages load from the network once. Signed-in sessions remain.', 'None needed.', P, ['chrome.exe'], [`${L}\\Google\\Chrome\\User Data\\Default\\Cache`, `${L}\\Google\\Chrome\\User Data\\Default\\Code Cache`]],
  ['edge-cache', 'Edge cache', 'Cached web files for every Edge profile. Logins, history and bookmarks are untouched.', 'A', 'Caches', false, 0.6 * GB, false, 'files', 'Microsoft Edge', 'Rebuilds as you browse.', 'Pages load from the network once. Signed-in sessions remain.', 'None needed.', P, ['msedge.exe'], [`${L}\\Microsoft\\Edge\\User Data\\Default\\Cache`]],
  ['brave-cache', 'Brave cache', 'Cached web files for every Brave profile.', 'A', 'Caches', false, 0, false, 'files', 'Brave', 'Rebuilds as you browse.', 'Pages load from the network once.', 'None needed.', P, ['brave.exe'], []],
  ['windows-update-cache', 'Windows Update download cache', 'Already-installed update downloads in SoftwareDistribution\\Download. Windows Update services are paused while this runs.', 'A', 'Caches', true, 3.8 * GB, false, 'files', 'Windows Update', 'Only for future updates.', 'Nothing once updates have finished installing.', 'None needed.', P, [], ['C:\\Windows\\SoftwareDistribution\\Download']],
  ['component-cleanup', 'Clean up Windows component store', 'Runs DISM StartComponentCleanup to remove superseded update files from WinSxS. Takes 10–20 minutes.', 'A', 'Caches', true, null, true, 'command', 'Windows Update (WinSxS)', 'No. Superseded versions only.', 'Nothing. Installed updates stay uninstallable.', 'None needed.', 'Removed by DISM', [], ['C:\\Windows\\WinSxS']],
  ['npm-cache', 'npm cache', 'Downloaded packages npm keeps for offline installs.', 'B', 'Developer', false, 2.2 * GB, false, 'files', 'npm', 'Packages re-download on the next install.', 'Offline installs until the cache refills.', 'None. Re-downloads.', P, [], [`${L}\\npm-cache\\_cacache`]],
  ['pip-cache', 'pip cache', 'Python wheel and HTTP cache.', 'B', 'Developer', false, 0.7 * GB, false, 'files', 'pip', 'Wheels re-download on the next install.', 'Offline installs until the cache refills.', 'None. Re-downloads.', P, [], [`${L}\\pip\\cache`]],
  ['yarn-nuget-cache', 'Yarn and NuGet caches', 'Package download caches for Yarn and NuGet.', 'B', 'Developer', false, 0.3 * GB, false, 'files', 'Yarn and NuGet', 'Packages re-download on the next restore.', 'Offline restores until the cache refills.', 'None. Re-downloads.', P, [], [`${L}\\Yarn\\Cache`]],
  ['shader-cache', 'GPU shader caches', 'DirectX, NVIDIA and AMD shader caches.', 'B', 'Games', false, 0.9 * GB, false, 'files', 'DirectX, NVIDIA and AMD drivers', 'Rebuilt when each game first runs.', 'The first launch of each game stutters while shaders compile.', 'None. Rebuilds itself.', P, [], [`${L}\\D3DSCache`, `${L}\\NVIDIA\\DXCache`]],
  ['roblox-cache', 'Roblox cache', 'Roblox asset cache and downloads. Installed versions and your places are kept.', 'B', 'Games', false, 3.5 * GB, false, 'files', 'Roblox Player and Studio', 'Assets re-download as you play.', 'Slower first load of each experience.', 'None. Re-downloads.', P, ['robloxplayerbeta.exe', 'robloxstudiobeta.exe'], [`${L}\\Roblox\\rbx-storage`, `${L}\\Roblox\\Downloads`]],
  ['user-temp-all', 'User temp files (including recent)', 'Everything in your Temp folder, regardless of age. Best right after a restart.', 'B', 'Windows', false, 9.7 * GB, false, 'files', 'Installers and apps', 'Apps recreate what they need.', 'An app open right now can lose its scratch files.', 'None.', P, [], [`${L}\\Temp`]],
  ['hibernate-off', 'Turn off hibernation', 'Deletes hiberfil.sys. You lose Hibernate; Sleep and Shut down still work.', 'B', 'Windows', true, 4.7 * GB, false, 'command', 'Windows power settings', 'Only if you turn hibernation on again.', 'Hibernate and Fast Startup stop working.', 'Run "powercfg -h on" as administrator.', 'Deleted by powercfg', [], ['C:\\hiberfil.sys']],
  ['recycle-bin', 'Empty Recycle Bin', 'Permanently removes everything currently in the Recycle Bin.', 'C', 'Windows', false, 0.3 * GB, false, 'command', 'You, when you deleted files', 'No.', 'Files in the Recycle Bin can no longer be restored.', 'None. This is permanent.', P, [], ['Recycle Bin (all drives)']],
  ['component-resetbase', 'Component store deep clean (ResetBase)', 'DISM /ResetBase. Frees more, but installed Windows updates become permanent.', 'C', 'Windows', true, null, true, 'command', 'Windows Update (WinSxS)', 'No.', 'Installed Windows updates can no longer be uninstalled.', 'None.', 'Removed by DISM', [], ['C:\\Windows\\WinSxS']],
].map(([id, name, description, grade, section, admin, est, slow, kind, from, back, breaks, undo, dest, processes, paths]) => ({
  id, name, description, grade, section, group: section, admin, est, slow, kind, from, back, breaks, undo, dest, processes, paths,
  risk: grade === 'A' ? 'safe' : grade === 'B' ? 'low' : 'caution', closeApps: [], cancellable: !slow, confirmText: null,
}));
const meta = ({ est, paths, ...m }) => m;

const PROGRAMS = [
  ['Microsoft Office Professional Plus', 'Microsoft Corporation', 3.4 * GB, '20250114'],
  ['Docker Desktop', 'Docker Inc.', 2.9 * GB, '20260302'],
  ['Roblox Studio', 'Roblox Corporation', 2.1 * GB, '20260911'],
  ['NVIDIA Graphics Driver 581.42', 'NVIDIA Corporation', 1.4 * GB, '20260920'],
  ['Google Chrome', 'Google LLC', 1.2 * GB, '20240830'],
  ['Python 3.12.4 (64-bit)', 'Python Software Foundation', 0.9 * GB, '20250606'],
  ['Microsoft Visual Studio Code (User)', 'Microsoft Corporation', 0.6 * GB, '20260817'],
  ['Discord', 'Discord Inc.', 0.4 * GB, '20251103'],
  ['Stremio', 'Smart Code', 0.3 * GB, '20260110'],
  ['HWiNFO64 Version 8.30', 'Martin Malik - REALiX', 0.02 * GB, '20260428'],
  ['Microsoft Visual C++ 2015-2022 Redistributable (x64)', 'Microsoft Corporation', 0, '20240212'],
].map(([name, publisher, size, installDate], i) => ({ id: `p${i}`, name, publisher, size, installDate, version: '', location: i < 3 ? `C:\\Program Files\\${name.split(' ')[0]}` : '', uninstall: 'x' }));

/** Deterministic 64-hex string so demo groups have stable, realistic hash prefixes. */
function fakeHash(str) {
  let out = '';
  let h = 2166136261;
  for (let round = 0; round < 8; round++) {
    for (let i = 0; i < str.length; i++) h = Math.imul(h ^ (str.charCodeAt(i) + round), 16777619) >>> 0;
    out += h.toString(16).padStart(8, '0');
  }
  return out;
}

export function createMock() {
  const listeners = new Map();
  const emit = (ch, p) => (listeners.get(ch) || []).forEach((cb) => cb(p));
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const tree = demoTree();
  let moves = [];
  let receipts = [];
  const sizes = Object.fromEntries(CLEANERS.map((c) => [c.id, c.est]));
  const record = (r) => {
    const x = { id: `r${Date.now()}${Math.random().toString(16).slice(2, 6)}`, at: new Date().toISOString(), bytes: 0, items: 0, subject: '', dest: '', ...r };
    receipts = [x, ...receipts];
    return x;
  };
  let free = 17.4 * GB;
  const dupeSizes = new Map();

  const handlers = {
    'sys:info': async () => ({
      platform: 'win32',
      admin: false,
      drives: [
        { letter: 'C:', label: 'Local Disk', size: 237 * GB, free, type: 'Fixed', system: true },
        { letter: 'D:', label: 'Data', size: 931 * GB, free: 512 * GB, type: 'Fixed', system: false },
      ],
      home: 'C:\\Users\\demo',
      systemDrive: 'C:',
      version: '0.1.0-demo',
    }),
    'sys:systemFiles': async () => [
      { name: 'hiberfil.sys', path: 'C:\\hiberfil.sys', size: 4.7 * GB },
      { name: 'pagefile.sys', path: 'C:\\pagefile.sys', size: 6.5 * GB },
      { name: 'swapfile.sys', path: 'C:\\swapfile.sys', size: 0.27 * GB },
    ],
    'sys:processes': async () => ['explorer.exe', 'chrome.exe', 'code.exe'],
    'sys:setTheme': async () => {},
    'scan:start': async (root) => {
      const target = findNode(tree, root) || tree;
      const kids = [...(target.children || [])].filter((c) => c.dir).sort(() => Math.random() - 0.5);
      for (let i = 1; i <= 12; i++) {
        await wait(110);
        emit('scan:progress', { files: i * 41231, bytes: (target.size * i) / 12, current: `${kids[i % Math.max(1, kids.length)]?.path || target.path}\\…` });
        const k = kids[i - 1];
        if (k) emit('scan:row', { name: k.name, path: k.path, size: k.size, files: k.files });
      }
      return {
        root: target.path,
        tree: target,
        topFiles: [
          { path: 'C:\\pagefile.sys', name: 'pagefile.sys', size: 6.5 * GB, mtime: Date.now() - 3600e3 },
          { path: 'C:\\hiberfil.sys', name: 'hiberfil.sys', size: 4.7 * GB, mtime: Date.now() - 86400e3 },
          { path: 'C:\\Users\\demo\\Videos\\Screen Recordings\\Screen Recording 2026-10-02.mp4', name: 'Screen Recording 2026-10-02.mp4', size: 745 * MB },
          { path: 'C:\\Users\\demo\\AppData\\Local\\Roblox\\rbx-storage.db', name: 'rbx-storage.db', size: 131 * MB },
          { path: 'C:\\Users\\demo\\Videos\\Screen Recordings\\Screen Recording 2026-10-17.mp4', name: 'Screen Recording 2026-10-17.mp4', size: 109 * MB },
          { path: 'C:\\Windows\\System32\\MRT.exe', name: 'MRT.exe', size: 98 * MB },
        ],
        categories: { Apps: 21 * GB, Other: 38 * GB, 'Disk images': 2.1 * GB, Video: 1.4 * GB, Code: 4.2 * GB, Logs: 9.9 * GB, Images: 1.1 * GB, Archives: 1.6 * GB, Documents: 0.6 * GB },
        stats: { files: 494772, dirs: 112044, bytes: target.size, errors: 213, hardlinks: 61840, ms: 1420 },
        aborted: false,
      };
    },
    'scan:cancel': async () => {},
    'clean:list': async () => CLEANERS.map(meta),
    'clean:estimate': async (id) => {
      await wait(150 + Math.random() * 500);
      return sizes[id] ?? null;
    },
    'clean:preview': async (ids) => {
      await wait(400);
      return ids.map((id) => {
        const c = CLEANERS.find((x) => x.id === id);
        const total = sizes[id] || 0;
        const items = c.kind === 'command'
          ? [{ path: c.paths[0], bytes: total || null, files: null, scope: c.id === 'hibernate-off' ? 'powercfg -h off' : 'Windows command' }]
          : c.paths.map((p, i) => ({ path: p, bytes: i === 0 ? total * (c.paths.length > 1 ? 0.72 : 1) : (total * 0.28) / (c.paths.length - 1), files: Math.round(total / 220000), scope: c.id === 'user-temp' ? 'older than 2 days' : 'contents' }));
        return { ...meta(c), items, bytes: total };
      });
    },
    'clean:run': async (ids) => {
      const out = [];
      for (const id of ids) {
        const c = CLEANERS.find((x) => x.id === id);
        emit('clean:log', { id, line: `Starting: ${c.name}` });
        for (const p of c.paths) {
          await wait(260);
          emit('clean:log', { id, line: `Cleaning ${p}` });
        }
        if (c.admin) {
          emit('clean:log', { id, line: `Skipped ${c.name}: needs administrator rights` });
          out.push({ id, needsAdmin: true });
          continue;
        }
        const skipped = id === 'user-temp' ? 4 : 0;
        const skippedBytes = skipped ? 0.3 * GB : 0;
        const freed = Math.max(0, (sizes[id] || 0) - skippedBytes);
        free += freed;
        sizes[id] = skippedBytes;
        if (skipped) emit('clean:log', { id, line: `${skipped} file(s) were in use and were skipped` });
        emit('clean:log', { id, line: 'Done' });
        out.push({ id, freed, files: Math.round(freed / 220000), skipped, skippedBytes });
      }
      const done = out.filter((r) => !r.needsAdmin);
      if (done.length) {
        const names = done.map((r) => CLEANERS.find((x) => x.id === r.id).name);
        record({ verb: 'Removed', bytes: done.reduce((n, r) => n + r.freed, 0), items: done.reduce((n, r) => n + r.files, 0), subject: names.length > 2 ? `${names.slice(0, 2).join(', ')} +${names.length - 2}` : names.join(', '), dest: 'permanent delete', note: 'Caches rebuild on their own; no undo needed.' });
      }
      const sk = out.filter((r) => r.skipped);
      if (sk.length) record({ verb: 'Skipped', bytes: sk.reduce((n, r) => n + r.skippedBytes, 0), items: sk.reduce((n, r) => n + r.skipped, 0), subject: `${sk.reduce((n, r) => n + r.skipped, 0)} in use` });
      return out;
    },
    'clean:cancel': async () => {},
    'ledger:list': async () => receipts,
    'ledger:export': async () => 'C:\\Users\\demo\\Documents\\reclaim-ledger.txt',
    'ledger:undo': async (id) => {
      const r = receipts.find((x) => x.id === id);
      if (!r?.undo) throw new Error('Nothing to undo for this line.');
      await wait(500);
      if (r.undo.kind === 'move-back') {
        moves = moves.map((m) => (m.id === r.undo.moveId ? { ...m, status: 'undone' } : m));
        receipts = receipts.map((x) => (x.id === id ? { ...x, undone: new Date().toISOString() } : x));
        record({ verb: 'Moved back', bytes: r.bytes, items: r.items, subject: r.subject, dest: 'original folder' });
        return { ok: true };
      }
      receipts = receipts.map((x) => (x.id === id ? { ...x, undone: new Date().toISOString() } : x));
      record({ verb: 'Restored', items: r.undo.paths.length, subject: `${r.undo.paths.length} files`, dest: 'original folders' });
      return { ok: true, restored: r.undo.paths.length, failed: [] };
    },
    'move:plan': async (src, dest) => {
      const errors = [];
      if (!dest) errors.push('Choose a destination folder.');
      else if (dest[0].toUpperCase() === src[0].toUpperCase()) errors.push('Destination is on the same drive, so this would not free any space.');
      const n = findNode(tree, src);
      return {
        ok: errors.length === 0,
        errors,
        warnings: ['Close apps that use this folder first. If any file is in use, Reclaim stops before changing anything.', 'The destination drive must be connected whenever apps use this folder.'],
        bytes: n?.size ?? 2.3 * GB,
        files: n?.files ?? 4120,
        src,
        dest,
        steps: [`Copy ${src} to ${dest}`, 'Verify file count and size match', 'Rename the original to *.reclaim-old', `Create a junction at ${src}`, 'Verify the junction; roll back automatically if anything fails', 'You decide when to delete the old copy (frees the space)'],
      };
    },
    'move:run': async (src, dest) => {
      const total = findNode(tree, src)?.size ?? 2.3 * GB;
      emit('move:step', 'Copying files');
      for (let i = 1; i <= 10; i++) {
        emit('move:progress', { copied: (total * i) / 10, total });
        await wait(150);
      }
      for (const s of ['Verifying copy', 'Renaming original', 'Creating junction']) {
        emit('move:step', s);
        await wait(500);
      }
      const e = { id: String(Date.now()), src, dest, old: `${src}.reclaim-old`, bytes: findNode(tree, src)?.size ?? 2.3 * GB, files: 4120, createdAt: new Date().toISOString(), status: 'pending-cleanup' };
      moves = [e, ...moves];
      record({ verb: 'Moved', bytes: e.bytes, items: e.files, subject: src.split('\\').pop(), dest, note: `Old copy kept at ${e.old}`, undo: { kind: 'move-back', moveId: e.id } });
      return e;
    },
    'move:list': async () => moves,
    'move:finalize': async (id) => {
      await wait(600);
      const m0 = moves.find((m) => m.id === id);
      free += m0.bytes;
      record({ verb: 'Deleted old copy', bytes: m0.bytes, items: m0.files, subject: m0.src.split('\\').pop(), dest: 'permanent delete', note: m0.old });
      moves = moves.map((m) => (m.id === id ? { ...m, status: 'done' } : m));
      return moves.find((m) => m.id === id);
    },
    'move:undo': async (id) => {
      const m0 = moves.find((m) => m.id === id);
      for (let i = 1; i <= 8; i++) {
        emit('move:progress', { copied: (m0.bytes * i) / 8, total: m0.bytes });
        await wait(120);
      }
      receipts = receipts.map((x) => (x.undo?.moveId === id ? { ...x, undone: new Date().toISOString() } : x));
      record({ verb: 'Moved back', bytes: m0.bytes, items: m0.files, subject: m0.src.split('\\').pop(), dest: m0.src });
      moves = moves.map((m) => (m.id === id ? { ...m, status: 'undone' } : m));
      return moves.find((m) => m.id === id);
    },
    'dupes:defaults': async () => ['Desktop', 'Documents', 'Downloads', 'Pictures', 'Videos', 'Music'].map((n) => `C:\\Users\\demo\\${n}`),
    'dupes:start': async () => {
      for (const phase of ['Listing files', 'Comparing file starts', 'Verifying full contents']) {
        emit('dupes:progress', { phase, done: 3, total: 9 });
        await wait(500);
      }
      const g = (size, paths) => ({ hash: fakeHash(paths[0]), size, wasted: size * (paths.length - 1), files: paths.map((p, i) => ({ path: p, size, mtime: Date.now() - (paths.length - i) * 86400000 * 9 })) });
      const groups = [
        g(745 * MB, ['C:\\Users\\demo\\Videos\\Screen Recordings\\Screen Recording 2026-10-02.mp4', 'C:\\Users\\demo\\Desktop\\demo-final.mp4']),
        g(96 * MB, ['C:\\Users\\demo\\Downloads\\python-3.12.4-amd64.exe', 'C:\\Users\\demo\\Downloads\\python-3.12.4-amd64 (1).exe', 'C:\\Users\\demo\\Desktop\\backup\\python-3.12.4-amd64.exe']),
        g(3.7 * MB, ['C:\\Users\\demo\\Downloads\\FYP Report-main.pdf', 'C:\\Users\\demo\\Documents\\FYP Report-main.pdf']),
        g(1.4 * MB, ['C:\\Users\\demo\\Desktop\\A&S.zip', 'C:\\Users\\demo\\Desktop\\backup\\A&S.zip']),
      ];
      groups.forEach((x) => x.files.forEach((f) => dupeSizes.set(f.path, f.size)));
      return { groups, wasted: groups.reduce((n, x) => n + x.wasted, 0) };
    },
    'dupes:cancel': async () => {},
    'programs:list': async () => {
      await wait(400);
      return PROGRAMS;
    },
    'programs:uninstall': async () => true,
    'programs:openSettings': async () => {},
    'shell:reveal': async () => {},
    'shell:open': async () => {},
    'dupes:trash': async (paths) => {
      await wait(300);
      record({ verb: 'Recycled', bytes: paths.reduce((n, p) => n + (dupeSizes.get(p) || 0), 0), items: paths.length, subject: paths.length === 1 ? paths[0].split('\\').pop() : `${paths.length} duplicate copies`, dest: 'Recycle Bin', note: 'Space is freed when the Recycle Bin is emptied.', undo: { kind: 'restore', paths } });
      return paths.map((p) => ({ path: p, ok: true }));
    },
    'dialog:pickFolder': async () => 'D:\\Moved',
    'admin:relaunch': async () => {
      throw new Error('Demo mode: run the desktop app to elevate.');
    },
  };

  return {
    invoke: (ch, ...args) => (handlers[ch] ? handlers[ch](...args) : Promise.reject(new Error(`No mock for ${ch}`))),
    on(ch, cb) {
      const l = listeners.get(ch) || [];
      l.push(cb);
      listeners.set(ch, l);
      return () => listeners.set(ch, (listeners.get(ch) || []).filter((x) => x !== cb));
    },
  };
}
