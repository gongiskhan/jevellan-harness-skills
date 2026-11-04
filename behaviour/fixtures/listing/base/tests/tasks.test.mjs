import test from 'node:test';
import assert from 'node:assert/strict';
import { TOOLS, taskGet, tasksList } from '../src/tools/tasks.mjs';

test('tasks_list returns a page of compact rows', () => {
  const page = tasksList();
  assert.equal(page.items.length, 20);
  assert.deepEqual(Object.keys(page.items[0]), ['id', 'title', 'status', 'column', 'due']);
  assert.equal(page.total, 20);
  assert.equal(page.next, undefined);
});

test('task_get returns one task in full', () => {
  assert.equal(taskGet({ id: 't004' }).trigger.type, 'schedule');
  assert.match(taskGet({ id: 'nope' }).error, /no task/);
});

test('every tool has a name, a description and a handler', () => {
  for (const tool of TOOLS) assert.ok(tool.name && tool.description && typeof tool.handler === 'function');
});
