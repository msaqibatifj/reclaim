'use strict';
/**
 * The Ledger: one receipt per completed action (DESIGN.md §6 "Ledger").
 * A receipt: { id, at, verb, bytes, items, subject, dest, note?, undo?: {kind, ...}, undone? }
 *   verb: Removed | Recycled | Moved | Moved back | Deleted old copy | Uninstaller started | Skipped | Restored
 */
const crypto = require('node:crypto');

function receipt(fields) {
  return { id: crypto.randomUUID(), at: new Date().toISOString(), bytes: 0, items: 0, subject: '', dest: '', ...fields };
}

function fmtBytes(n) {
  if (n == null) return '';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = Math.abs(n);
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i++;
  }
  return `${i >= 2 ? v.toFixed(1) : Math.round(v)} ${u[i]}`;
}

const csvCell = (v) => {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** Export receipts as plain text (aligned columns) or CSV. */
function exportReceipts(list, format = 'txt') {
  if (format === 'csv') {
    const rows = [['date', 'action', 'bytes', 'size', 'items', 'subject', 'destination', 'note']];
    for (const r of list) rows.push([r.at, r.verb, r.bytes || 0, fmtBytes(r.bytes), r.items || '', r.subject, r.dest, r.note || '']);
    return rows.map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
  }
  const lines = ['Reclaim ledger', ''];
  for (const r of list) {
    const d = new Date(r.at);
    const date = `${d.toISOString().slice(0, 10)} ${d.toTimeString().slice(0, 5)}`;
    lines.push(
      [date, r.verb.padEnd(20), fmtBytes(r.bytes).padStart(9), String(r.items || '').padStart(7), r.subject, r.dest ? `-> ${r.dest}` : '', r.note || '']
        .filter((x) => x !== '')
        .join('  '),
    );
  }
  return lines.join('\r\n') + '\r\n';
}

module.exports = { receipt, exportReceipts, fmtBytes };
