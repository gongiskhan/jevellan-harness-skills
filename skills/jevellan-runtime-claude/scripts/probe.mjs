#!/usr/bin/env node
// The live check of a claude-endpoint provider (H-044): the Anthropic Messages requests Claude Code sends, against the
// provider's baseUrl with its key. lib/probe.mjs says which checks run.
//
//   node probe.mjs --provider P [--json]
//
// Exit 0 when the checks ran (each says ok or not; `ok` is whether text and the tool loop work, `thinking` whether
// thinking can stay on in tool loops), 2 refused (not an endpoint, no key, a key file others can read, a baseUrl
// ending in /v1), 3 an unknown provider. The key is never printed.

import { parseArgs } from 'node:util';
import { RuntimeError, findProvider, loadProvidersFile } from './lib/env.mjs';
import { assertPrivateKeyFile } from './lib/session.mjs';
import { probe } from './lib/probe.mjs';
import { isEntry, main } from './lib/cli.mjs';

export const USAGE = 'usage: node probe.mjs --provider P [--json]';

export async function run(argv) {
  const { values } = parseArgs({ args: argv, options: { provider: { type: 'string' }, json: { type: 'boolean' } }, strict: true });
  if (!values.provider) throw new RuntimeError('--provider is required');
  const provider = findProvider(values.provider, loadProvidersFile());
  if (provider.kind === 'claude-endpoint') assertPrivateKeyFile(provider);
  const out = await probe(provider);
  const lines = out.checks.map((c) => `${c.ok ? 'ok  ' : 'FAIL'} ${c.name} (HTTP ${c.status}, ${c.ms} ms): ${c.detail}`);
  lines.push(out.ok ? `${out.provider} answers Claude Code's requests; thinking in tool loops: ${out.thinking ? 'works' : 'fails, keep MAX_THINKING_TOKENS=0 in its env'}` : `${out.provider} does not answer Claude Code's requests yet`);
  return { out, text: lines.join('\n') };
}

if (isEntry(import.meta.url)) main(run, USAGE);
