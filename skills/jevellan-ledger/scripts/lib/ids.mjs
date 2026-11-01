// Task ids, worktree slugs and compact timestamps.

import crypto from 'node:crypto';

// Crockford base32: no I, L, O or U, so ids read aloud and typed by hand stay unambiguous.
export const BASE32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export const TASK_ID = /^T[0-9A-HJKMNP-TV-Z]{6}$/;

export function newTaskId(taken = new Set()) {
  for (let attempt = 0; attempt < 1000; attempt += 1) {
    const bytes = crypto.randomBytes(6);
    let id = 'T';
    for (const byte of bytes) id += BASE32[byte & 31];
    if (!taken.has(id)) return id;
  }
  throw new Error('could not find a free task id');
}

export function isTaskId(value) {
  return typeof value === 'string' && TASK_ID.test(value);
}

// "Add a How to run section!" -> "add-a-how-to-run-section", at most 40 characters, never empty.
export function slugify(title, max = 40) {
  const slug = String(title ?? '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const cut = slug.slice(0, max).replace(/-+$/g, '');
  return cut || 'task';
}

// "2026-11-02T01:14:09.312Z" -> "20261102T011409312Z", safe in file names.
export function compactTime(iso = new Date().toISOString()) {
  return iso.replace(/[-:.]/g, '');
}
