// How ledger lines read for people and for a session's context: one line per event, reports rendered in full.

const clip = (text, max) => {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

export function clock(iso) {
  return typeof iso === 'string' ? iso.slice(11, 19) : '--:--:--';
}

export function detail(event) {
  const d = event.data ?? {};
  switch (event.kind) {
    case 'task.created':
      return `${d.kind}${d.duty ? ` ${d.duty}` : ''}: ${clip(d.title, 100)}${d.parent ? ` (parent ${d.parent})` : ''}${d.after ? ` (after ${d.after})` : ''}`;
    case 'task.worktree':
      return `${d.branch} at ${d.path}`;
    case 'task.workflow':
      return `steps ${(d.steps ?? []).map((s) => `${s.ordinal} ${s.duty}`).join(', ')}${d.skipped?.length ? `; skipped ${d.skipped.join(', ')}` : ''}`;
    case 'task.placed':
      return `step ${d.step}: ${d.model} ${d.effort} via ${d.provider} (${d.source ?? 'jev'}${d.probabilities?.model ? `, p ${formatP(d.probabilities.model)}` : ''})`;
    case 'step.started':
      return `${d.duty} on ${d.model} ${d.effort} via ${d.provider} (${d.runtime}, pid ${d.pid})`;
    case 'step.message':
      return `${d.direction}: ${clip(d.text, 140)}`;
    case 'step.report':
      return `${d.status}${d.synthesized ? ' (synthesized)' : ''}: ${clip(d.summary, 160)}${d.question ? ` | Q: ${clip(d.question, 120)}` : ''}${d.decisions?.length ? ` | ${d.decisions.length} decision(s)` : ''}${d.followUps?.length ? ` | ${d.followUps.length} follow-up(s)` : ''}`;
    case 'step.done':
      return `step ${d.ordinal ?? event.step} done`;
    case 'step.failed':
      return `step ${d.ordinal ?? event.step} failed: ${clip(d.reason, 140)}`;
    case 'step.retrying':
      return `step ${d.ordinal} attempt ${d.attempt}, back to step ${d.gotoOrdinal}: ${clip(d.reason, 120)}`;
    case 'step.lost':
      return `step ${d.ordinal ?? event.step} lost (pid ${d.pid})`;
    case 'step.stopped':
      return `step ${d.ordinal ?? event.step} stopped: ${clip(d.reason, 120)}`;
    case 'session.event':
      return `${d.tool}: ${clip(d.summary, 140)}`;
    case 'session.started':
      return `${d.role} ${d.nativeSessionId ?? ''} ${d.model ?? ''}`.trim();
    case 'session.ended':
      return `${d.nativeSessionId ?? ''} ${d.reason ?? ''}`.trim();
    case 'landing.decided':
      return `${d.route}${d.probabilities ? ` (p ${formatP(d.probabilities[d.route])})` : ''}: ${clip(d.reason, 140)}`;
    case 'landing.checked':
      return `${d.passed ? 'passed' : 'FAILED'}: ${clip(d.command, 100)}`;
    case 'task.landed':
      if (d.pr) return `pull request ${d.pr}${d.merged ? ' (merged)' : ''}${d.commit ? ` at ${String(d.commit).slice(0, 12)}` : ''}`;
      return `commit ${String(d.commit ?? '').slice(0, 12)}${d.target ? ` on ${d.target}` : ''}`;
    case 'task.asked':
      return `${d.source === 'coordinator' ? 'Question: ' : ''}${clip(d.question, 120)} [${(d.options ?? []).map((o) => (typeof o === 'string' ? o : o.label)).join(' | ')}]${d.recommended ? ` recommended: ${d.recommended}` : ''}`;
    case 'note':
      return clip(d.text, 160);
    default:
      return clip(JSON.stringify(d), 160);
  }
}

function formatP(p) {
  return typeof p === 'number' ? p.toFixed(2) : '?';
}

export function oneLine(event) {
  const where = [event.task, event.step ? `s${event.step}` : null].filter(Boolean).join(' ');
  return `#${event.seq} ${clock(event.t)} ${event.kind}${where ? ` ${where}` : ''} ${detail(event)}`.trimEnd();
}

export function renderReport(event) {
  const d = event.data ?? {};
  const lines = [`Report of ${event.task} step ${event.step} (#${event.seq}, ${event.t}): ${d.status}${d.synthesized ? ' (synthesized by the hook)' : ''}`];
  lines.push(String(d.summary ?? '').trim());
  if (d.question) lines.push(`Question: ${d.question}`);
  for (const [index, option] of (d.options ?? []).entries()) {
    lines.push(`  ${index + 1}. ${option.label}${option.description ? ` - ${option.description}` : ''}`);
  }
  if (d.testsRun) lines.push(`Tests: ${d.testsRun.command} -> ${d.testsRun.passed ? 'passed' : 'FAILED'}. ${d.testsRun.summary ?? ''}`.trim());
  if (d.changedFiles?.length) lines.push(`Changed files: ${d.changedFiles.join(', ')}`);
  for (const shot of d.screenshots ?? []) lines.push(`Screenshot: ${shot.path} - ${shot.caption}`);
  if (d.limitations) lines.push(`Limitations: ${d.limitations}`);
  for (const command of d.ownerCommands ?? []) lines.push(`Owner command (${command.cwd}): ${command.command} - ${command.why}`);
  if (d.reportFile) lines.push(`Report file: ${d.reportFile}`);
  return lines.filter(Boolean).join('\n');
}
