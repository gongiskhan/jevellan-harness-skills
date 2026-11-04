// Paths and scopes: the riskyPaths pattern rules (shared by landing's risky areas and the plan's scope block) and the
// scope block of plan.md. Used by land.mjs and overlap.mjs.

// Ported pathMatches: a file is under a risky path when it is that path or below it. A risky path with a wildcard is
// a pattern: "*" is any part of one name, "?" one character of it, "**" any number of folders ("deploy/**",
// "**/migrations", "api/scripts/migrate*"); it matches a file when it matches the file or a folder above it.
export function pathMatches(file, riskyPath) {
  const p = riskyPath.replace(/^\.\//, '').replace(/\/+$/u, '');
  if (p === '') return false;
  if (!/[*?]/.test(p)) return file === p || file.startsWith(`${p}/`);
  const re = globPattern(p);
  const parts = file.split('/');
  for (let i = parts.length; i >= 1; i -= 1) if (re.test(parts.slice(0, i).join('/'))) return true;
  return false;
}

export function globPattern(p) {
  let out = '';
  for (let i = 0; i < p.length; i += 1) {
    const c = p[i];
    if (c === '*' && p[i + 1] === '*') {
      if (p[i + 2] === '/') {
        out += '(?:.*/)?';
        i += 2;
      } else {
        out += '.*';
        i += 1;
      }
    } else if (c === '*') out += '[^/]*';
    else if (c === '?') out += '[^/]';
    else out += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${out}$`);
}

// The paths and patterns of plan.md's ```scope block, one per line (a leading "- " and a trailing "# comment" are
// dropped), or null when the plan has no such block.
export function scopeBlock(markdown) {
  if (typeof markdown !== 'string') return null;
  const m = /```scope[^\n]*\n([\s\S]*?)```/.exec(markdown);
  if (!m) return null;
  const paths = m[1].split('\n').map((l) => l.replace(/#.*$/, '').trim().replace(/^[-*]\s+/, '').replace(/^`|`$/g, '')).filter(Boolean);
  return paths.length ? paths : null;
}

export function inScope(file, scope) {
  return scope.some((p) => pathMatches(file, p));
}

// A test or a fixture: a file under a test, tests, __tests__, fixtures or e2e folder, or named *.test.* / *.spec.*.
export function isTestOrFixture(file) {
  return /(^|\/)(tests?|__tests__|fixtures?|e2e|spec)\//.test(file) || /\.(test|spec)\.[a-z0-9]+$/i.test(file);
}

/** How many files outside the scope a landing tolerates, when every one of them is a test or a fixture. */
export const SCOPE_TOLERANCE = 2;

// The changed files against the plan's scope: {scope, outside, tolerated}. Without a scope block there is nothing to
// compare (scope null, tolerated true). Up to SCOPE_TOLERANCE tests or fixtures outside the scope are tolerated (they
// are still listed); any other file outside it, or more of them, is not.
export function scopeCheck(files, scope) {
  if (!scope) return { scope: null, outside: [], tolerated: true };
  const outside = files.filter((f) => !inScope(f, scope));
  const tolerated = outside.length <= SCOPE_TOLERANCE && outside.every(isTestOrFixture);
  return { scope, outside, tolerated };
}
