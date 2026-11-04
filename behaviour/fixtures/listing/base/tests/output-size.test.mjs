import test from 'node:test';
import assert from 'node:assert/strict';
import { LIST_BUDGET, tasksList } from '../src/tools/tasks.mjs';

test('a full tasks_list page stays within the budget', () => {
  const bytes = Buffer.byteLength(JSON.stringify(tasksList()));
  assert.ok(bytes <= LIST_BUDGET, `a full page is ${bytes} bytes; the budget is ${LIST_BUDGET}`);
});
