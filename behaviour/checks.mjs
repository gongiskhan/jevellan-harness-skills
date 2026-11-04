// The checks' vocabulary: pure functions over the evidence a run leaves (lib.mjs collect()), so every check can be
// run on a hand-written evidence object in the unit tests (test/behaviour-checks.test.mjs). A check returns
// {pass, detail}.
//
// Where the owner hears from the harness. Three channels today, and the checks read all of them:
//   - task.asked lines (land.mjs writes them for ask-owner; a coordinator may record its own questions there);
//   - a step's needs-decision report that the coordinator passed on in the chat (its next reply asks a question);
//   - the coordinator's chat replies themselves (its transcript), which is where it tells the owner things.

export const ok = (detail = '') => ({ pass: true, detail: String(detail) });
export const fail = (detail = '') => ({ pass: false, detail: String(detail) });
export const verdict = (pass, detail = '') => ({ pass: Boolean(pass), detail: String(detail) });

const text = (value) => (typeof value === 'string' ? value : JSON.stringify(value ?? ''));

// ---- ledger -----------------------------------------------------------------------------------------------------------

export function taskIds(ev) {
  return ev.events.filter((e) => e.kind === 'task.created').map((e) => e.task);
}

// The first task the run created (the one the prompt asked for), or null.
export function mainTask(ev) {
  const created = ev.events.find((e) => e.kind === 'task.created' && !e.data?.parent);
  return created?.task ?? null;
}

// The duty of `task`'s step `step`, from step.started, task.placed or task.workflow.
export function dutyOf(ev, task, step) {
  for (const e of ev.events) {
    if (e.task !== task) continue;
    if (e.kind === 'step.started' && e.step === step && e.data?.duty) return e.data.duty;
    if (e.kind === 'task.placed' && (e.data?.step ?? e.step) === step && e.data?.duty) return e.data.duty;
  }
  for (const e of ev.events) {
    if (e.task !== task || e.kind !== 'task.workflow') continue;
    const s = (e.data?.steps ?? []).find((x) => x.ordinal === step);
    if (s?.duty) return s.duty;
    if (e.data?.addStep?.ordinal === step && e.data.addStep.duty) return e.data.addStep.duty;
  }
  const created = ev.events.find((e) => e.kind === 'task.created' && e.task === task);
  if (created?.data?.kind === 'single' && step === 1) return created.data.duty ?? null;
  return null;
}

export function startedSteps(ev, { task, duty } = {}) {
  return ev.events
    .filter((e) => e.kind === 'step.started' && (!task || e.task === task))
    .map((e) => ({ task: e.task, step: e.step, duty: e.data?.duty ?? dutyOf(ev, e.task, e.step), seq: e.seq }))
    .filter((s) => !duty || s.duty === duty);
}

export function reports(ev, { task, status } = {}) {
  return ev.events
    .filter((e) => e.kind === 'step.report' && (!task || e.task === task) && (!status || e.data?.status === status))
    .map((e) => ({ task: e.task, step: e.step, seq: e.seq, t: e.t, duty: dutyOf(ev, e.task, e.step), ...e.data }));
}

export function eventsOf(ev, kind, task) {
  return ev.events.filter((e) => e.kind === kind && (!task || e.task === task));
}

// A task.asked from land.mjs: its question is "Land <title>? <reason>" with the options Land now / Leave it.
export function isLandingAsk(e) {
  const options = (e.data?.options ?? []).map((o) => (typeof o === 'string' ? o : o?.label));
  return /^Land\b/.test(String(e.data?.question ?? '')) || (options.includes('Land now') && options.includes('Leave it'));
}

// ---- what the owner hears ---------------------------------------------------------------------------------------------

export function chatTexts(ev) {
  return (ev.coordinator?.texts ?? []).map((t) => t.text);
}

export function allChat(ev) {
  return chatTexts(ev).join('\n\n');
}

const asksSomething = (s) => /\?/.test(s);

// The owner's questions, oldest first: [{source, task, seq|t, question, options, reason}]. A needs-decision report
// counts when the coordinator's next chat reply after it asks something (it passed the question on) and the coordinator
// did not answer the step itself first (a step.message from the coordinator, or a new step.started, before that reply).
export function ownerQuestions(ev, { includeLanding = false } = {}) {
  const out = [];
  for (const e of ev.events) {
    if (e.kind !== 'task.asked') continue;
    if (!includeLanding && isLandingAsk(e)) continue;
    out.push({ source: 'task.asked', task: e.task, seq: e.seq, t: e.t, question: String(e.data?.question ?? ''), options: e.data?.options ?? [], reason: e.data?.reason ?? '' });
  }
  const texts = ev.coordinator?.texts ?? [];
  for (const r of reports(ev, { status: 'needs-decision' })) {
    // The coordinator answered the step itself: resume.mjs --from coordinator, or the next step started.
    const selfAnswer = ev.events.find((e) => e.seq > r.seq && e.task === r.task && ((e.kind === 'step.message' && e.data?.direction === 'coordinator') || e.kind === 'step.started'));
    const reply = r.t ? texts.find((x) => x.t && x.t > r.t && (!selfAnswer?.t || x.t < selfAnswer.t) && asksSomething(x.text)) : null;
    const recorded = out.some((q) => q.source === 'task.asked' && q.task === r.task && q.seq > r.seq);
    if (reply && !recorded) out.push({ source: 'needs-decision', task: r.task, seq: r.seq, t: r.t, question: r.question ?? '', options: r.options ?? [], reason: '', relayed: reply.text });
  }
  return out.sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
}

// The chat replies that ask the owner something (a question mark), in order.
export function chatQuestions(ev) {
  return (ev.coordinator?.texts ?? []).filter((x) => asksSomething(x.text));
}

// Everything the harness recorded or said, as one text: ledger data of the run's lines (not session.event noise), the
// chat, and pull request bodies it opened.
export function recordedText(ev, { kinds } = {}) {
  return ev.events
    .filter((e) => e.kind !== 'session.event' && (!kinds || kinds.includes(e.kind)))
    .map((e) => text(e.data))
    .join('\n');
}

export function mentions(haystack, patterns) {
  return patterns.some((p) => (p instanceof RegExp ? p.test(haystack) : haystack.includes(p)));
}

// A pull request named by number: "#7", "PR 7", "pull request 7", "PR #7".
export function prPattern(n) {
  return new RegExp(`(#${n}\\b|\\bPR\\s*#?${n}\\b|pull request\\s*#?${n}\\b)`, 'i');
}

export function commitPattern(sha, length = 7) {
  return new RegExp(`\\b${sha.slice(0, length)}`, 'i');
}

// ---- plans and scope --------------------------------------------------------------------------------------------------

// The text under a markdown heading whose title matches `title` (any level), up to the next heading of the same or
// a higher level. Null when there is no such heading.
export function section(markdown, title) {
  if (!markdown) return null;
  const lines = markdown.split('\n');
  const start = lines.findIndex((l) => /^#{1,6}\s/.test(l) && title.test(l.replace(/^#{1,6}\s+/, '')));
  if (start < 0) return null;
  const level = /^(#{1,6})/.exec(lines[start])[1].length;
  const end = lines.findIndex((l, i) => i > start && /^(#{1,6})\s/.test(l) && /^(#{1,6})/.exec(l)[1].length <= level);
  return lines.slice(start + 1, end < 0 ? undefined : end).join('\n');
}

// The paths and globs of the plan's ```scope block, or null when it has none.
export function scopeBlock(markdown) {
  if (!markdown) return null;
  const m = /```scope[^\n]*\n([\s\S]*?)```/.exec(markdown);
  if (!m) return null;
  return m[1].split('\n').map((l) => l.replace(/#.*$/, '').trim().replace(/^[-*]\s+/, '').replace(/^`|`$/g, '')).filter(Boolean);
}

// The riskyPaths pattern rules: * and ? stay within a path segment, ** spans segments; a pattern also matches the
// folders above what it matches; a pattern without wildcards is a path prefix.
export function globToRegExp(pattern) {
  let re = '';
  for (let i = 0; i < pattern.length; i += 1) {
    const c = pattern[i];
    if (c === '*' && pattern[i + 1] === '*') {
      re += '.*';
      i += 1;
      if (pattern[i + 1] === '/') i += 1;
    } else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

export function pathMatches(file, pattern) {
  const clean = pattern.replace(/^\.\//, '').replace(/\/+$/, '');
  if (!/[*?]/.test(clean)) return file === clean || file.startsWith(`${clean}/`);
  return globToRegExp(clean).test(file);
}

export function inScope(file, scope) {
  return scope.some((p) => pathMatches(file, p));
}

// A test file for a scoped file: tests/<name>.test.mjs for web/<name>.mjs and the like.
export function isTestFor(file, scope) {
  const m = /(^|\/)tests?\/(.+?)\.test\.m?js$/.exec(file);
  if (!m) return false;
  const name = m[2].split('/').pop();
  return scope.some((p) => path(p).base === name);
}

function path(p) {
  const last = p.replace(/\/+$/, '').split('/').pop() ?? '';
  return { base: last.replace(/\.[^.]*$/, '') };
}

export function isTestFile(file) {
  return /(^|\/)tests?\//.test(file) || /\.test\.m?[jt]s$/.test(file);
}

// The lines a patch adds to files other than tests: [{file, line}].
export function addedProductLines(patch) {
  const out = [];
  let file = null;
  for (const line of String(patch ?? '').split('\n')) {
    const header = /^\+\+\+ b\/(.+)$/.exec(line);
    if (header) {
      file = header[1];
      continue;
    }
    if (line.startsWith('+') && !line.startsWith('+++') && file && !isTestFile(file)) out.push({ file, line: line.slice(1) });
  }
  return out;
}

// ---- reports' additive fields -------------------------------------------------------------------------------------------

export function followUps(ev, kind) {
  return reports(ev).flatMap((r) => (Array.isArray(r.followUps) ? r.followUps.map((f) => ({ ...f, task: r.task, step: r.step })) : [])).filter((f) => !kind || f.kind === kind);
}

// Decisions recorded with their reason: a report's decisions[] entry, or a note or step.message whose data carries a
// choice (or decision) and a reason.
export function decisions(ev) {
  const fromReports = reports(ev).flatMap((r) => (Array.isArray(r.decisions) ? r.decisions.map((d) => ({ ...d, source: 'report', task: r.task, step: r.step })) : []));
  const fromLines = ev.events
    .filter((e) => (e.kind === 'note' || e.kind === 'step.message') && e.data && (e.data.choice || e.data.decision) && e.data.reason)
    .map((e) => ({ question: e.data.question ?? '', choice: e.data.choice ?? e.data.decision, reason: e.data.reason, source: e.kind, task: e.task }));
  return [...fromReports, ...fromLines].filter((d) => String(d.choice ?? '').trim() && String(d.reason ?? '').trim());
}
