// The monthly usage report: how many days each integration has been connected. node scripts/report.mjs [YYYY-MM-DD]
import { readAll } from '../lib/store.mjs';
import { daysBetween } from '../utils/dates.mjs';

const today = process.argv[2] ?? new Date().toISOString().slice(0, 10);
for (const row of Object.values(readAll())) {
  const since = (row.createdAt ?? `${today}T00:00:00Z`).slice(0, 10);
  console.log(`${row.label ?? row.key}: ${daysBetween(since, today)} dias`);
}
