'use strict';
/**
 * Duplicate file finder. Three passes so we only hash what could possibly match:
 *   1. group by exact size
 *   2. quick hash: size + first 64 KB + last 64 KB
 *   3. full SHA-256 on the survivors
 */
const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const crypto = require('node:crypto');
const { safeReaddir, mapLimit } = require('./fsx');
const { norm, isInside } = require('./safety');

const SKIP_DIRS = new Set(['node_modules', '.git', '$recycle.bin', 'system volume information', 'windows', 'appdata', '__pycache__', '.venv', 'venv']);
// Cloud-only OneDrive files would be downloaded just to hash them, so OneDrive folders are
// skipped when found inside a search root (picking a OneDrive folder as a root still works).
const SKIP_PATTERNS = [/^onedrive( - .*)?$/i];
const CHUNK = 64 * 1024;

const bigLstat = async (p) => {
  try {
    return await fsp.lstat(p, { bigint: true });
  } catch {
    return null;
  }
};

/**
 * Normalise search roots: drop duplicates and roots nested inside another root, so the
 * same file can never be listed twice (which would make it look like its own duplicate).
 */
function normaliseRoots(roots) {
  const uniq = [];
  const seen = new Set();
  for (const r of roots) {
    if (typeof r !== 'string' || !path.isAbsolute(r)) continue;
    const k = norm(r);
    if (seen.has(k)) continue;
    seen.add(k);
    uniq.push(path.resolve(r));
  }
  return uniq.filter((r) => !uniq.some((o) => o !== r && isInside(o, r)));
}

async function collect(roots, { minSize, signal, onProgress }) {
  const bySize = new Map();
  const seenPaths = new Set();
  const seenInodes = new Set();
  let seen = 0;
  const stack = [...roots];
  while (stack.length) {
    if (signal?.aborted) break;
    const dir = stack.pop();
    const entries = await safeReaddir(dir);
    if (!entries) continue;
    const files = [];
    for (const e of entries) {
      if (e.isSymbolicLink()) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        const n = e.name.toLowerCase();
        if (!SKIP_DIRS.has(n) && !SKIP_PATTERNS.some((re) => re.test(n))) stack.push(full);
      } else if (e.isFile()) files.push(full);
    }
    const stats = await mapLimit(files, 32, bigLstat);
    files.forEach((f, i) => {
      const st = stats[i];
      if (!st || st.size < BigInt(minSize)) return;
      const key = norm(f);
      if (seenPaths.has(key)) return;
      seenPaths.add(key);
      // Hard links share storage: removing one frees nothing, so count each file once.
      if (st.nlink > 1n && st.ino) {
        const ik = `${st.dev}:${st.ino}`;
        if (seenInodes.has(ik)) return;
        seenInodes.add(ik);
      }
      seen++;
      const size = Number(st.size);
      const list = bySize.get(size) || [];
      list.push({ path: f, size, mtime: Number(st.mtimeMs) });
      bySize.set(size, list);
    });
    onProgress?.({ phase: 'Listing files', done: seen });
  }
  return bySize;
}

async function quickHash(file, size) {
  const fh = await fsp.open(file, 'r');
  try {
    const h = crypto.createHash('sha256');
    h.update(String(size));
    const head = Buffer.alloc(Math.min(CHUNK, size));
    const { bytesRead: hn } = await fh.read(head, 0, head.length, 0);
    h.update(head.subarray(0, hn));
    if (size > CHUNK * 2) {
      const tail = Buffer.alloc(CHUNK);
      const { bytesRead: tn } = await fh.read(tail, 0, CHUNK, size - CHUNK);
      h.update(tail.subarray(0, tn));
    }
    return h.digest('hex');
  } finally {
    await fh.close();
  }
}

function fullHash(file, signal) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    if (signal?.aborted) return reject(new Error('aborted'));
    const s = fs.createReadStream(file, { highWaterMark: 1024 * 1024 });
    const onAbort = () => s.destroy(new Error('aborted'));
    signal?.addEventListener('abort', onAbort, { once: true });
    const done = () => signal?.removeEventListener('abort', onAbort);
    s.on('data', (d) => h.update(d));
    s.on('end', () => {
      done();
      resolve(h.digest('hex'));
    });
    s.on('error', (e) => {
      done();
      reject(e);
    });
  });
}

async function regroup(groups, hasher) {
  const out = [];
  for (const g of groups) {
    const map = new Map();
    const hashes = await mapLimit(g, 4, async (f) => {
      try {
        return await hasher(f);
      } catch {
        return null;
      }
    });
    g.forEach((f, i) => {
      if (!hashes[i]) return;
      const l = map.get(hashes[i]) || [];
      l.push(f);
      map.set(hashes[i], l);
    });
    for (const [hash, l] of map) if (l.length > 1) out.push(Object.assign(l, { hash }));
  }
  return out;
}

/**
 * @param {string[]} roots
 * @param {{minSize?:number, signal?:AbortSignal, onProgress?:Function}} [opts]
 * @returns {Promise<{groups:Array<{size:number, wasted:number, files:object[]}>, wasted:number}>}
 */
async function findDuplicates(roots, opts = {}) {
  const { minSize = 1024 * 1024, signal, onProgress } = opts;
  const bySize = await collect(normaliseRoots(roots || []), { minSize, signal, onProgress });
  let candidates = [...bySize.values()].filter((l) => l.length > 1);

  onProgress?.({ phase: 'Comparing file starts', done: 0, total: candidates.length });
  candidates = await regroup(candidates, (f) => quickHash(f.path, f.size));
  if (signal?.aborted) return { groups: [], wasted: 0, aborted: true };

  onProgress?.({ phase: 'Verifying full contents', done: 0, total: candidates.length });
  let done = 0;
  const confirmed = [];
  for (const g of candidates) {
    if (signal?.aborted) break;
    confirmed.push(...(await regroup([g], (f) => fullHash(f.path, signal))));
    onProgress?.({ phase: 'Verifying full contents', done: ++done, total: candidates.length });
  }

  const groups = confirmed
    .map((files) => ({
      hash: files.hash,
      size: files[0].size,
      wasted: files[0].size * (files.length - 1),
      // oldest first: usually the original you want to keep
      files: files.sort((a, b) => a.mtime - b.mtime),
    }))
    .sort((a, b) => b.wasted - a.wasted);
  return { groups, wasted: groups.reduce((n, g) => n + g.wasted, 0), aborted: !!signal?.aborted };
}

module.exports = { findDuplicates, normaliseRoots };
