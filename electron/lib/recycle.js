'use strict';
/**
 * Restore files that Reclaim sent to the Recycle Bin (the Ledger's [ undo ]).
 *
 * Windows keeps each recycled item as a pair in <drive>\$Recycle.Bin\<SID>\:
 *   $R<id>.<ext>  the data
 *   $I<id>.<ext>  metadata: format version, size, deletion time, original path
 * Restoring = moving $R back to the original path and removing $I, which is what
 * Explorer's "Restore" does. Reading $I directly avoids localized Shell verbs and
 * column names, and lets this be tested off Windows with synthetic files.
 */
const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const { execFile } = require('node:child_process');
const { isSame } = require('./safety');

/** Parse a $I file. Returns { size, deletedAt, original } or null. */
function parseIndexFile(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 24) return null;
  const version = Number(buf.readBigInt64LE(0));
  const size = Number(buf.readBigInt64LE(8));
  const filetime = buf.readBigInt64LE(16);
  const deletedAt = new Date(Number(filetime / 10000n - 11644473600000n));
  let name;
  if (version === 2) {
    if (buf.length < 28) return null;
    const chars = buf.readInt32LE(24);
    name = buf.toString('utf16le', 28, Math.min(buf.length, 28 + chars * 2));
  } else if (version === 1) {
    name = buf.toString('utf16le', 24, Math.min(buf.length, 24 + 520));
  } else {
    return null;
  }
  name = name.replace(/\u0000.*$/s, '');
  return name ? { size, deletedAt, original: name } : null;
}

/** Build a $I v2 buffer (used by tests). */
function buildIndexFile(original, size, date = new Date()) {
  const name = Buffer.from(original + '\u0000', 'utf16le');
  const buf = Buffer.alloc(28 + name.length);
  buf.writeBigInt64LE(2n, 0);
  buf.writeBigInt64LE(BigInt(size), 8);
  buf.writeBigInt64LE((BigInt(date.getTime()) + 11644473600000n) * 10000n, 16);
  buf.writeInt32LE(name.length / 2, 24);
  name.copy(buf, 28);
  return buf;
}

function currentSid() {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') return resolve(null);
    execFile('whoami', ['/user', '/fo', 'csv', '/nh'], { windowsHide: true }, (err, out = '') => {
      const m = !err && out.match(/"(S-1-[\d-]+)"/);
      resolve(m ? m[1] : null);
    });
  });
}

/** The current user's bin folder on the drive that holds `p`. */
async function binDirFor(p) {
  const sid = await currentSid();
  if (!sid) return null;
  return path.join(path.parse(path.resolve(p)).root, '$Recycle.Bin', sid);
}

/**
 * Restore `paths` (original locations) from the Recycle Bin.
 * @param {string[]} paths
 * @param {{binDirFor?:(p:string)=>Promise<string|null>}} [deps]
 * @returns {Promise<Array<{path:string, ok:boolean, error?:string}>>}
 */
async function restore(paths, deps = {}) {
  const locate = deps.binDirFor || binDirFor;
  const indexCache = new Map(); // binDir -> [{ iFile, rFile, original }]
  const out = [];
  for (const p of paths) {
    try {
      if (fs.existsSync(p)) throw new Error('A file already exists at the original location');
      const dir = await locate(p);
      if (!dir) throw new Error('Recycle Bin not found');
      if (!indexCache.has(dir)) {
        const names = await fsp.readdir(dir).catch(() => []);
        const entries = [];
        for (const n of names) {
          if (!n.startsWith('$I')) continue;
          const meta = parseIndexFile(await fsp.readFile(path.join(dir, n)).catch(() => null));
          if (meta) entries.push({ iFile: path.join(dir, n), rFile: path.join(dir, '$R' + n.slice(2)), ...meta });
        }
        // newest first, so the most recent deletion of a path wins
        entries.sort((a, b) => b.deletedAt - a.deletedAt);
        indexCache.set(dir, entries);
      }
      const list = indexCache.get(dir);
      const hit = list.find((e) => isSame(e.original, p) && fs.existsSync(e.rFile));
      if (!hit) throw new Error('Not in the Recycle Bin any more (it may have been emptied)');
      await fsp.mkdir(path.dirname(p), { recursive: true });
      await fsp.rename(hit.rFile, p);
      await fsp.unlink(hit.iFile).catch(() => {});
      list.splice(list.indexOf(hit), 1);
      out.push({ path: p, ok: true });
    } catch (e) {
      out.push({ path: p, ok: false, error: e.message });
    }
  }
  return out;
}

module.exports = { restore, parseIndexFile, buildIndexFile };
