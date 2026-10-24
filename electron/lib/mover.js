'use strict';
/**
 * Move a folder to another drive and leave a junction behind, so apps keep using
 * the original path while the data lives elsewhere.
 *
 * Safe-by-construction order:
 *   1. copy to destination (original untouched)
 *   2. verify byte/file counts match
 *   3. rename original to "<name>.reclaim-old"   (still recoverable)
 *   4. create junction at the original path -> destination
 *   5. verify junction; on ANY failure roll back to the original
 * The ".reclaim-old" copy is only deleted when the user explicitly finalizes.
 */
const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const safety = require('./safety');
const { safeLstat, safeReaddir, mapLimit } = require('./fsx');
const { freeBytes } = require('./cleaners');

const OLD_SUFFIX = '.reclaim-old';

/**
 * Count files and bytes under a directory (symlinks not followed).
 * `links` counts symlinks/junctions found inside, `unreadable` counts folders we could not list.
 */
async function treeStats(root) {
  let bytes = 0;
  let files = 0;
  let links = 0;
  let unreadable = 0;
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    const entries = await safeReaddir(dir);
    if (!entries) {
      unreadable++;
      continue;
    }
    const fileList = [];
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isSymbolicLink()) {
        links++;
        continue;
      }
      if (e.isDirectory()) stack.push(full);
      else fileList.push(full);
    }
    const sizes = await mapLimit(fileList, 32, async (f) => (await safeLstat(f))?.size ?? 0);
    for (const s of sizes) {
      bytes += s;
      files++;
    }
  }
  return { bytes, files, links, unreadable };
}

function driveOf(p) {
  return safety.norm(path.parse(path.resolve(p)).root);
}

/** Paths that may never be moved: system folders and anything holding them. */
function assertMovable(src, env = process.env, home = require('node:os').homedir()) {
  if (!path.isAbsolute(src)) throw new safety.SafetyError('Path must be absolute');
  const resolved = path.resolve(src);
  if (resolved.split(path.sep).filter(Boolean).length < 2) throw new safety.SafetyError('Refusing to move a drive root');

  for (const p of safety.protectedPaths(env, home)) {
    if (safety.isSame(resolved, p) || safety.isInside(resolved, p)) {
      throw new safety.SafetyError(`Refusing to move a protected location: ${src}`);
    }
  }
  const sysDrive = env.SystemDrive || 'C:';
  const blockedTrees = [
    env.SystemRoot || sysDrive + '\\Windows',
    env.ProgramFiles || sysDrive + '\\Program Files',
    env['ProgramFiles(x86)'] || sysDrive + '\\Program Files (x86)',
    sysDrive + '\\Recovery',
    sysDrive + '\\System Volume Information',
    path.join(env.ProgramData || sysDrive + '\\ProgramData', 'Microsoft'),
  ];
  for (const t of blockedTrees) {
    if (safety.isSame(resolved, t) || safety.isInside(t, resolved)) {
      throw new safety.SafetyError(`System and installed-program folders cannot be moved safely: ${src}`);
    }
  }
  // OneDrive refuses to sync through junctions and would treat the folder as deleted.
  const rel = path.relative(home, resolved);
  if (rel && !rel.startsWith('..') && !path.isAbsolute(rel) && /^onedrive( - .*)?$/i.test(rel.split(path.sep)[0])) {
    throw new safety.SafetyError('OneDrive folders cannot be moved with a junction. Change the OneDrive folder location in OneDrive settings instead.');
  }
  return resolved;
}

/**
 * Check everything that can be checked before touching any file.
 * @returns {{ok:boolean, errors:string[], warnings:string[], bytes:number, files:number, steps:string[]}}
 */
async function planMove(src, dest, deps = {}) {
  const errors = [];
  const warnings = [];
  const free = deps.freeBytes || freeBytes;
  const drive = deps.driveOf || driveOf;
  let bytes = 0;
  let files = 0;

  let resolvedSrc;
  try {
    resolvedSrc = assertMovable(src, deps.env, deps.home);
  } catch (e) {
    errors.push(e.message);
  }
  const resolvedDest = path.resolve(dest || '');

  if (resolvedSrc) {
    const st = await safeLstat(resolvedSrc);
    if (!st) errors.push('Source folder does not exist.');
    else if (st.isSymbolicLink()) errors.push('Source is already a junction or symlink.');
    else if (!st.isDirectory()) errors.push('Source is not a folder.');
    else {
      const t = deps.knownStats || (await treeStats(resolvedSrc));
      ({ bytes, files } = t);
      if (t.links > 0) {
        errors.push(`This folder contains ${t.links} link(s) or junction(s). Reclaim cannot move those safely, so it leaves this folder alone.`);
      }
      if (t.unreadable > 0) {
        errors.push(`${t.unreadable} subfolder(s) could not be read (permission denied). Reclaim only moves folders it can copy completely.`);
      }
    }
  }

  if (!dest || !path.isAbsolute(dest)) errors.push('Choose a destination folder.');
  else if (resolvedSrc) {
    if (drive(resolvedSrc) === drive(resolvedDest)) errors.push('Destination is on the same drive, so this would not free any space.');
    if (safety.isSame(resolvedDest, resolvedSrc) || safety.isInside(resolvedSrc, resolvedDest)) errors.push('Destination cannot be inside the source.');
    if (await safeLstat(resolvedDest)) errors.push('Destination already exists. Pick a new folder name.');
    const parent = path.dirname(resolvedDest);
    if (!(await safeLstat(parent))) warnings.push(`Parent folder ${parent} does not exist and will be created.`);
    const need = Math.ceil(bytes * 1.05) + 256 * 1024 * 1024;
    const have = await free(path.parse(resolvedDest).root);
    if (have && have < need) errors.push(`Not enough free space on the destination drive (${fmt(have)} free, ${fmt(need)} needed).`);
  }

  warnings.push('Close apps that use this folder first. If any file is in use, Reclaim stops before changing anything.');
  warnings.push('The destination drive must be connected whenever apps use this folder.');

  const steps = resolvedSrc
    ? [
        `Copy ${resolvedSrc} to ${resolvedDest}`,
        'Verify file count and size match',
        `Rename the original to ${path.basename(resolvedSrc)}${OLD_SUFFIX}`,
        `Create a junction at ${resolvedSrc} pointing to ${resolvedDest}`,
        'Verify the junction; roll back automatically if anything fails',
        'You decide when to delete the old copy (frees the space)',
      ]
    : [];

  if (resolvedSrc && /\\appdata\\local\\packages(\\|$)/i.test(resolvedSrc)) {
    warnings.push('Microsoft Store app data does not always work through a junction. Use Settings > Apps > Move for Store apps if you can.');
  }

  return { ok: errors.length === 0, errors, warnings, bytes, files, steps, src: resolvedSrc, dest: resolvedDest };
}

function fmt(n) {
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(i ? 1 : 0)} ${u[i]}`;
}

/* ---------- copy implementations ---------- */

/**
 * Parse one line of robocopy output (run with /BYTES /NDL /NJH /NJS /NP) and return the
 * file size it reports, or 0. File lines look like "\t    New File  \t\t   123456\tC:\path".
 * Exported for tests.
 */
function robocopyLineBytes(line) {
  if (/error|waiting|retry/i.test(line)) return 0;
  const m = line.match(/^\s*(?:[A-Za-z*][A-Za-z* ]*?\s+)?(\d+)\s+\S/);
  return m ? Number(m[1]) : 0;
}

function robocopyTree(src, dest, { onLog, onProgress } = {}) {
  return new Promise((resolve, reject) => {
    const args = [src, dest, '/E', '/COPY:DAT', '/DCOPY:DAT', '/R:1', '/W:1', '/XJ', '/NP', '/NDL', '/NJH', '/NJS', '/BYTES', '/MT:8'];
    const child = spawn('robocopy', args, { windowsHide: true });
    let copied = 0;
    let buf = '';
    child.stdout.on('data', (b) => {
      buf += b.toString();
      const lines = buf.split(/\r?\n/);
      buf = lines.pop();
      for (const l of lines) {
        const n = robocopyLineBytes(l);
        if (n) copied += n;
        else if (l.trim()) onLog?.(l.trim());
      }
      onProgress?.(copied);
    });
    child.on('error', reject);
    // robocopy exit codes 0-7 are success (bit flags), 8+ means failures; null means killed
    child.on('close', (code) => (code !== null && code < 8 ? resolve() : reject(new Error(`robocopy failed with exit code ${code}`))));
  });
}

async function nodeCopyTree(src, dest) {
  await fsp.cp(src, dest, { recursive: true, errorOnExist: true, force: false, verbatimSymlinks: true });
}

const defaultCopy = process.platform === 'win32' ? robocopyTree : nodeCopyTree;

async function rmTree(p) {
  await fsp.rm(p, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
}

async function removeLink(p) {
  const st = await safeLstat(p);
  if (!st) return;
  if (!st.isSymbolicLink()) throw new Error(`${p} is not a junction; refusing to remove it`);
  try {
    await fsp.unlink(p);
  } catch {
    await fsp.rmdir(p);
  }
}

/** Antivirus and the search indexer briefly lock fresh folders; retry a rename a few times. */
async function renameWithRetry(from, to, tries = 5) {
  for (let i = 0; ; i++) {
    try {
      return await fsp.rename(from, to);
    } catch (e) {
      if (i >= tries - 1 || !['EBUSY', 'EPERM', 'EACCES'].includes(e.code)) throw e;
      await new Promise((r) => setTimeout(r, 400 * (i + 1)));
    }
  }
}

/** Where does the junction at `p` point? Normalised so it can be compared with isSame. */
async function linkTarget(p) {
  try {
    let t = await fsp.readlink(p);
    t = t.replace(/^\\\\\?\\/, '').replace(/^\\\?\?\\/, '');
    return path.resolve(path.dirname(p), t);
  } catch {
    return null;
  }
}

/**
 * Execute a validated plan. Returns a ledger entry.
 * @param {object} plan result of planMove with ok === true
 * @param {{onStep?:(s:string)=>void, onLog?:(l:string)=>void, onProgress?:(p:{copied:number,total:number})=>void, copyTree?:Function}} [deps]
 */
async function executeMove(plan, deps = {}) {
  if (!plan?.ok) throw new Error('Plan has errors; refusing to run');
  const { src, dest } = plan;
  const step = (s) => deps.onStep?.(s);
  const copyTree = deps.copyTree || defaultCopy;
  const oldPath = await uniqueOldPath(src);

  // Re-validate at execution time; the world may have changed since planning.
  const fresh = await planMove(src, dest, deps);
  if (!fresh.ok) throw new Error(fresh.errors.join(' '));

  step('Copying files');
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  try {
    await copyTree(src, dest, {
      onLog: deps.onLog,
      onProgress: (copied) => deps.onProgress?.({ copied: Math.min(copied, fresh.bytes), total: fresh.bytes }),
    });
  } catch (e) {
    await rmTree(dest).catch(() => {});
    throw new Error(`Copy failed, nothing was changed: ${e.message}`);
  }

  step('Verifying copy');
  const [a, b] = await Promise.all([treeStats(src), treeStats(dest)]);
  if (a.files !== b.files || a.bytes !== b.bytes) {
    await rmTree(dest).catch(() => {});
    throw new Error(`Copy verification failed (${a.files} files/${a.bytes} bytes vs ${b.files}/${b.bytes}). Something changed the folder while copying, or a file was in use. Nothing was changed.`);
  }

  step('Renaming original');
  try {
    await renameWithRetry(src, oldPath);
  } catch (e) {
    await rmTree(dest).catch(() => {});
    throw new Error(`Could not rename the original (is an app still using it?). Nothing was changed: ${e.code || e.message}`);
  }

  step('Creating junction');
  try {
    await fsp.symlink(dest, src, 'junction');
    const st = await fsp.lstat(src);
    if (!st.isSymbolicLink()) throw new Error('junction was not created');
    await fsp.readdir(src); // must be readable through the link
  } catch (e) {
    step('Rolling back');
    await removeLink(src).catch(() => {});
    await renameWithRetry(oldPath, src).catch(() => {});
    if (await safeLstat(src)) await rmTree(dest).catch(() => {});
    throw new Error(`Junction failed, original restored: ${e.message}`);
  }

  return {
    id: crypto.randomUUID(),
    src,
    dest,
    old: oldPath,
    bytes: a.bytes,
    files: a.files,
    createdAt: new Date().toISOString(),
    status: 'pending-cleanup', // original still exists as .reclaim-old
  };
}

async function uniqueOldPath(src) {
  let candidate = src + OLD_SUFFIX;
  let n = 1;
  while (await safeLstat(candidate)) candidate = `${src}${OLD_SUFFIX}-${++n}`;
  return candidate;
}

/**
 * Check that the junction at entry.src still points at entry.dest and the data is reachable.
 * Throws with a user-facing reason if not.
 */
async function assertLiveCopy(entry) {
  const link = await safeLstat(entry.src);
  if (!link?.isSymbolicLink()) throw new Error('The junction is missing; refusing to delete the old copy.');
  const target = await linkTarget(entry.src);
  if (!target || !safety.isSame(target, entry.dest)) throw new Error(`The junction no longer points to ${entry.dest}; refusing to delete the old copy.`);
  const st = await safeLstat(entry.dest);
  if (!st?.isDirectory()) throw new Error(`${entry.dest} is not reachable (is the drive connected?). The old copy was kept.`);
  await fsp.readdir(entry.src); // readable through the link
}

/** Delete the renamed original; this is what actually frees space on the source drive. */
async function finalizeMove(entry) {
  if (entry.status !== 'pending-cleanup') throw new Error('Nothing to finalize');
  const base = path.basename(entry.old || '');
  const expected = path.basename(entry.src) + OLD_SUFFIX;
  if (!(base === expected || base.startsWith(expected + '-')) || !safety.isSame(path.dirname(entry.old), path.dirname(entry.src))) {
    throw new Error('Refusing to delete an unexpected path');
  }
  // Never delete the old copy unless the live copy is definitely there.
  await assertLiveCopy(entry);
  await rmTree(entry.old);
  return { ...entry, status: 'done', finalizedAt: new Date().toISOString() };
}

/**
 * Put everything back where it was.
 * The destination is the live copy (apps may have written to it through the junction),
 * so we always copy it back rather than reviving the stale ".reclaim-old" folder.
 */
async function undoMove(entry, deps = {}) {
  if (entry.status === 'undone') throw new Error('This move was already undone.');
  const copyTree = deps.copyTree || defaultCopy;
  const free = deps.freeBytes || freeBytes;
  const linkSt = await safeLstat(entry.src);
  if (linkSt && !linkSt.isSymbolicLink()) throw new Error('The original path is a normal folder now; refusing to overwrite it.');
  if (!(await safeLstat(entry.dest))) throw new Error(`Destination ${entry.dest} is missing (is the drive connected?)`);

  const live = await treeStats(entry.dest);
  const need = Math.ceil(live.bytes * 1.05) + 256 * 1024 * 1024;
  const have = await free(path.parse(path.resolve(entry.src)).root);
  if (have && have < need) {
    throw new Error(`Not enough free space to move it back (${fmt(have)} free, ${fmt(need)} needed). Nothing was changed.`);
  }

  await removeLink(entry.src);
  try {
    await copyTree(entry.dest, entry.src, {
      onLog: deps.onLog,
      onProgress: (copied) => deps.onProgress?.({ copied: Math.min(copied, live.bytes), total: live.bytes }),
    });
    const [a, b] = await Promise.all([treeStats(entry.dest), treeStats(entry.src)]);
    if (a.files !== b.files || a.bytes !== b.bytes) throw new Error('restored copy does not match');
  } catch (e) {
    // Put the junction back so apps keep working, and keep the data where it is.
    const st = await safeLstat(entry.src);
    if (st && !st.isSymbolicLink()) await rmTree(entry.src).catch(() => {});
    await fsp.symlink(entry.dest, entry.src, 'junction').catch(() => {});
    throw new Error(`Undo failed; your data is still safe at ${entry.dest}: ${e.message}`);
  }
  await rmTree(entry.dest);
  if (entry.old && (await safeLstat(entry.old))) await rmTree(entry.old);
  return { ...entry, status: 'undone', undoneAt: new Date().toISOString() };
}

/** Tiny JSON ledger of moves so the UI can offer finalize/undo across restarts. */
class Ledger {
  constructor(file) {
    this.file = file;
  }
  load() {
    try {
      const v = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      return Array.isArray(v) ? v : [];
    } catch {
      return [];
    }
  }
  save(list) {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    // write-then-rename so a crash never leaves a half-written ledger
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(list, null, 2));
    fs.renameSync(tmp, this.file);
  }
  add(entry) {
    const l = this.load();
    l.unshift(entry);
    this.save(l);
  }
  update(entry) {
    this.save(this.load().map((e) => (e.id === entry.id ? entry : e)));
  }
  get(id) {
    return this.load().find((e) => e.id === id);
  }
}

module.exports = { planMove, executeMove, finalizeMove, undoMove, assertMovable, treeStats, robocopyLineBytes, Ledger, OLD_SUFFIX };
