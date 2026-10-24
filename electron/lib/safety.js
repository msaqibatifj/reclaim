'use strict';
/**
 * Safety guard. Every destructive operation in Reclaim goes through this module.
 *
 * Rules:
 *  1. Cleaners may only delete *inside* an explicit root that they declare.
 *  2. A root can never be (or contain) a protected location: drive roots, Windows,
 *     Program Files, the user profile itself, or personal-data folders.
 *  3. Symlinks and junctions are never followed, only unlinked.
 *  4. Paths must be absolute and contain no traversal segments.
 */
const path = require('node:path');
const os = require('node:os');

const isWin = process.platform === 'win32';

const norm = (p) => {
  let r = path.resolve(p);
  if (isWin) r = r.toLowerCase();
  // strip trailing separator except for a bare root
  if (r.length > 1 && r.endsWith(path.sep) && path.parse(r).root !== r) r = r.slice(0, -1);
  return r;
};

const isSame = (a, b) => norm(a) === norm(b);

/** true if child is strictly inside parent */
function isInside(parent, child) {
  const p = norm(parent);
  const c = norm(child);
  if (p === c) return false;
  const withSep = p.endsWith(path.sep) ? p : p + path.sep;
  return c.startsWith(withSep);
}

/** Build the list of locations a cleaner may never delete (or delete an ancestor of). */
function protectedPaths(env = process.env, home = os.homedir()) {
  const list = [];
  const add = (p) => p && list.push(p);
  if (isWin) {
    const sysDrive = env.SystemDrive || 'C:';
    add(sysDrive + '\\');
    add(env.SystemRoot || sysDrive + '\\Windows');
    add(env.ProgramFiles || sysDrive + '\\Program Files');
    add(env['ProgramFiles(x86)'] || sysDrive + '\\Program Files (x86)');
    add(env.ProgramData || sysDrive + '\\ProgramData');
    add(sysDrive + '\\Users');
    add(sysDrive + '\\System Volume Information');
    add(sysDrive + '\\Recovery');
  } else {
    add('/');
    for (const p of ['/bin', '/boot', '/etc', '/lib', '/lib64', '/sbin', '/usr', '/var', '/opt', '/home', '/root', '/proc', '/sys', '/dev']) add(p);
  }
  add(home);
  add(path.join(home, 'AppData'));
  add(path.join(home, 'AppData', 'Local'));
  add(path.join(home, 'AppData', 'Roaming'));
  return list;
}

/** Folders that hold the user's own files. Cleaners never touch these. */
function personalFolders(home = os.homedir()) {
  return ['Documents', 'Desktop', 'Downloads', 'Pictures', 'Videos', 'Music', 'OneDrive'].map((n) => path.join(home, n));
}

class SafetyError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SafetyError';
  }
}

/**
 * Validate a cleaner root. Throws SafetyError when unsafe.
 * @param {string} root
 * @param {{env?:object, home?:string, extraProtected?:string[]}} [opts]
 */
function assertSafeRoot(root, opts = {}) {
  const home = opts.home || os.homedir();
  const env = opts.env || process.env;
  if (typeof root !== 'string' || !root) throw new SafetyError('Empty path');
  if (!path.isAbsolute(root)) throw new SafetyError(`Path must be absolute: ${root}`);
  if (root.split(/[\\/]/).includes('..')) throw new SafetyError(`Path traversal not allowed: ${root}`);

  const resolved = path.resolve(root);
  const parts = resolved.split(path.sep).filter(Boolean);
  if (parts.length < 2) throw new SafetyError(`Path too shallow: ${root}`);

  const prot = [...protectedPaths(env, home), ...(opts.extraProtected || [])];
  for (const p of prot) {
    // root is the protected folder itself, or an ancestor of it
    if (isSame(resolved, p) || isInside(resolved, p)) {
      throw new SafetyError(`Refusing to touch protected location: ${root}`);
    }
  }
  for (const p of personalFolders(home)) {
    if (isSame(resolved, p) || isInside(p, resolved) || isInside(resolved, p)) {
      throw new SafetyError(`Refusing to touch personal folder: ${root}`);
    }
  }
  return resolved;
}

/** Check that `target` is inside `root` (used for every file we delete). */
function assertInside(root, target) {
  if (!isInside(root, target)) throw new SafetyError(`${target} is outside ${root}`);
  return true;
}

module.exports = {
  isWin,
  norm,
  isSame,
  isInside,
  protectedPaths,
  personalFolders,
  assertSafeRoot,
  assertInside,
  SafetyError,
};
