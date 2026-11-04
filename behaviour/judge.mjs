// The judge of the behaviour evals: one `claude -p` call with a fixed rubric, structured output {score 0..1,
// reasons[]}. It runs like a worker does, not like the owner's own sessions: its own configuration folder (no CLAUDE.md,
// rules, plugins, memory or MCP servers of the owner's), no tools, no saved session, and the login of providers.json's
// claude-main provider passed in the environment only (never on a command line or in a file).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { EVALS_HOME, MAIN_HOME, OWNER_HOME, readJson, sha256 } from './lib.mjs';

export const JUDGE_MODEL = 'claude-opus-5-5';
export const JUDGE_EFFORT = 'medium';
const SYSTEM = 'You are an evaluator. You read material produced by an automated software-engineering harness and score it against a rubric. Be strict and literal: score what the material shows, not what it might mean. Answer only through the structured output: score is a number from 0 to 1, reasons are short sentences, the first one the main reason for the score.';
const SCHEMA = JSON.stringify({
  type: 'object',
  properties: { score: { type: 'number', minimum: 0, maximum: 1 }, reasons: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 6 } },
  required: ['score', 'reasons'],
  additionalProperties: false,
});

function judgeEnv() {
  const providers = readJson(path.join(MAIN_HOME, 'providers.json'));
  const main = providers?.providers?.find((p) => p.name === 'claude-main');
  if (!main?.tokenFile) throw new Error('the judge needs providers.json\'s claude-main provider with a tokenFile');
  const token = fs.readFileSync(main.tokenFile.replace(/^~(?=\/)/, OWNER_HOME), 'utf8').trim();
  const config = path.join(EVALS_HOME, 'judge-config');
  fs.mkdirSync(config, { recursive: true, mode: 0o700 });
  return {
    PATH: process.env.PATH,
    HOME: OWNER_HOME,
    USER: process.env.USER ?? os.userInfo().username,
    LANG: 'en_US.UTF-8',
    CLAUDE_CONFIG_DIR: config,
    CLAUDE_CODE_OAUTH_TOKEN: token,
    ENABLE_CLAUDEAI_MCP_SERVERS: 'false',
  };
}

// Scores `material` against `rubric`. Returns {score, reasons, model, effort, rubricHash, costUsd, ms} or
// {error, ...} when the call failed (a failed judge never passes a case).
export function judge({ rubric, material, model = JUDGE_MODEL, effort = JUDGE_EFFORT }) {
  const prompt = `# Rubric\n\n${rubric.trim()}\n\n# Material\n\n${material.trim()}\n`;
  const t0 = Date.now();
  const r = spawnSync('claude', ['-p', '--model', model, '--effort', effort, '--tools', '', '--strict-mcp-config', '--no-session-persistence', '--output-format', 'json', '--json-schema', SCHEMA, '--system-prompt', SYSTEM], {
    input: prompt,
    env: judgeEnv(),
    cwd: os.tmpdir(),
    encoding: 'utf8',
    timeout: 300_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  const base = { model, effort, rubricHash: sha256(rubric).slice(0, 16), ms: Date.now() - t0 };
  try {
    const out = JSON.parse(r.stdout);
    const s = out.structured_output ?? JSON.parse(out.result);
    if (typeof s.score !== 'number') throw new Error('no score');
    return { ...base, score: Math.max(0, Math.min(1, s.score)), reasons: s.reasons ?? [], costUsd: out.total_cost_usd ?? null };
  } catch (error) {
    return { ...base, error: `judge failed (exit ${r.status}): ${error.message}; ${(r.stderr || r.stdout || '').slice(0, 300)}`, score: 0, reasons: [] };
  }
}
