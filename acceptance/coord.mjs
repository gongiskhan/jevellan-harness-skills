// The coordinator journeys' harness: an interactive `claude --permission-mode bypassPermissions` in the tmux session
// jh-coord (this run's own session; no other tmux session is ever typed into), under the owner's own login, in the
// project folder. Messages are pasted as one bracketed paste. The coordinator's transcript is read from the owner's
// ~/.claude/projects/<folder slug>/<session id>.jsonl to list every Skill invocation and every slip: a point where the
// coordinator did what a skill should have done.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { NODE, sleep } from './lib.mjs';

export const SESSION = 'jh-coord';
const TARGET = `=${SESSION}:`;

function tmux(args, input) {
  return spawnSync('tmux', args, { encoding: 'utf8', input });
}

export function exists() {
  return tmux(['has-session', '-t', `=${SESSION}`]).status === 0;
}

export function capture(lines = 400) {
  return tmux(['capture-pane', '-p', '-J', '-t', TARGET, '-S', `-${lines}`]).stdout ?? '';
}

export function transcriptFile(dir, session) {
  return path.join(os.userInfo().homedir, '.claude', 'projects', fs.realpathSync(dir).replace(/[^A-Za-z0-9]/g, '-'), `${session}.jsonl`);
}

// Starts the coordinator in `dir`. Returns {session, transcript}. Refuses when jh-coord already exists.
export async function start(dir, { resume } = {}) {
  if (exists()) throw new Error('the tmux session jh-coord already exists; stop it first');
  const session = resume ?? crypto.randomUUID();
  const node22 = path.dirname(NODE);
  const pathValue = `${node22}:${process.env.PATH}`;
  const command = `claude --permission-mode bypassPermissions ${resume ? `--resume ${session}` : `--session-id ${session}`}`;
  const r = tmux(['new-session', '-d', '-s', SESSION, '-x', '220', '-y', '60', '-c', dir, '-e', `PATH=${pathValue}`, command]);
  if (r.status !== 0) throw new Error(`tmux new-session: ${r.stderr}`);
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    await sleep(1000);
    const screen = capture(80);
    // The workspace trust dialog defaults to "No, exit"; move to "Yes, I trust this folder" first.
    if (/Yes, I trust this folder/i.test(screen)) {
      tmux(['send-keys', '-t', TARGET, 'Down']);
      await sleep(400);
      if (/\u276f\s*Yes, I trust this folder/.test(capture(30))) tmux(['send-keys', '-t', TARGET, 'Enter']);
      continue;
    }
    if (/for shortcuts|bypass permissions on|❯/i.test(screen) && !/Loading|Starting/.test(screen.split('\n').slice(-5).join('\n'))) {
      await sleep(1500);
      return { session, transcript: transcriptFile(dir, session) };
    }
  }
  throw new Error(`the coordinator did not reach its prompt:\n${capture(40)}`);
}

export async function send(text) {
  tmux(['load-buffer', '-b', 'jh-coord-msg', '-'], text);
  tmux(['paste-buffer', '-p', '-d', '-b', 'jh-coord-msg', '-t', TARGET]);
  await sleep(700);
  tmux(['send-keys', '-t', TARGET, 'Enter']);
}

export async function stop() {
  if (!exists()) return 'not running';
  await send('/exit');
  for (let i = 0; i < 20; i += 1) {
    await sleep(500);
    if (!exists()) return 'exited';
  }
  tmux(['kill-session', '-t', `=${SESSION}`]);
  return 'killed';
}

// Kills the coordinator's process without /exit (a crash), for the restart journey.
export function kill() {
  if (!exists()) return false;
  const pid = Number(tmux(['display-message', '-p', '-t', TARGET, '#{pane_pid}']).stdout.trim());
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {}
  }
  tmux(['kill-session', '-t', `=${SESSION}`]);
  return true;
}

// A heredoc's body is data (a brief, a JSON file), not commands: keep the line that opens it, drop the body.
export function stripHeredocs(command) {
  const out = [];
  let end = null;
  for (const line of command.split('\n')) {
    if (end !== null) {
      if (line.replace(/^\t+/, '').trim() === end) end = null;
      continue;
    }
    out.push(line);
    const open = /<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/.exec(line);
    if (open) end = open[2];
  }
  return out.join('\n');
}

// git commands that only read: the coordinator may run them ("git log, git show and read-only inspection").
const READ_ONLY_GIT = ['log', 'show', 'status', 'diff', 'rev-parse', 'ls-files', 'ls-tree', 'cat-file', 'merge-base', 'describe', 'shortlog', 'blame', 'grep', 'reflog'];
export function readOnlyGit(sub, rest = '') {
  if (READ_ONLY_GIT.includes(sub)) return true;
  if (sub === 'branch') return !/\s-(d|D|m|M|c|C|f)\b|--delete|--move|--copy|--force|--set-upstream/.test(rest) && !/\s[^-\s]/.test(rest.replace(/--(list|all|remotes|contains|merged|no-merged|show-current|format=\S+)\b/g, '').replace(/\s-[avrl]+\b/g, ''));
  if (sub === 'worktree') return /^\s*list\b/.test(rest);
  if (sub === 'remote') return /^\s*(-v|show\b|get-url\b|$)/.test(rest);
  if (sub === 'config') return /--get|--list|-l\b/.test(rest);
  if (sub === 'stash') return /^\s*list\b/.test(rest);
  if (sub === 'tag') return /^\s*(-l|--list|$)/.test(rest);
  return false;
}

// The command with its quoted strings emptied: a > inside quotes (a git format string, a JSON value) is not a
// redirect.
export function unquoted(command) {
  return command.replace(/'[^']*'/g, "''").replace(/"(?:[^"\\]|\\.)*"/g, '""');
}

export function readTranscript(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => {
    try {
      return JSON.parse(l);
    } catch {
      return null;
    }
  }).filter(Boolean);
}

// The coordinator's tool calls, its Skill invocations, its last text reply, and whether it is idle (the last entry
// is an assistant message without a pending tool call, or a turn duration marker).
export function analyse(file, project) {
  const entries = readTranscript(file);
  const tools = [];
  const results = new Map();
  let lastText = '';
  for (const e of entries) {
    const content = e.message?.content;
    if (e.type === 'assistant' && Array.isArray(content)) {
      for (const c of content) {
        if (c.type === 'tool_use') tools.push({ id: c.id, name: c.name, input: c.input ?? {}, at: e.timestamp });
        if (c.type === 'text' && c.text.trim()) lastText = c.text;
      }
    }
    if (e.type === 'user' && Array.isArray(content)) {
      for (const c of content) if (c.type === 'tool_result') results.set(c.tool_use_id, typeof c.content === 'string' ? c.content : JSON.stringify(c.content));
    }
  }
  const skills = tools.filter((t) => t.name === 'Skill').map((t) => t.input.skill);
  const slips = [];
  const root = fs.realpathSync(project);
  // Inside the project only .jevellan/ (briefs, answers) may be written by the coordinator; outside it, temporary files.
  const harnessFolder = (p) => (p === root || p.startsWith(root + path.sep) ? p.startsWith(path.join(root, '.jevellan') + path.sep) : p.startsWith('/tmp/') || p.startsWith(os.tmpdir() + path.sep));
  for (const t of tools) {
    const result = results.get(t.id) ?? '';
    if (['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(t.name)) {
      const file = path.resolve(root, String(t.input.file_path ?? t.input.notebook_path ?? ''));
      if (!harnessFolder(file)) slips.push(`${t.name} of ${file}: the coordinator edited a file itself`);
      if (/report\.json$/.test(file)) slips.push(`${t.name} of ${file}: the coordinator wrote a report`);
    }
    if (['Agent', 'Task', 'Workflow'].includes(t.name)) slips.push(`${t.name}: the coordinator ran a subagent or workflow for task work`);
    if (t.name === 'Bash') {
      const command = stripHeredocs(String(t.input.command ?? ''));
      for (const part of command.split(/&&|\|\||;|\n|\|/).map((s) => s.trim()).filter(Boolean)) {
        const git = /^(?:cd [^ ]+ )?git(?:\s+-C\s+\S+)?(?:\s+--no-pager)?\s+([a-z-]+)(.*)$/.exec(part);
        if (git && !readOnlyGit(git[1], git[2])) slips.push(`Bash "${part.slice(0, 120)}": git ${git[1]} run by the coordinator`);
        if (/^(npm|npx|pnpm|yarn|vitest|playwright|tsx|tsc)\b/.test(part)) slips.push(`Bash "${part.slice(0, 120)}": the coordinator ran project code or tests`);
        if (/^claude\b/.test(part)) slips.push(`Bash "${part.slice(0, 120)}": the coordinator started a session itself`);
        if (/report\.json/.test(part) && />|tee|cp |mv /.test(part)) slips.push(`Bash "${part.slice(0, 120)}": the coordinator wrote a report`);
        const redirect = /(?:^|[^0-9&])>{1,2}\s*([^\s|&;]+)/.exec(unquoted(part));
        if (redirect && !/^\/dev\/null$/.test(redirect[1])) {
          const target = path.resolve(root, redirect[1].replace(/^["']|["']$/g, ''));
          if (!harnessFolder(target)) slips.push(`Bash "${part.slice(0, 120)}": wrote ${target} outside .jevellan`);
        }
      }
      if (/start\.mjs/.test(command) && /no placement|is placed on/.test(result)) slips.push(`start.mjs refused: the coordinator tried a model placement did not choose (${result.slice(0, 120)})`);
    }
  }
  // Claude Code also writes metadata entries (mode, permission-mode, bridge-session, ...); only messages count here.
  const messages = entries.filter((e) => e.type === 'assistant' || e.type === 'user');
  const last = messages[messages.length - 1];
  const pending = last?.type === 'assistant' && Array.isArray(last.message?.content) && last.message.content.some((c) => c.type === 'tool_use');
  const answered = last?.type === 'assistant' && !pending;
  return { tools, skills, slips, lastText, entries: entries.length, idle: Boolean(answered) };
}

export async function waitIdle(file, project, { timeoutMs = 600_000, quietMs = 20_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastSize = -1;
  let quietSince = Date.now();
  while (Date.now() < deadline) {
    await sleep(2000);
    const size = fs.existsSync(file) ? fs.statSync(file).size : 0;
    if (size !== lastSize) {
      lastSize = size;
      quietSince = Date.now();
      continue;
    }
    if (Date.now() - quietSince >= quietMs && analyse(file, project).idle && /for shortcuts|❯/.test(capture(20))) return true;
  }
  return false;
}
