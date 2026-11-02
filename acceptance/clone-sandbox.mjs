// Makes a fresh clone of the sandbox at its baseline (61fc71a, H-024), installs the skills, writes the project
// settings the sandbox needs (H-002, H-023), and prints the clone's path. For journeys that must run again on a state
// the sandbox has moved past.
//   node acceptance/clone-sandbox.mjs <name>
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NODE, REPO, SANDBOX, SANDBOX_TEST_COMMAND, sh } from './lib.mjs';

export function cloneSandbox(name, base = '61fc71a') {
  const dir = path.join(os.userInfo().homedir, 'jevellan-projects', 'jevellan-harness-runs', `${name}-${Date.now()}`, 'jevellan-harness-sandbox');
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  sh('git', ['clone', '--quiet', '--local', SANDBOX, dir]);
  sh('git', ['-C', dir, 'remote', 'remove', 'origin']);
  sh('git', ['-C', dir, 'reset', '--quiet', '--hard', base]);
  // The sandbox's own CI check (npm run check:changelog) diffs against origin/main, which only CI has. A clone has no
  // remote (nothing may be pushed), so origin/main is made a symbolic ref to the local main: what CI compares a
  // branch against, and it moves with every landing.
  sh('git', ['-C', dir, 'symbolic-ref', 'refs/remotes/origin/main', 'refs/heads/main']);
  const inst = sh(NODE, [path.join(REPO, 'install.mjs'), dir, '--json']);
  if (inst.status !== 0) throw new Error(inst.stderr);
  const pj = path.join(dir, '.jevellan', 'project.json');
  fs.writeFileSync(pj, `${JSON.stringify({ ...JSON.parse(fs.readFileSync(pj, 'utf8')), testCommand: SANDBOX_TEST_COMMAND, setupCommand: 'npm ci' }, null, 2)}\n`);
  return dir;
}

if (process.argv[1]?.endsWith('clone-sandbox.mjs')) console.log(cloneSandbox(process.argv[2] ?? 'run'));
