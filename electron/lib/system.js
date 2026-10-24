'use strict';
/** Windows system queries: drives, admin status, installed programs, hidden system files. */
const { execFile } = require('node:child_process');
const path = require('node:path');
const os = require('node:os');

const isWin = process.platform === 'win32';

function ps(command, { timeout = 30000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile(
      'powershell',
      // Force UTF-8 output so program names and drive labels with non-ASCII characters survive.
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; ${command}`],
      { windowsHide: true, timeout, maxBuffer: 32 * 1024 * 1024 },
      (err, stdout) => (err ? reject(err) : resolve(stdout)),
    );
  });
}

function parseJsonList(text) {
  const t = text.trim();
  if (!t) return [];
  const v = JSON.parse(t);
  return Array.isArray(v) ? v : [v];
}

async function getDrives() {
  if (!isWin) {
    const fs = require('node:fs/promises');
    const s = await fs.statfs('/');
    const size = Number(s.blocks) * Number(s.bsize);
    const free = Number(s.bavail) * Number(s.bsize);
    return [{ letter: '/', label: 'Root', size, free, type: 'Fixed', system: true }];
  }
  const out = await ps(
    "Get-CimInstance Win32_LogicalDisk | Where-Object { $_.DriveType -in 2,3 } | Select-Object DeviceID, VolumeName, Size, FreeSpace, DriveType, FileSystem | ConvertTo-Json -Compress",
  );
  const sys = (process.env.SystemDrive || 'C:').toUpperCase();
  return parseJsonList(out)
    .filter((d) => d.Size)
    .map((d) => ({
      letter: d.DeviceID,
      label: d.VolumeName || (d.DriveType === 2 ? 'Removable' : 'Local Disk'),
      size: Number(d.Size),
      free: Number(d.FreeSpace),
      type: d.DriveType === 2 ? 'Removable' : 'Fixed',
      fs: d.FileSystem,
      system: d.DeviceID.toUpperCase() === sys,
    }));
}

function isAdmin() {
  if (!isWin) return Promise.resolve(process.getuid?.() === 0);
  // "net session" only succeeds in an elevated process
  return new Promise((resolve) => execFile('net', ['session'], { windowsHide: true }, (err) => resolve(!err)));
}

/**
 * Sizes of hiberfil.sys / pagefile.sys / swapfile.sys.
 * PowerShell cannot stat these locked files, but "dir /a:s" can list them.
 */
function systemFiles(drive = process.env.SystemDrive || 'C:') {
  if (!isWin) return Promise.resolve([]);
  return new Promise((resolve) => {
    execFile('cmd', ['/d', '/c', 'dir', `${drive}\\`, '/a:s', '/-c'], { windowsHide: true }, (err, stdout = '') => {
      const out = [];
      for (const line of stdout.split(/\r?\n/)) {
        const m = line.match(/\s(\d+)\s+(hiberfil\.sys|pagefile\.sys|swapfile\.sys)\s*$/i);
        if (m) out.push({ name: m[2].toLowerCase(), path: `${drive}\\${m[2]}`, size: Number(m[1]) });
      }
      resolve(out);
    });
  });
}

const UNINSTALL_KEYS = [
  'HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*',
  'HKLM:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*',
  'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*',
];

async function installedPrograms() {
  if (!isWin) return [];
  const keys = UNINSTALL_KEYS.map((k) => `'${k}'`).join(',');
  const out = await ps(
    `Get-ItemProperty ${keys} -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -and -not $_.SystemComponent -and -not $_.ParentKeyName } | Select-Object DisplayName, DisplayVersion, Publisher, EstimatedSize, InstallLocation, InstallDate, UninstallString, QuietUninstallString, PSChildName | ConvertTo-Json -Compress`,
    { timeout: 60000 },
  );
  const seen = new Set();
  return parseJsonList(out)
    .map((p) => ({
      id: p.PSChildName,
      name: p.DisplayName,
      version: p.DisplayVersion || '',
      publisher: p.Publisher || '',
      size: p.EstimatedSize ? Number(p.EstimatedSize) * 1024 : 0, // registry stores KB
      location: p.InstallLocation || '',
      installDate: p.InstallDate || '',
      uninstall: normalizeUninstall(p.UninstallString),
    }))
    .filter((p) => {
      const k = `${p.name}|${p.version}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .sort((a, b) => b.size - a.size);
}

/** Lower-case executable names of running processes (to mark cache items as locked). */
function runningProcesses() {
  return new Promise((resolve) => {
    if (isWin) {
      execFile('tasklist', ['/fo', 'csv', '/nh'], { windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (err, out = '') => {
        const set = new Set();
        if (!err) for (const line of out.split(/\r?\n/)) {
          const m = line.match(/^"([^"]+)"/);
          if (m) set.add(m[1].toLowerCase());
        }
        resolve([...set]);
      });
    } else {
      execFile('ps', ['-A', '-o', 'comm='], (err, out = '') => resolve(err ? [] : [...new Set(out.split('\n').map((l) => path.basename(l.trim()).toLowerCase()).filter(Boolean))]));
    }
  });
}

/**
 * Make a registry UninstallString runnable through `cmd /s /c "..."`:
 *  - MSI entries often use /I (opens the repair/modify dialog); /X uninstalls.
 *  - Many installers register an unquoted path with spaces, which cmd would split.
 */
function normalizeUninstall(cmd) {
  let c = String(cmd || '').trim();
  if (!c) return '';
  c = c.replace(/^(msiexec(?:\.exe)?\s+)\/i\s*(\{[0-9a-f-]+\})/i, '$1/X$2');
  if (!c.startsWith('"')) {
    const m = c.match(/^([a-z]:\\[^"]*?\.exe)(\s.*)?$/i);
    if (m && /\s/.test(m[1])) c = `"${m[1]}"${m[2] || ''}`;
  }
  return c;
}

/** Default folders to search for duplicates. */
function defaultUserFolders(home = os.homedir()) {
  return ['Desktop', 'Documents', 'Downloads', 'Pictures', 'Videos', 'Music'].map((n) => path.join(home, n));
}

module.exports = { getDrives, isAdmin, systemFiles, installedPrograms, defaultUserFolders, normalizeUninstall, runningProcesses, ps, isWin };
