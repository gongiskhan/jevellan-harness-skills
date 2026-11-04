// The task tools an assistant calls (MCP-style: each tool takes JSON arguments and returns JSON).
//   tasks_list  {page?}  the tasks, one compact row each, a page at a time
//   task_get    {id}     one task in full
//
// LIST_BUDGET caps the size of one tasks_list response: an assistant reads every byte of it, so a page that grows
// past the budget crowds out the rest of the conversation. tests/output-size.test.mjs enforces it on a full page.
import { TASKS } from '../store.mjs';

export const LIST_BUDGET = 2400;
export const PAGE_SIZE = 20;

export function compactCard(task) {
  return { id: task.id, title: task.title, status: task.status, column: task.column, due: task.due };
}

export function tasksList({ page = 1 } = {}, tasks = TASKS) {
  const start = (page - 1) * PAGE_SIZE;
  const items = tasks.slice(start, start + PAGE_SIZE).map(compactCard);
  return { items, page, total: tasks.length, ...(start + PAGE_SIZE < tasks.length ? { next: page + 1 } : {}) };
}

export function taskGet({ id }, tasks = TASKS) {
  const task = tasks.find((t) => t.id === id);
  if (!task) return { error: `no task ${id}` };
  return { ...task };
}

export const TOOLS = [
  { name: 'tasks_list', description: 'Lists the tasks, one compact row each (id, title, status, column, due), 20 per page.', handler: tasksList },
  { name: 'task_get', description: 'One task in full, with its trigger.', handler: taskGet },
];
