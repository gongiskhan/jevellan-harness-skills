// The report contract a worker writes to .jevellan/report.json, ported from the skills repo's report.ts (where
// zod checked it). Hand-written so nothing needs dependencies. validateReport returns the first problem as one
// sentence, which the Stop hook hands back to the worker word for word. fitReportLine fits a report to one ledger
// line, for the Stop hook and the Codex runner that record it.

import path from 'node:path';
import { MAX_LINE } from './ledger.mjs';
import { redactValue } from './redact.mjs';

export const STATUSES = ['progress', 'done', 'blocked', 'needs-decision'];
export const LIMITS = {
  summary: 4000,
  question: 1000,
  optionsMin: 2,
  optionsMax: 4,
  label: 120,
  description: 300,
  testsSummary: 600,
  command: 4000,
  changedFiles: 200,
  path: 1024,
  screenshots: 50,
  caption: 300,
  limitations: 4000,
  ownerCommands: 5,
  why: 300,
  decisions: 10,
  followUps: 10,
  decisionText: 600,
  followUpText: 600,
};

// decisions[]: a choice the worker made itself (in scope, reversible, outside the project's risky paths), with its
// reason, so the coordinator can tell the owner in one sentence. followUps[]: something found that is not this
// task's to fix: a failure outside the task's scope, a host problem, or work outside the plan's scope.
export const FOLLOW_UP_KINDS = ['unrelated-failure', 'host', 'scope'];

const KEYS = ['status', 'summary', 'question', 'options', 'testsRun', 'changedFiles', 'screenshots', 'limitations', 'ownerCommands', 'decisions', 'followUps'];

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isText = (value) => typeof value === 'string' && value.trim().length > 0;

function unknownKey(object, allowed, where) {
  const extra = Object.keys(object).find((key) => !allowed.includes(key));
  return extra === undefined ? null : `${where} has an unknown field "${extra}"`;
}

// Lenient fixes applied before validation: an over-long summary is cut rather than refused, and a limitations
// list of strings becomes one text. Everything else must already be right.
export function normalizeReport(report) {
  if (!isObject(report)) return report;
  const out = { ...report };
  if (typeof out.summary === 'string') out.summary = cutText(out.summary, LIMITS.summary);
  if (Array.isArray(out.limitations) && out.limitations.every((item) => typeof item === 'string')) {
    out.limitations = out.limitations.join('\n');
  }
  if (typeof out.limitations === 'string') out.limitations = cutText(out.limitations, LIMITS.limitations);
  return out;
}

// `text` cut to at most `max` UTF-16 units, ending in "…" when it was cut, never between the two halves of a
// surrogate pair (an emoji cut in half is not a character).
export function cutText(text, max) {
  if (text.length <= max) return text;
  if (max <= 0) return '';
  let end = max - 1;
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return `${text.slice(0, end)}…`;
}

export function validateReport(input) {
  const report = normalizeReport(input);
  const problem = firstProblem(report);
  return problem ? { ok: false, problem: `report.json: ${problem}` } : { ok: true, report };
}

function firstProblem(r) {
  if (!isObject(r)) return 'must be one JSON object';
  const extra = unknownKey(r, KEYS, 'the report');
  if (extra) return extra;
  if (!STATUSES.includes(r.status)) return `status must be one of ${STATUSES.join(', ')}`;
  if (!isText(r.summary)) return 'summary must be a non-empty text';
  if (r.summary.length > LIMITS.summary) return `summary must be at most ${LIMITS.summary} characters`;

  if (r.status === 'needs-decision') {
    if (!isText(r.question)) return 'question is required when status is needs-decision';
    if (!Array.isArray(r.options)) return 'options are required when status is needs-decision';
  }
  if (r.question !== undefined) {
    if (!isText(r.question)) return 'question must be a non-empty text';
    if (r.question.length > LIMITS.question) return `question must be at most ${LIMITS.question} characters`;
  }
  if (r.options !== undefined) {
    if (!Array.isArray(r.options) || r.options.length < LIMITS.optionsMin || r.options.length > LIMITS.optionsMax) {
      return `options must have ${LIMITS.optionsMin} to ${LIMITS.optionsMax} items`;
    }
    for (const [index, option] of r.options.entries()) {
      if (!isObject(option)) return `options[${index}] must be an object with a label`;
      const bad = unknownKey(option, ['label', 'description'], `options[${index}]`);
      if (bad) return bad;
      if (!isText(option.label)) return `options[${index}].label must be a non-empty text`;
      if (option.label.length > LIMITS.label) return `options[${index}].label must be at most ${LIMITS.label} characters`;
      if (option.description !== undefined && typeof option.description !== 'string') {
        return `options[${index}].description must be a text`;
      }
      if (typeof option.description === 'string' && option.description.length > LIMITS.description) {
        return `options[${index}].description must be at most ${LIMITS.description} characters`;
      }
    }
  }
  if (r.testsRun !== undefined) {
    const t = r.testsRun;
    if (!isObject(t)) return 'testsRun must be an object with command, passed and summary';
    const bad = unknownKey(t, ['command', 'passed', 'summary'], 'testsRun');
    if (bad) return bad;
    if (!isText(t.command)) return 'testsRun.command must be a non-empty text';
    if (t.command.length > LIMITS.command) return `testsRun.command must be at most ${LIMITS.command} characters`;
    if (typeof t.passed !== 'boolean') return 'testsRun.passed must be true or false';
    if (typeof t.summary !== 'string') return 'testsRun.summary must be a text';
    if (t.summary.length > LIMITS.testsSummary) return `testsRun.summary must be at most ${LIMITS.testsSummary} characters`;
  }
  if (r.changedFiles !== undefined) {
    if (!Array.isArray(r.changedFiles)) return 'changedFiles must be a list of paths';
    if (r.changedFiles.length > LIMITS.changedFiles) return `changedFiles must have at most ${LIMITS.changedFiles} items`;
    const index = r.changedFiles.findIndex((file) => !isText(file) || file.length > LIMITS.path);
    if (index >= 0) return `changedFiles[${index}] must be a path of at most ${LIMITS.path} characters`;
  }
  if (r.screenshots !== undefined) {
    if (!Array.isArray(r.screenshots)) return 'screenshots must be a list of {path, caption}';
    if (r.screenshots.length > LIMITS.screenshots) return `screenshots must have at most ${LIMITS.screenshots} items`;
    for (const [index, shot] of r.screenshots.entries()) {
      if (!isObject(shot)) return `screenshots[${index}] must be an object with path and caption`;
      const bad = unknownKey(shot, ['path', 'caption'], `screenshots[${index}]`);
      if (bad) return bad;
      if (!isText(shot.path) || shot.path.length > LIMITS.path) return `screenshots[${index}].path must be a path`;
      const normal = path.posix.normalize(shot.path.replace(/\\/g, '/'));
      const relativeOk = !normal.startsWith('/') && normal.startsWith('.jevellan/evidence/');
      const absoluteOk = normal.startsWith('/') && normal.includes('/.jevellan/evidence/');
      if (shot.path.split(/[\\/]/).includes('..') || !(relativeOk || absoluteOk)) {
        return `screenshots[${index}].path must be under .jevellan/evidence/`;
      }
      if (!isText(shot.caption) || shot.caption.length > LIMITS.caption) {
        return `screenshots[${index}].caption must be a text of at most ${LIMITS.caption} characters`;
      }
    }
  }
  if (r.limitations !== undefined) {
    if (typeof r.limitations !== 'string') return 'limitations must be a text';
  }
  if (r.ownerCommands !== undefined) {
    if (!Array.isArray(r.ownerCommands)) return 'ownerCommands must be a list of {command, cwd, why}';
    if (r.ownerCommands.length > LIMITS.ownerCommands) return `ownerCommands must have at most ${LIMITS.ownerCommands} items`;
    for (const [index, item] of r.ownerCommands.entries()) {
      if (!isObject(item)) return `ownerCommands[${index}] must be an object with command, cwd and why`;
      const bad = unknownKey(item, ['command', 'cwd', 'why'], `ownerCommands[${index}]`);
      if (bad) return bad;
      if (!isText(item.command) || item.command.length > LIMITS.command) return `ownerCommands[${index}].command must be a non-empty text`;
      if (!isText(item.cwd) || !(['worktree', 'checkout', 'home'].includes(item.cwd) || item.cwd.startsWith('/'))) {
        return `ownerCommands[${index}].cwd must be worktree, checkout, home or an absolute folder`;
      }
      if (!isText(item.why) || item.why.length > LIMITS.why) return `ownerCommands[${index}].why must say why, in at most ${LIMITS.why} characters`;
    }
  }
  if (r.decisions !== undefined) {
    if (!Array.isArray(r.decisions)) return 'decisions must be a list of {question, choice, options, reason, reversible}';
    if (r.decisions.length > LIMITS.decisions) return `decisions must have at most ${LIMITS.decisions} items`;
    for (const [index, d] of r.decisions.entries()) {
      if (!isObject(d)) return `decisions[${index}] must be an object with question, choice, options, reason and reversible`;
      const bad = unknownKey(d, ['question', 'choice', 'options', 'reason', 'reversible'], `decisions[${index}]`);
      if (bad) return bad;
      for (const key of ['question', 'choice', 'reason']) {
        if (!isText(d[key]) || d[key].length > LIMITS.decisionText) return `decisions[${index}].${key} must be a non-empty text of at most ${LIMITS.decisionText} characters`;
      }
      if (d.options !== undefined && (!Array.isArray(d.options) || d.options.length > LIMITS.optionsMax + 2 || !d.options.every((o) => isText(o) && o.length <= LIMITS.label * 2))) {
        return `decisions[${index}].options must be a list of up to ${LIMITS.optionsMax + 2} short texts`;
      }
      if (typeof d.reversible !== 'boolean') return `decisions[${index}].reversible must be true or false`;
    }
  }
  if (r.followUps !== undefined) {
    if (!Array.isArray(r.followUps)) return 'followUps must be a list of {kind, title, evidence, cause}';
    if (r.followUps.length > LIMITS.followUps) return `followUps must have at most ${LIMITS.followUps} items`;
    for (const [index, f] of r.followUps.entries()) {
      if (!isObject(f)) return `followUps[${index}] must be an object with kind, title, evidence and cause`;
      const bad = unknownKey(f, ['kind', 'title', 'evidence', 'cause'], `followUps[${index}]`);
      if (bad) return bad;
      if (!FOLLOW_UP_KINDS.includes(f.kind)) return `followUps[${index}].kind must be one of ${FOLLOW_UP_KINDS.join(', ')}`;
      for (const key of ['title', 'evidence', 'cause']) {
        if (!isText(f[key]) || f[key].length > LIMITS.followUpText) return `followUps[${index}].${key} must be a non-empty text of at most ${LIMITS.followUpText} characters`;
      }
    }
  }
  return null;
}

// ---- one report, one ledger line ------------------------------------------------------------------------------

// A step.report line must stay under the ledger's 64 KB line rule. The envelope around the data (seq, time, kind,
// task, step, session) takes a few hundred bytes; the rest of the margin is slack.
export const REPORT_LINE_BYTES = MAX_LINE - 4096;
// Cut in this order when a report does not fit, and put back in this order as far as room allows. The owner's
// commands come before the rest of the changed files; the first changed file is always kept, because the ledger's
// projection reads a write duty's changed files as work still to land.
const CUT_LISTS = ['changedFiles', 'ownerCommands', 'screenshots'];

const bytes = (value) => Buffer.byteLength(JSON.stringify(value));

// The data of a step.report line, redacted the way the ledger writes it and fitted to REPORT_LINE_BYTES. A report
// that fits comes back as it is. One that does not (a schema-valid report can pass 64 KB: 200 long paths, 50
// screenshots, 4000-character texts in a 3-byte script) keeps status, summary, question, options and testsRun whole,
// cuts changedFiles, ownerCommands, screenshots and limitations to what fits, and says so: trimmed: true,
// originalCounts (list lengths, limitations in characters), and a last paragraph of limitations naming the archived
// file (data.reportFile) that holds the full report.
export function fitReportLine(input, { maxBytes = REPORT_LINE_BYTES } = {}) {
  const data = redactValue(input);
  if (bytes(data) <= maxBytes) return data;
  const originalCounts = {};
  for (const key of CUT_LISTS) if (Array.isArray(data[key])) originalCounts[key] = data[key].length;
  if (typeof data.limitations === 'string') originalCounts.limitations = data.limitations.length;
  const note = `This ledger line was cut to fit 64 KB; the full report is ${data.reportFile || 'the archived report file'}.`;
  const out = { ...data, trimmed: true, originalCounts };
  for (const key of CUT_LISTS) if (key in originalCounts) out[key] = [];
  if (data.changedFiles?.length) out.changedFiles = data.changedFiles.slice(0, 1);
  out.limitations = note;
  shrinkKept(out, maxBytes);
  const fill = (key, items) => {
    let room = maxBytes - bytes(out);
    for (const item of items) {
      const cost = bytes(item) + 1;
      if (cost > room) return;
      out[key].push(item);
      room -= cost;
    }
  };
  if (Array.isArray(data.ownerCommands)) fill('ownerCommands', data.ownerCommands);
  if (Array.isArray(data.changedFiles)) fill('changedFiles', data.changedFiles.slice(1));
  if (Array.isArray(data.screenshots)) fill('screenshots', data.screenshots);
  const text = data.limitations;
  if (text) {
    // The longest start of the worker's limitations that still fits in front of the note.
    const room = maxBytes - bytes(out);
    const withNote = (n) => `${cutText(text, n)}\n\n${note}`;
    let lo = 0;
    let hi = text.length;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (bytes(withNote(mid)) - bytes(note) <= room) lo = mid;
      else hi = mid - 1;
    }
    if (lo > 0) out.limitations = withNote(lo);
  }
  return out;
}

// The kept fields are bounded by the schema to well under the budget for any text a worker writes; only thousands of
// characters that JSON escapes to six bytes each can push them over. Then the longest of them is halved until the
// line fits, so a valid report is never refused for its size.
function shrinkKept(out, maxBytes) {
  if (out.testsRun && typeof out.testsRun === 'object') out.testsRun = { ...out.testsRun };
  if (Array.isArray(out.options)) out.options = out.options.map((option) => (option && typeof option === 'object' ? { ...option } : option));
  while (bytes(out) > maxBytes) {
    let longest = null;
    const consider = (object, key) => {
      const value = object?.[key];
      if (typeof value !== 'string' || value.length < 2) return;
      const size = bytes(value);
      if (!longest || size > longest.size) longest = { object, key, size };
    };
    consider(out, 'summary');
    consider(out, 'question');
    consider(out.testsRun, 'command');
    consider(out.testsRun, 'summary');
    for (const option of out.options ?? []) {
      consider(option, 'label');
      consider(option, 'description');
    }
    if (!longest) return;
    const value = longest.object[longest.key];
    longest.object[longest.key] = cutText(value, Math.ceil(value.length / 2));
  }
}
