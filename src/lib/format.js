/**
 * Numbers and paths, matching File Explorer (DESIGN.md §4):
 * base-1024, KB MB GB TB, whole numbers below MB, one decimal from MB up.
 */
const UNITS = ['B', 'KB', 'MB', 'GB', 'TB'];

export function bytes(n) {
  if (n == null || Number.isNaN(n)) return '—';
  let i = 0;
  let v = Math.abs(n);
  while (v >= 1024 && i < UNITS.length - 1) {
    v /= 1024;
    i++;
  }
  const s = i >= 2 ? v.toFixed(1) : String(Math.round(v));
  return `${n < 0 ? '−' : ''}${s} ${UNITS[i]}`;
}

export const pct = (part, whole) => (whole ? Math.round((part / whole) * 100) : 0);

export const num = (n) => (n ?? 0).toLocaleString('en-US');

export function clock(ms) {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  return `${String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** "24 Oct 14:06" */
export function stamp(d) {
  const t = new Date(d);
  if (Number.isNaN(t.getTime())) return '—';
  return `${String(t.getDate()).padStart(2, '0')} ${MONTHS[t.getMonth()]} ${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}`;
}
/** "24 Oct 2026" */
export function day(d) {
  const t = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(t.getTime())) return '—';
  return `${String(t.getDate()).padStart(2, '0')} ${MONTHS[t.getMonth()]} ${t.getFullYear()}`;
}
/** Registry InstallDate "20260412" -> "12 Apr 2026" */
export function regDate(s) {
  const m = /^(\d{4})(\d{2})(\d{2})$/.exec(String(s || ''));
  return m ? day(new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))) : '—';
}

/**
 * Truncate a path in the middle, keeping the drive (and first folders) and the last folder:
 * C:\Users\saqib\AppData\Local\Temp -> C:\Users\saqib\…\Local\Temp
 */
export function midPath(p, max = 48) {
  if (!p || p.length <= max) return p || '';
  const sep = p.includes('\\') ? '\\' : '/';
  const parts = p.split(sep);
  const tail = [];
  let head = parts.slice(0, 3);
  for (let i = parts.length - 1; i >= 3; i--) {
    const candidate = [...head, '…', parts[i], ...tail].join(sep);
    if (candidate.length > max && tail.length) break;
    tail.unshift(parts[i]);
    if (candidate.length > max) break;
  }
  let out = [...head, '…', ...tail].join(sep);
  if (out.length > max) {
    head = parts.slice(0, 1);
    out = [...head, '…', tail[tail.length - 1]].join(sep);
  }
  return out.length < p.length ? out : p;
}

export const baseName = (p) => String(p || '').replace(/[\\/]+$/, '').split(/[\\/]/).pop();
