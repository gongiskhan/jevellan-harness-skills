// Cost accounting on hand-written evidence and logs, with no model runs.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { costOf } from '../behaviour/run.mjs';

function fixture() {
  const dir = fs.mkdtempSync(path.join(process.env.JH_TEST_TMPDIR || os.tmpdir(), 'jh-behaviour-cost-'));
  return (name, costs) => {
    const file = path.join(dir, name);
    fs.writeFileSync(file, costs.map((usd) => JSON.stringify({ type: 'result', total_cost_usd: usd })).join('\n') + '\n');
    return file;
  };
}

const started = (logFile, step = 1) => ({ kind: 'step.started', task: 'T1', step, data: { logFile } });

test('a resumed worker log counts once, including every turn and other workers', () => {
  const log = fixture();
  const resumed = log('implement.jsonl', [0.12, 0.19]);
  const verify = log('verify.jsonl', [0.21]);
  const ev = { events: [started(resumed), started(resumed), started(verify, 2)] };
  assert.deepEqual(costOf(ev, null, { costUsd: 0.04 }), {
    workersUsd: 0.52,
    judgeUsd: 0.04,
    coordinatorTokens: null,
  });
});

test('distinct logs with equal costs both count, even for the same step', () => {
  const log = fixture();
  const ev = { events: [started(log('first.jsonl', [0.123456])), started(log('retry.jsonl', [0.123456]))] };
  assert.equal(costOf(ev).workersUsd, 0.2469);
});

test('unavailable logs stay unknown and unrelated events do not add worker costs', () => {
  const log = fixture();
  const available = log('worker.jsonl', [0.25]);
  const events = [started(), { kind: 'step.started' }, started(`${available}.missing`),
    { kind: 'step.report', data: { logFile: available } }];
  assert.deepEqual(costOf({ events }), { workersUsd: null, judgeUsd: null, coordinatorTokens: null });
  assert.equal(costOf({ events: [...events, started(available)] }).workersUsd, 0.25);
  assert.equal(costOf({ events: [] }).workersUsd, null);
  assert.equal(costOf({ events: [started(log('zero.jsonl', [0]))] }).workersUsd, 0);
});
