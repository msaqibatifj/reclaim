'use strict';
/** Small fs helpers: bounded concurrency, size walking, guarded deletion. */
const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const { assertInside } = require('./safety');

async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const idx = i++;
      if (idx >= items.length) return;
      results[idx] = await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
  return results;
}

async function safeLstat(p) {
  try {
    return await fsp.lstat(p);
  } catch {
    return null;
  }
}

async function safeReaddir(p) {
  try {
    return await fsp.readdir(p, { withFileTypes: true });
  } catch {
    return null;
  }
}

/** Total bytes under a directory. Never follows symlinks/junctions. */
async function dirSize(root, { signal } = {}) {
  let total = 0;
  const stack = [root];
  while (stack.length) {
    if (signal?.aborted) break;
    const dir = stack.pop();
    const entries = await safeReaddir(dir);
    if (!entries) continue;
    const files = [];
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) stack.push(full);
      else files.push(full);
    }
    const sizes = await mapLimit(files, 32, async (f) => (await safeLstat(f))?.size || 0);
    for (const s of sizes) total += s;
  }
  return total;
}

/**
 * Unlink a file. Read-only files (common in temp folders left by installers) fail with
 * EPERM on Windows; clear the read-only bit once and retry. Locked files still fail.
 */
async function unlinkFile(p) {
  try {
    await fsp.unlink(p);
  } catch (e) {
    if (e.code !== 'EPERM' && e.code !== 'EACCES') throw e;
    await fsp.chmod(p, 0o666);
    await fsp.unlink(p);
  }
}

/**
 * Delete the *contents* of `root` (never `root` itself).
 * Files newer than `olderThanMs` are kept. Anything locked/denied is skipped, not fatal.
 * With dryRun it only counts what would be freed.
 *
 * @returns {{freed:number, files:number, skipped:number, skippedBytes:number}}
 */
async function deleteContents(root, opts = {}) {
  const { olderThanMs = 0, dryRun = false, signal, match, shallowOnly = false } = opts;
  // When filtering by name or staying shallow we never remove directories.
  const keepDirs = shallowOnly || !!match;
  const cutoff = olderThanMs > 0 ? Date.now() - olderThanMs : Infinity;
  const out = { freed: 0, files: 0, skipped: 0, skippedBytes: 0 };

  async function walk(dir) {
    if (signal?.aborted) return true;
    const entries = await safeReaddir(dir);
    if (!entries) return false;
    let keptSomething = false;
    for (const e of entries) {
      if (signal?.aborted) return true;
      const full = path.join(dir, e.name);
      assertInside(root, full);

      if (e.isSymbolicLink()) {
        // remove the link itself, never what it points to
        if (!dryRun) {
          try {
            await fsp.unlink(full);
          } catch {
            try {
              await fsp.rmdir(full);
            } catch {
              out.skipped++;
              keptSomething = true;
            }
          }
        }
        continue;
      }

      if (e.isDirectory()) {
        if (shallowOnly) continue;
        const kept = await walk(full);
        if (!kept && !dryRun && !keepDirs) {
          try {
            await fsp.rmdir(full);
          } catch {
            keptSomething = true;
          }
        } else if (kept) {
          keptSomething = true;
        }
        continue;
      }

      const st = await safeLstat(full);
      if (!st) continue;
      if (match && !match(e.name, full)) {
        keptSomething = true;
        continue;
      }
      if (st.mtimeMs > cutoff) {
        keptSomething = true;
        continue;
      }
      if (dryRun) {
        out.freed += st.size;
        out.files++;
        continue;
      }
      try {
        await unlinkFile(full);
        out.freed += st.size;
        out.files++;
      } catch {
        out.skipped++;
        out.skippedBytes += st.size;
        keptSomething = true;
      }
    }
    return keptSomething;
  }

  await walk(root);
  return out;
}

module.exports = { mapLimit, safeLstat, safeReaddir, dirSize, deleteContents, unlinkFile };
