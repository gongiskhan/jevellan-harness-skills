// Day arithmetic for the monthly usage report (scripts/report.mjs). Dates are ISO days (YYYY-MM-DD), in UTC.
const DAY = 24 * 60 * 60 * 1000;

export function daysBetween(from, to) {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY);
}

export function addDays(day, n) {
  return new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);
}
