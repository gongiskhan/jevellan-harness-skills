import test from 'node:test';
import assert from 'node:assert/strict';
import { addDays, daysBetween } from '../utils/dates.mjs';

test('daysBetween counts whole days', () => {
  assert.equal(daysBetween('2026-11-01', '2026-11-03'), 2);
  assert.equal(daysBetween('2026-11-03', '2026-11-03'), 0);
  assert.equal(daysBetween('2026-10-31', '2026-11-01'), 1);
});

test('addDays moves across a month', () => {
  assert.equal(addDays('2026-10-31', 1), '2026-11-01');
});
