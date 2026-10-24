'use strict';
/**
 * Disk scanner. Walks a directory tree once and returns:
 *  - a size tree (kept to `maxDepth` levels so memory stays bounded on a full drive)
 *  - the N largest individual files
 *  - bytes per file category
 * Symlinks and junctions are never followed (avoids double counting and loops).
 */
const path = require('node:path');
const fsp = require('node:fs').promises;
const { mapLimit, safeReaddir, safeLstat } = require('./fsx');

// bigint stats: Windows file IDs are 64-bit and lose precision as plain numbers,
// and we need exact inode keys to count hard-linked files (e.g. WinSxS) only once.
const bigLstat = async (p) => {
  try {
    return await fsp.lstat(p, { bigint: true });
  } catch {
    return null;
  }
};

const CATEGORIES = {
  Video: ['.mp4', '.mkv', '.avi', '.mov', '.wmv', '.webm', '.flv', '.m4v'],
  Audio: ['.mp3', '.wav', '.flac', '.aac', '.ogg', '.m4a', '.wma'],
  Images: ['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp', '.tiff', '.heic', '.svg', '.psd', '.raw'],
  Archives: ['.zip', '.rar', '.7z', '.tar', '.gz', '.bz2', '.xz', '.iso', '.cab'],
  Documents: ['.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.txt', '.md', '.csv', '.json'],
  Code: ['.js', '.ts', '.jsx', '.tsx', '.py', '.java', '.c', '.cpp', '.cs', '.go', '.rs', '.html', '.css', '.ipynb'],
  'Disk images': ['.vhd', '.vhdx', '.vmdk', '.vdi', '.img', '.wim', '.esd'],
  Apps: ['.exe', '.dll', '.sys', '.msi', '.msix', '.apk', '.jar'],
  Logs: ['.log', '.dmp', '.etl', '.tmp'],
};
const EXT_TO_CAT = new Map();
for (const [cat, exts] of Object.entries(CATEGORIES)) for (const e of exts) EXT_TO_CAT.set(e, cat);
const categoryOf = (name) => EXT_TO_CAT.get(path.extname(name).toLowerCase()) || 'Other';

class MinHeap {
  constructor(cap) {
    this.cap = cap;
    this.a = [];
  }
  push(item) {
    const a = this.a;
    if (a.length < this.cap) {
      a.push(item);
      let i = a.length - 1;
      while (i > 0) {
        const p = (i - 1) >> 1;
        if (a[p].size <= a[i].size) break;
        [a[p], a[i]] = [a[i], a[p]];
        i = p;
      }
    } else if (item.size > a[0].size) {
      a[0] = item;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < a.length && a[l].size < a[m].size) m = l;
        if (r < a.length && a[r].size < a[m].size) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i], a[m]];
        i = m;
      }
    }
  }
  sortedDesc() {
    return [...this.a].sort((x, y) => y.size - x.size);
  }
}

/**
 * @param {string} root
 * @param {{maxDepth?:number, maxChildren?:number, topFiles?:number, signal?:AbortSignal,
 *          onProgress?:(p:{files:number,bytes:number,current:string})=>void}} [opts]
 */
async function scan(root, opts = {}) {
  const { maxDepth = 4, maxChildren = 150, topFiles = 100, signal, onProgress, onRow } = opts;
  const started = Date.now();
  const stats = { files: 0, dirs: 0, bytes: 0, errors: 0, hardlinks: 0 };
  const inodes = new Set();
  const heap = new MinHeap(topFiles);
  const cats = {};
  let lastEmit = 0;

  const tick = (current) => {
    if (!onProgress) return;
    const now = Date.now();
    if (now - lastEmit < 120) return;
    lastEmit = now;
    onProgress({ files: stats.files, bytes: stats.bytes, current });
  };

  async function walk(dir, depth) {
    const node = { name: path.basename(dir) || dir, path: dir, size: 0, files: 0, dir: true, children: [] };
    if (signal?.aborted) return node;
    tick(dir);
    stats.dirs++;

    const entries = await safeReaddir(dir);
    if (!entries) {
      stats.errors++;
      node.error = true;
      return node;
    }

    const fileEntries = [];
    const dirEntries = [];
    for (const e of entries) {
      if (e.isSymbolicLink()) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) dirEntries.push(full);
      else if (e.isFile()) fileEntries.push({ name: e.name, full });
    }

    const fileStats = await mapLimit(fileEntries, 32, async (f) => bigLstat(f.full));
    let looseSize = 0;
    let looseCount = 0;
    fileEntries.forEach((f, i) => {
      const st = fileStats[i];
      if (!st) {
        stats.errors++;
        return;
      }
      stats.files++;
      looseCount++;
      if (st.nlink > 1n && st.ino) {
        const key = `${st.dev}:${st.ino}`;
        if (inodes.has(key)) {
          stats.hardlinks++;
          return; // already counted under another name
        }
        inodes.add(key);
      }
      const size = Number(st.size);
      stats.bytes += size;
      looseSize += size;
      const cat = categoryOf(f.name);
      cats[cat] = (cats[cat] || 0) + size;
      heap.push({ path: f.full, name: f.name, size, mtime: Number(st.mtimeMs) });
    });

    // Recurse into subdirectories with bounded concurrency
    const subs = await mapLimit(dirEntries, 8, (d) => walk(d, depth + 1));

    let total = looseSize;
    let count = looseCount;
    for (const s of subs) {
      total += s.size;
      count += s.files;
    }
    node.size = total;
    node.files = count;
    // Stream finished top-level rows so the UI can fill its ghost table as results arrive.
    if (depth === 1 && onRow && !signal?.aborted) onRow({ name: node.name, path: node.path, size: total, files: count });

    if (depth < maxDepth) {
      const kids = subs.filter((s) => s.size > 0).sort((a, b) => b.size - a.size);
      node.children = kids.slice(0, maxChildren);
      const rest = kids.slice(maxChildren);
      const restSize = rest.reduce((n, k) => n + k.size, 0);
      if (looseSize > 0) {
        node.children.push({ name: '(files in this folder)', path: dir, size: looseSize, files: looseCount, dir: false, children: [] });
      }
      if (restSize > 0) {
        node.children.push({ name: `(${rest.length} smaller folders)`, path: dir, size: restSize, files: 0, dir: false, children: [] });
      }
      node.children.sort((a, b) => b.size - a.size);
    } else {
      // Past the depth limit we only keep the total; UI can drill in with another scan.
      node.truncated = subs.length > 0;
      node.children = [];
    }
    return node;
  }

  const rootStat = await safeLstat(root);
  if (!rootStat || !rootStat.isDirectory()) {
    throw new Error(`Not a readable folder: ${root}`);
  }
  const tree = await walk(path.resolve(root), 0);
  if (!tree.name || tree.name === path.parse(tree.path).root) tree.name = tree.path;
  return {
    root: tree.path,
    tree,
    topFiles: heap.sortedDesc(),
    categories: cats,
    stats: { ...stats, ms: Date.now() - started },
    aborted: !!signal?.aborted,
  };
}

module.exports = { scan, categoryOf, CATEGORIES };
