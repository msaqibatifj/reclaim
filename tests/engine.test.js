'use strict';
/* Engine tests. Run with `npm test`. They use temp folders and work on any OS. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const os = require('node:os');

const safety = require('../electron/lib/safety');
const { deleteContents, dirSize } = require('../electron/lib/fsx');
const { scan, categoryOf } = require('../electron/lib/scanner');
const { buildCleaners } = require('../electron/lib/cleaners');
const mover = require('../electron/lib/mover');
const { findDuplicates } = require('../electron/lib/duplicates');

const DAY = 86400000;

async function tmpdir() {
  return fsp.mkdtemp(path.join(os.tmpdir(), 'reclaim-test-'));
}
async function write(p, bytes, ageDays = 0) {
  await fsp.mkdir(path.dirname(p), { recursive: true });
  await fsp.writeFile(p, Buffer.alloc(bytes, 7));
  if (ageDays) {
    const t = new Date(Date.now() - ageDays * DAY);
    await fsp.utimes(p, t, t);
  }
}

/* ---------------- safety ---------------- */

test('safety: refuses drive roots, home, and personal folders', () => {
  const home = os.homedir();
  assert.throws(() => safety.assertSafeRoot(path.parse(home).root), safety.SafetyError);
  assert.throws(() => safety.assertSafeRoot(home), safety.SafetyError);
  assert.throws(() => safety.assertSafeRoot(path.join(home, 'Documents')), safety.SafetyError);
  assert.throws(() => safety.assertSafeRoot(path.join(home, 'Documents', 'stuff')), safety.SafetyError);
  assert.throws(() => safety.assertSafeRoot('relative/path'), safety.SafetyError);
  assert.throws(() => safety.assertSafeRoot(path.join(home, 'AppData', 'Local')), safety.SafetyError);
});

test('safety: refuses a path that is an ancestor of a protected folder', () => {
  const home = os.homedir();
  // the parent of home contains home -> must refuse
  assert.throws(() => safety.assertSafeRoot(path.dirname(home)), safety.SafetyError);
});

test('safety: allows a cache folder inside AppData', () => {
  const p = path.join(os.homedir(), 'AppData', 'Local', 'Temp');
  assert.equal(safety.assertSafeRoot(p), path.resolve(p));
});

test('safety: rejects traversal segments', () => {
  assert.throws(() => safety.assertSafeRoot(path.join(os.tmpdir(), 'a', '..', '..')), safety.SafetyError);
});

/* ---------------- deleteContents ---------------- */

test('deleteContents: respects age, keeps root, counts bytes', async () => {
  const root = await tmpdir();
  await write(path.join(root, 'old.bin'), 1000, 5);
  await write(path.join(root, 'new.bin'), 500, 0);
  await write(path.join(root, 'sub', 'old2.bin'), 2000, 5);

  const dry = await deleteContents(root, { dryRun: true, olderThanMs: 2 * DAY });
  assert.equal(dry.freed, 3000);
  assert.ok(fs.existsSync(path.join(root, 'old.bin')), 'dry run must not delete');

  const r = await deleteContents(root, { olderThanMs: 2 * DAY });
  assert.equal(r.freed, 3000);
  assert.equal(r.files, 2);
  assert.ok(fs.existsSync(root), 'root is kept');
  assert.ok(fs.existsSync(path.join(root, 'new.bin')), 'recent file kept');
  assert.ok(!fs.existsSync(path.join(root, 'sub')), 'emptied subfolder removed');
});

test('deleteContents: never follows symlinks out of the root', async () => {
  const root = await tmpdir();
  const outside = await tmpdir();
  await write(path.join(outside, 'precious.txt'), 100);
  await fsp.symlink(outside, path.join(root, 'link'), 'dir');
  await deleteContents(root, {});
  assert.ok(fs.existsSync(path.join(outside, 'precious.txt')), 'target of link must survive');
  assert.ok(!fs.existsSync(path.join(root, 'link')), 'link itself removed');
});

test('deleteContents: match + shallowOnly only touches matching top-level files', async () => {
  const root = await tmpdir();
  await write(path.join(root, 'rbx-storage.db'), 100);
  await write(path.join(root, 'keep.xml'), 100);
  await write(path.join(root, 'Versions', 'rbx-storage.db'), 100);
  const r = await deleteContents(root, { match: (n) => n === 'rbx-storage.db', shallowOnly: true });
  assert.equal(r.files, 1);
  assert.ok(fs.existsSync(path.join(root, 'keep.xml')));
  assert.ok(fs.existsSync(path.join(root, 'Versions', 'rbx-storage.db')));
});

/* ---------------- scanner ---------------- */

test('scanner: totals, ordering, top files and categories', async () => {
  const root = await tmpdir();
  await write(path.join(root, 'big', 'movie.mp4'), 50000);
  await write(path.join(root, 'big', 'nested', 'x.zip'), 20000);
  await write(path.join(root, 'small', 'a.txt'), 100);
  await write(path.join(root, 'loose.log'), 300);

  const r = await scan(root, { maxDepth: 3 });
  assert.equal(r.tree.size, 70400);
  assert.equal(r.stats.files, 4);
  assert.equal(r.tree.children[0].name, 'big');
  assert.equal(r.topFiles[0].name, 'movie.mp4');
  assert.equal(r.categories.Video, 50000);
  assert.equal(r.categories.Archives, 20000);
  assert.equal(categoryOf('a.VHDX'), 'Disk images');
});

test('scanner: depth limit keeps totals but drops deep children', async () => {
  const root = await tmpdir();
  await write(path.join(root, 'a', 'b', 'c', 'd.bin'), 1234);
  const r = await scan(root, { maxDepth: 1 });
  const a = r.tree.children.find((c) => c.name === 'a');
  assert.equal(a.size, 1234);
  assert.equal(a.children.length, 0);
  assert.equal(a.truncated, true);
});

test('scanner: does not double count through symlinks', async () => {
  const root = await tmpdir();
  await write(path.join(root, 'real', 'f.bin'), 1000);
  await fsp.symlink(path.join(root, 'real'), path.join(root, 'alias'), 'dir');
  const r = await scan(root);
  assert.equal(r.tree.size, 1000);
});

/* ---------------- cleaners ---------------- */

test('cleaners: user temp keeps recent files; npm cache cleared', async () => {
  const local = await tmpdir();
  await write(path.join(local, 'Temp', 'old.tmp'), 4000, 10);
  await write(path.join(local, 'Temp', 'fresh.tmp'), 4000, 0);
  await write(path.join(local, 'npm-cache', '_cacache', 'content', 'x'), 7000);

  const cleaners = buildCleaners({ LOCALAPPDATA: local, SystemRoot: path.join(local, 'Win') });
  const temp = cleaners.find((c) => c.id === 'user-temp');
  assert.equal(await temp.estimate(), 4000);
  const r = await temp.run();
  assert.equal(r.freed, 4000);
  assert.ok(fs.existsSync(path.join(local, 'Temp', 'fresh.tmp')));

  const npm = cleaners.find((c) => c.id === 'npm-cache');
  assert.equal((await npm.run()).freed, 7000);
});

test('cleaners: chrome cache only touches cache dirs, never profile data', async () => {
  const local = await tmpdir();
  const ud = path.join(local, 'Google', 'Chrome', 'User Data');
  await write(path.join(ud, 'Default', 'Cache', 'Cache_Data', 'f_0001'), 5000);
  await write(path.join(ud, 'Profile 3', 'Code Cache', 'js', 'abc'), 3000);
  await write(path.join(ud, 'Default', 'Login Data'), 999);
  await write(path.join(ud, 'Default', 'IndexedDB', 'whatsapp', 'db'), 999);

  const chrome = buildCleaners({ LOCALAPPDATA: local }).find((c) => c.id === 'chrome-cache');
  const r = await chrome.run();
  assert.equal(r.freed, 8000);
  assert.ok(fs.existsSync(path.join(ud, 'Default', 'Login Data')));
  assert.ok(fs.existsSync(path.join(ud, 'Default', 'IndexedDB', 'whatsapp', 'db')));
});

test('cleaners: roblox keeps installed versions', async () => {
  const local = await tmpdir();
  const rb = path.join(local, 'Roblox');
  await write(path.join(rb, 'rbx-storage', 'a'), 1000);
  await write(path.join(rb, 'Downloads', 'b'), 1000);
  await write(path.join(rb, 'rbx-storage.db'), 500);
  await write(path.join(rb, 'Versions', 'version-1', 'RobloxStudioBeta.exe'), 9000);
  await write(path.join(rb, 'GlobalSettings_13.xml'), 10);

  const c = buildCleaners({ LOCALAPPDATA: local }).find((x) => x.id === 'roblox-cache');
  const r = await c.run();
  assert.equal(r.freed, 2500);
  assert.ok(fs.existsSync(path.join(rb, 'Versions', 'version-1', 'RobloxStudioBeta.exe')));
  assert.ok(fs.existsSync(path.join(rb, 'GlobalSettings_13.xml')));
});

test('cleaners: command cleaners do nothing in dry run and use fixed argv', async () => {
  const calls = [];
  const fake = async (cmd, args) => {
    calls.push([cmd, ...args]);
    return { code: 0 };
  };
  const list = buildCleaners({ LOCALAPPDATA: os.tmpdir() }, { runProgram: fake });
  const hib = list.find((c) => c.id === 'hibernate-off');
  await hib.run({ dryRun: true });
  assert.equal(calls.length, 0);
  await hib.run({});
  assert.deepEqual(calls[0], ['powercfg', '-h', 'off']);
});

test('cleaners: every cleaner has the required metadata', () => {
  for (const c of buildCleaners({ LOCALAPPDATA: os.tmpdir() })) {
    assert.ok(c.id && c.name && c.description, c.id);
    assert.ok(['safe', 'low', 'caution'].includes(c.risk), c.id);
    assert.equal(typeof c.admin, 'boolean', c.id);
    assert.equal(typeof c.run, 'function', c.id);
  }
});

/* ---------------- mover ---------------- */

const fakeDrives = (srcRoot) => (p) => (p.startsWith(srcRoot) ? 'C:' : 'D:');

test('mover: plan rejects protected and same-drive moves', async () => {
  const home = os.homedir();
  const plan = await mover.planMove(home, path.join(os.tmpdir(), 'x'));
  assert.equal(plan.ok, false);

  const src = await tmpdir();
  const p2 = await mover.planMove(src, path.join(os.tmpdir(), 'reclaim-same-' + Date.now()));
  assert.equal(p2.ok, false);
  assert.match(p2.errors.join(' '), /same drive/);
});

test('mover: move, finalize, then undo round-trips data', async () => {
  const base = await tmpdir();
  const src = path.join(base, 'c', 'GameData');
  const destParent = path.join(base, 'd');
  await write(path.join(src, 'a.bin'), 1000);
  await write(path.join(src, 'sub', 'b.bin'), 2000);
  const dest = path.join(destParent, 'GameData');
  const deps = { driveOf: fakeDrives(path.join(base, 'c')), freeBytes: async () => 1e12 };

  const plan = await mover.planMove(src, dest, deps);
  assert.ok(plan.ok, plan.errors.join(' '));
  assert.equal(plan.bytes, 3000);

  const entry = await mover.executeMove(plan, deps);
  assert.equal(entry.status, 'pending-cleanup');
  assert.ok((await fsp.lstat(src)).isSymbolicLink(), 'junction/symlink at original path');
  assert.equal((await fsp.readFile(path.join(src, 'sub', 'b.bin'))).length, 2000, 'readable through link');
  assert.ok(fs.existsSync(entry.old), 'old copy kept until finalize');

  // a write made through the link after the move must survive undo
  await write(path.join(src, 'new-after-move.txt'), 42);

  const fin = await mover.finalizeMove(entry);
  assert.equal(fin.status, 'done');
  assert.ok(!fs.existsSync(entry.old));

  const undone = await mover.undoMove(fin, deps);
  assert.equal(undone.status, 'undone');
  const st = await fsp.lstat(src);
  assert.ok(st.isDirectory() && !st.isSymbolicLink(), 'original is a real folder again');
  assert.ok(fs.existsSync(path.join(src, 'new-after-move.txt')), 'post-move writes preserved');
  assert.ok(!fs.existsSync(dest), 'destination cleaned up');
});

test('mover: undo before finalize restores live data and removes the stale copy', async () => {
  const base = await tmpdir();
  const src = path.join(base, 'c', 'Data');
  await write(path.join(src, 'f.bin'), 10);
  const deps = { driveOf: fakeDrives(path.join(base, 'c')), freeBytes: async () => 1e12 };
  const entry = await mover.executeMove(await mover.planMove(src, path.join(base, 'd', 'Data'), deps), deps);
  await write(path.join(src, 'edited.txt'), 5);
  await mover.undoMove(entry, deps);
  assert.ok(fs.existsSync(path.join(src, 'edited.txt')));
  assert.ok(!fs.existsSync(entry.old));
});

test('mover: failed copy leaves the original untouched', async () => {
  const base = await tmpdir();
  const src = path.join(base, 'c', 'Data');
  await write(path.join(src, 'f.bin'), 10);
  const deps = {
    driveOf: fakeDrives(path.join(base, 'c')),
    freeBytes: async () => 1e12,
    copyTree: async () => {
      throw new Error('disk full');
    },
  };
  const plan = await mover.planMove(src, path.join(base, 'd', 'Data'), deps);
  await assert.rejects(mover.executeMove(plan, deps), /nothing was changed/i);
  const st = await fsp.lstat(src);
  assert.ok(st.isDirectory() && !st.isSymbolicLink());
  assert.ok(!fs.existsSync(path.join(base, 'd', 'Data')));
});

test('mover: refuses Windows and Program Files trees', () => {
  const env = { SystemDrive: 'C:', SystemRoot: '/fake/Windows', ProgramFiles: '/fake/Program Files' };
  assert.throws(() => mover.assertMovable('/fake/Windows/System32', env), safety.SafetyError);
  assert.throws(() => mover.assertMovable('/fake/Program Files/App', env), safety.SafetyError);
});

/* ---------------- duplicates ---------------- */

test('duplicates: finds identical files, ignores same-size different content', async () => {
  const root = await tmpdir();
  const a = Buffer.alloc(200000, 1);
  const b = Buffer.alloc(200000, 1);
  const c = Buffer.alloc(200000, 1);
  c[100000] = 9; // same size, same head/tail, different middle
  await fsp.mkdir(path.join(root, 'x'), { recursive: true });
  await fsp.writeFile(path.join(root, 'a.bin'), a);
  await fsp.writeFile(path.join(root, 'x', 'b.bin'), b);
  await fsp.writeFile(path.join(root, 'c.bin'), c);
  const r = await findDuplicates([root], { minSize: 1000 });
  assert.equal(r.groups.length, 1);
  assert.equal(r.groups[0].files.length, 2);
  assert.equal(r.wasted, 200000);
});

test('dirSize matches written bytes', async () => {
  const root = await tmpdir();
  await write(path.join(root, 'a'), 10);
  await write(path.join(root, 'b', 'c'), 20);
  assert.equal(await dirSize(root), 30);
});

/* ---------------- regression tests (audit fixes) ---------------- */

const { findDuplicates: findDupes, normaliseRoots } = require('../electron/lib/duplicates');
const { normalizeUninstall } = require('../electron/lib/system');

test('mover: finalize refuses to delete the old copy when the destination is gone', async () => {
  const base = await tmpdir();
  const src = path.join(base, 'c', 'Data');
  await write(path.join(src, 'f.bin'), 10);
  const deps = { driveOf: fakeDrives(path.join(base, 'c')), freeBytes: async () => 1e12 };
  const entry = await mover.executeMove(await mover.planMove(src, path.join(base, 'd', 'Data'), deps), deps);
  // simulate the destination drive being unplugged
  await fsp.rename(entry.dest, entry.dest + '-unplugged');
  await assert.rejects(mover.finalizeMove(entry), /not reachable|refusing/i);
  assert.ok(fs.existsSync(path.join(entry.old, 'f.bin')), 'old copy must survive');
});

test('mover: finalize refuses when the junction points somewhere else', async () => {
  const base = await tmpdir();
  const src = path.join(base, 'c', 'Data');
  await write(path.join(src, 'f.bin'), 10);
  const deps = { driveOf: fakeDrives(path.join(base, 'c')), freeBytes: async () => 1e12 };
  const entry = await mover.executeMove(await mover.planMove(src, path.join(base, 'd', 'Data'), deps), deps);
  await fsp.unlink(src);
  const other = path.join(base, 'elsewhere');
  await fsp.mkdir(other);
  await fsp.symlink(other, src, 'junction');
  await assert.rejects(mover.finalizeMove(entry), /no longer points/i);
  assert.ok(fs.existsSync(entry.old));
});

test('mover: refuses folders that contain links or junctions', async () => {
  const base = await tmpdir();
  const src = path.join(base, 'c', 'Data');
  await write(path.join(src, 'f.bin'), 10);
  await fsp.symlink(base, path.join(src, 'loop'), 'dir');
  const deps = { driveOf: fakeDrives(path.join(base, 'c')), freeBytes: async () => 1e12 };
  const plan = await mover.planMove(src, path.join(base, 'd', 'Data'), deps);
  assert.equal(plan.ok, false);
  assert.match(plan.errors.join(' '), /link/);
});

test('mover: undo checks free space before touching anything', async () => {
  const base = await tmpdir();
  const src = path.join(base, 'c', 'Data');
  await write(path.join(src, 'f.bin'), 10);
  const deps = { driveOf: fakeDrives(path.join(base, 'c')), freeBytes: async () => 1e12 };
  const entry = await mover.executeMove(await mover.planMove(src, path.join(base, 'd', 'Data'), deps), deps);
  await assert.rejects(mover.undoMove(entry, { freeBytes: async () => 1000 }), /not enough free space/i);
  assert.ok((await fsp.lstat(src)).isSymbolicLink(), 'junction untouched');
  assert.ok(fs.existsSync(path.join(entry.dest, 'f.bin')));
});

test('mover: refuses OneDrive folders', () => {
  const home = os.homedir();
  assert.throws(() => mover.assertMovable(path.join(home, 'OneDrive', 'Pictures')), /OneDrive/);
  assert.throws(() => mover.assertMovable(path.join(home, 'OneDrive - Contoso')), /OneDrive/);
});

test('mover: robocopy file lines are parsed for progress, other lines are not', () => {
  assert.equal(mover.robocopyLineBytes('\t    New File  \t\t   123456\tC:\\src\\a.bin'), 123456);
  assert.equal(mover.robocopyLineBytes('\t\t   42\tC:\\src\\b.txt'), 42);
  assert.equal(mover.robocopyLineBytes('2026/10/24 12:00:01 ERROR 32 (0x00000020) Copying File C:\\x'), 0);
  assert.equal(mover.robocopyLineBytes('Waiting 1 seconds... Retrying...'), 0);
  assert.equal(mover.robocopyLineBytes(''), 0);
});

test('duplicates: overlapping roots never make a file its own duplicate', async () => {
  const root = await tmpdir();
  await write(path.join(root, 'sub', 'only.bin'), 5000);
  const r = await findDupes([root, path.join(root, 'sub'), root + path.sep], { minSize: 1000 });
  assert.equal(r.groups.length, 0);
  assert.deepEqual(normaliseRoots([root, path.join(root, 'sub')]), [path.resolve(root)]);
});

test('duplicates: hard links are not reported as duplicates', async () => {
  const root = await tmpdir();
  await write(path.join(root, 'a.bin'), 5000);
  await fsp.link(path.join(root, 'a.bin'), path.join(root, 'b.bin'));
  const r = await findDupes([root], { minSize: 1000 });
  assert.equal(r.groups.length, 0);
});

test('scanner: hard-linked files are counted once', async () => {
  const root = await tmpdir();
  await write(path.join(root, 'a', 'x.bin'), 4000);
  await fsp.mkdir(path.join(root, 'b'));
  await fsp.link(path.join(root, 'a', 'x.bin'), path.join(root, 'b', 'x.bin'));
  const r = await scan(root);
  assert.equal(r.tree.size, 4000);
  assert.equal(r.stats.hardlinks, 1);
});

test('deleteContents: removes read-only files', async () => {
  const root = await tmpdir();
  const f = path.join(root, 'ro.tmp');
  await write(f, 100);
  await fsp.chmod(f, 0o444);
  const r = await deleteContents(root, {});
  assert.equal(r.files, 1);
  assert.ok(!fs.existsSync(f));
});

test('programs: uninstall strings are made runnable', () => {
  assert.equal(normalizeUninstall('MsiExec.exe /I{AB12-CD34}'), 'MsiExec.exe /X{AB12-CD34}');
  assert.equal(normalizeUninstall('C:\\Program Files\\Foo App\\uninst.exe /S'), '"C:\\Program Files\\Foo App\\uninst.exe" /S');
  assert.equal(normalizeUninstall('"C:\\Program Files\\X\\u.exe" --remove'), '"C:\\Program Files\\X\\u.exe" --remove');
  assert.equal(normalizeUninstall(''), '');
});

test('cleaners: falls back to the profile when LOCALAPPDATA is missing', async () => {
  const list = buildCleaners({ USERPROFILE: path.join(os.tmpdir(), 'fakehome') });
  const [t] = await list.find((c) => c.id === 'user-temp').resolve();
  assert.equal(t.root, path.join(os.tmpdir(), 'fakehome', 'AppData', 'Local', 'Temp'));
});

/* ---------------- redesign support: preview, ledger, restore ---------------- */

const recycle = require('../electron/lib/recycle');
const { exportReceipts, receipt } = require('../electron/lib/receipts');

test('cleaners: preview lists each folder that changes with its size', async () => {
  const local = await tmpdir();
  await write(path.join(local, 'Temp', 'old.tmp'), 4000, 10);
  await write(path.join(local, 'Temp', 'new.tmp'), 10);
  const c = buildCleaners({ LOCALAPPDATA: local }).find((x) => x.id === 'user-temp');
  const p = await c.preview();
  assert.deepEqual(p.map((i) => [i.path, i.bytes, i.files]), [[path.join(local, 'Temp'), 4000, 1]]);
  assert.ok(fs.existsSync(path.join(local, 'Temp', 'old.tmp')), 'preview changes nothing');
});

test('cleaners: every cleaner has a grade and margin notes', () => {
  for (const c of buildCleaners({ LOCALAPPDATA: os.tmpdir() })) {
    assert.ok(['A', 'B', 'C'].includes(c.grade), c.id);
    assert.ok(c.section && c.back && c.breaks && c.undo && c.dest, c.id);
  }
});

test('scanner: streams each top-level folder as it finishes', async () => {
  const root = await tmpdir();
  await write(path.join(root, 'a', 'x'), 100);
  await write(path.join(root, 'b', 'deep', 'y'), 300);
  const rows = [];
  await scan(root, { onRow: (r) => rows.push(r) });
  assert.deepEqual(rows.map((r) => [r.name, r.size]).sort(), [['a', 100], ['b', 300]]);
});

test('duplicates: groups carry their content hash', async () => {
  const root = await tmpdir();
  await write(path.join(root, 'a.bin'), 5000);
  await write(path.join(root, 'b.bin'), 5000);
  const r = await findDuplicates([root], { minSize: 1000 });
  assert.match(r.groups[0].hash, /^[0-9a-f]{64}$/);
});

test('recycle: $I files round-trip and restore moves $R back', async () => {
  const bin = await tmpdir();
  const home = await tmpdir();
  const original = path.join(home, 'docs', 'report.pdf');
  await fsp.writeFile(path.join(bin, '$IAB12CD.pdf'), recycle.buildIndexFile(original, 42));
  await fsp.writeFile(path.join(bin, '$RAB12CD.pdf'), Buffer.alloc(42, 1));
  const meta = recycle.parseIndexFile(await fsp.readFile(path.join(bin, '$IAB12CD.pdf')));
  assert.equal(meta.original, original);
  assert.equal(meta.size, 42);

  const missing = path.join(home, 'never-deleted.txt');
  const r = await recycle.restore([original, missing], { binDirFor: async () => bin });
  assert.deepEqual(r.map((x) => x.ok), [true, false]);
  assert.equal((await fsp.readFile(original)).length, 42);
  assert.ok(!fs.existsSync(path.join(bin, '$IAB12CD.pdf')));
});

test('recycle: never overwrites a file that already exists', async () => {
  const bin = await tmpdir();
  const original = path.join(await tmpdir(), 'a.txt');
  await fsp.writeFile(original, 'current');
  await fsp.writeFile(path.join(bin, '$IX.txt'), recycle.buildIndexFile(original, 3));
  await fsp.writeFile(path.join(bin, '$RX.txt'), 'old');
  const [r] = await recycle.restore([original], { binDirFor: async () => bin });
  assert.equal(r.ok, false);
  assert.equal(await fsp.readFile(original, 'utf8'), 'current');
});

test('receipts: export as text and CSV', () => {
  const list = [receipt({ verb: 'Removed', bytes: 7.9 * 1024 ** 3, items: 312, subject: 'Chrome cache, "npm"', dest: 'permanent delete' })];
  assert.match(exportReceipts(list, 'txt'), /Removed\s+7\.9 GB\s+312\s+Chrome cache/);
  const csv = exportReceipts(list, 'csv').split('\r\n');
  assert.equal(csv[0], 'date,action,bytes,size,items,subject,destination,note');
  assert.match(csv[1], /"Chrome cache, ""npm"""/);
});
