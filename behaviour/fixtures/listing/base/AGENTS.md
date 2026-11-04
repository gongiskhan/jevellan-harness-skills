# office-task-tools

The task tools an assistant calls (MCP-style) to read the office's tasks: `src/tools/tasks.mjs` defines `tasks_list`
and `task_get` over the tasks in `src/store.mjs`.

## Commands

- `npm test`: every test (`node --test`).

## Rules

- Keep tool responses small: an assistant reads every byte. `tests/output-size.test.mjs` holds tasks_list to its budget.
- Descriptions and copy for the office are European Portuguese (pt-PT); code and comments are English. Never use the em
  dash anywhere.
- Every change reaches `main` as a pull request that the owner reviews.
