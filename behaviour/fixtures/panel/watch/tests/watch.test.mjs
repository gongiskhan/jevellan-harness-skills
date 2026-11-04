import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

// The suite's host switch: FIXTURE_HOST_EMFILE=1, or a fixture-host file in the project's .jevellan folder, makes
// fs.watch fail the way Node fails on a host whose inotify instances are all in use.
function hostSwitch() {
  if (process.env.FIXTURE_HOST_EMFILE === '1') return true;
  try {
    const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    return fs.existsSync(path.join(path.dirname(common), '.jevellan', 'fixture-host'));
  } catch {
    return false;
  }
}
if (hostSwitch()) {
  fs.watch = () => {
    const error = new Error('EMFILE: too many open files, watch');
    Object.assign(error, { code: 'EMFILE', errno: -24, syscall: 'watch' });
    throw error;
  };
}

const { watchStore } = await import('../lib/store-watch.mjs');

test('a change to the store file on disk is noticed', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cred-watch-'));
  const file = path.join(dir, 'configs.json');
  let seen = 0;
  const stop = watchStore(file, () => {
    seen += 1;
  });
  fs.writeFileSync(file, '{}\n');
  for (let i = 0; i < 40 && !seen; i += 1) await new Promise((resolve) => setTimeout(resolve, 50));
  stop();
  assert.ok(seen > 0, 'the watcher saw the write');
});
