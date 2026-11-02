# Decoupling

The owner's rule for this repository: decoupling wins over efficiency, always. A skill is a folder that must work when
it is the only folder installed, and it reaches another skill only through that skill's public interface: the scripts
at the top of its `scripts/` folder, run as a child process found by role (`runRole(role, 'script.mjs', args)` in the
skill's own `scripts/lib/roles.mjs`), with JSON on stdin or argv and JSON on stdout, as its `SKILL.md` "## Interface"
section describes. The only shared ground is the project's `.jevellan/` folder (above all the ledger),
`~/.jevellan-harness/` (`JH_HARNESS_HOME`, `harnessHome()`), the task's worktree and Node's built-ins.

`scripts/check-decoupling.mjs` enforces the rules below on every file under `skills/<x>/`, and `npm test` runs it.
Each problem is one line, `<file>:<line>: <rule>: <detail>`. A skill holds plain files only: a symbolic link under it
fails rule `path` and is not followed (a skill folder that is itself a link fails too, on a run without `--skill`), and
a `node_modules` folder fails rule `import` and is not read. Two other checks cover what a lint cannot see:
`scripts/test-skills.mjs` runs each skill's own tests with only that skill's folder present (its `--concurrency` is a
positive integer, and a run in which a chosen skill has no result fails), and
`test/isolation.test.mjs` installs each skill alone in a project and runs every public script there, expecting
`--help` to work and a role-dependent command to refuse with exit 2 and the role-missing sentence instead of crashing.
Helper copies that drift apart are allowed and only reported: `scripts/check-roles.mjs` prints a `notice:` line for
every helper file several skills keep whose copies differ.

## Importing another skill's code (rule `import`)

A module imported from another skill ties the two skills' internals together: a change inside one breaks the other,
and neither works alone. Every `import ... from`, `export ... from`, `import '...'`, dynamic `import(...)`,
`require(...)` and `x.require(...)` in a skill must name a Node built-in (`node:fs`, or a bare built-in such as `fs`)
or a relative path that resolves inside the skill's own folder. The lint tokenizes each `.mjs`, `.js` and `.cjs` file
(comments and regular expressions do not count) and resolves every specifier from the file's own folder: a package
name, an absolute path, a `file:` URL, a path into another skill, and a computed specifier (one that is not a string
literal, which no lint can check) fail. The one exception is a computed specifier under the skill's `test/` folder,
where an own test imports the copy of its skill that it laid out next to its fakes; `scripts/test-skills.mjs` runs
those tests with no other skill present, so a computed path cannot reach a sibling there.

`createRequire` builds a `require` whose calls the lint cannot follow (`const r = createRequire(import.meta.url);
r('../../other/scripts/lib/x.mjs')`), so every `createRequire` token fails, whether a name, a property
(`module.createRequire`) or a string, under `test/` too; so does `process.getBuiltinModule()` of `"module"`,
`"node:module"` or a computed name, the other way to reach it. Import Node built-ins statically. Skills ship `.mjs`
(the lint reads `.js` and `.cjs` as code too): a TypeScript file (`.ts`, `.mts`, `.cts`, `.tsx`) fails outright, and so
does a `node_modules` folder, since a skill uses Node's built-ins only.

## Paths that leave the skill folder (rule `path`)

Reading another skill's files is the same coupling as importing them, only quieter: `readFileSync` of a sibling's
`scripts/lib/` file, or a script run by building a path to it. For every outermost call of `path.join`,
`path.resolve`, `join`, `resolve`, `dirname`, `new URL` and the `fs` readers and writers (`readFileSync`,
`existsSync`, `statSync`, `createReadStream` and the like), the lint walks the string literals among the arguments
(template pieces included, in order) as path segments: `..` climbs one level when no earlier segment of the call is
left to cancel, any other segment descends. When the call is anchored on the file's own location
(`import.meta.url`, `import.meta.filename`, `__filename`), every `dirname()` in it but the first climbs one more level
(every one, for `import.meta.dirname` and `__dirname`). The call fails when it climbs more levels than the file sits
deep inside its skill (`scripts/worktree.mjs` is at depth 1, `scripts/lib/roles.mjs` at depth 2), because it then
reaches the folder holding the skills, or above. Outside such calls, each run of string and template literals joined
by `+` is measured the same way as one path, the pieces concatenated and a template's substitutions taken as segment
breaks: `here + '/../../..'` climbs three levels, `` `${here}/../../x` `` two, and `'..' + '/' + '..'` two (an
identifier or a call ends a run). The heuristic does not follow variables: `path.join(root, '..', '..')` counts two
levels whatever `root` is, which also keeps a skill from climbing out of the project. The only exception is
`scripts/lib/roles.mjs`'s `SKILLS_ROOT`, the folder the role scan reads, computed with exactly three `..` from
`scripts/lib/`.

That folder is the role scan's alone. `SKILLS_ROOT` is private to `roles.mjs`, and the scan's results carry a skill's
`name`, `meta`, `body` and `text`, never its folder; `runRole` resolves the folder inside `roles.mjs`. So outside
`roles.mjs` every `SKILLS_ROOT` identifier fails, and so does a `.dir` read (`.dir`, `?.dir`, `['dir']`) or a `dir`
destructured from what `skillWithRole`, `skillsWithRole` or `installedSkills` returns. The lint follows those results
through the names they are bound to (`const s = skillWithRole(...)`, `for (const s of list)`, `const [first] =
...`), the first parameter of an element callback (`list.map((s) => s.dir)`) and postfix chains (`list[0].dir`,
`list.find(...)?.dir`), within the file. Inside `roles.mjs`, `pluginRoot()` may take the dirname of the skills folder
to look for `.claude-plugin/plugin.json`, and `runsFromProject(project)` may compare that folder with
`<project>/.claude/skills`; anywhere else the same functions need `SKILLS_ROOT` or a climb, and fail. The lint also
fails any text holding the repository's absolute path (or an absolute path through a folder named like it), `'../'`
joined with another skill's folder name, and, outside `roles.mjs`, a path built from the role scan
(`skillWithRole`, `skillsWithRole`, `installedSkills`, `SKILLS_ROOT`) with a `scripts` or `lib` segment, or from a
`.dir` with a `lib` segment: that reads or runs another skill's files without going through `runRole` and its
Interface.

## Naming another skill (rule `skill-name`)

A skill that names another skill's folder depends on that exact skill being installed under that exact name, when it
should depend on a role that any skill may fill. The lint fails another skill's folder name (the names of the other
folders under `skills/`), as a whole word and in any case, anywhere in any file under the skill: `SKILL.md`,
scripts, hooks, evals, `CHANGELOG.md`, tests and data files, and in the path of any of its files (a fake in a test is
named after its role, `fake-ledger`, never after a real skill). The skill's own name is fine, and so is a longer word
that merely starts with another name. Refer to the role instead: "the ledger skill", "the placement skill", "the
runtime skill for provider kind <kind>". Trigger cases name the calling skill by role too (`context_role`, with
`context_for` when several skills hold that role).

## Shared modules at the repository root (rule `repo-module`)

Code at the repository root (`scripts/`, `test/helpers/`, `install.mjs`, `acceptance/`) is not installed into a
project, so a skill that uses it works only inside this repository. An import that resolves anywhere outside
`skills/` gets this rule's own message, and so does a code string ending in the repository-relative path of a code
file outside `skills/` (`'scripts/check-roles.mjs'`, or the same path built with `path.join`). A skill keeps its own
copy of what it needs.

## The owner's Claude Code folder and settings (rule `claude-home`)

Only `install.mjs` at the repository root touches Claude Code's settings and the owner's `~/.claude` folder; a skill
that writes there changes every session on the machine. The lint fails `~/.claude`, `$HOME/.claude` and
`.claude/settings` in any file, a template `${<home>}/.claude` in code, and a home expression joined with `.claude`
(`path.join(os.homedir(), '.claude')`, `home + '/.claude'`). An identifier counts as a home when its name holds "home"
and not "harness", or when the file binds it to a value that starts with such a home: `const h = os.homedir()`,
`= os.userInfo().homedir`, `= process.env.HOME`, `= ownerHome()` or another home name (`= harnessHome()` is not one).
The home and settings checks run on every outermost path call, so `fs.writeFileSync(path.join(h, '.claude', 'x'))`
fails as much as the bare join; a call fails when a home is among its arguments and one of its strings has a
`.claude` segment (`.claude-plugin` is not one). Prose that says `.claude` without a home or settings path is fine
(the worktree's `.claude` link to the project's skills), and so are the data files under `evals/`, whose trigger cases
quote requests an owner might type (a near miss about `.claude/settings.json`); the code under `evals/` is checked like
any other.

## A twenty-first event kind (rule `event-kind`)

The ledger has exactly twenty event kinds. A new kind is a new field every reader must learn, so it is added only by
changing the ledger skill and this lint together. The lint checks that the ledger library's `KINDS` is exactly the
twenty (imported the way `scripts/check-roles.mjs` does), and that no code file under `skills/` (`.mjs`, `.cjs`, `.js`;
`check-roles.mjs` reads the same set) uses another kind, with `check-roles.mjs`'s `kindsUsed`: every dotted literal
(`task.x`, `step.x`, `session.x`, `landing.x`), every string literal after `'append'` or `'record'` in a `ledger.mjs`
argument list that is not a flag (`'--task'`) or another ledger command word (so `'step-bogus'` and `'Task.X'` count),
the kind argument of `appendLine`, and the `kind:` of the objects `appendEvent` takes and an `appendChecked` decide
function returns.

## runRole targets and Interface sections (rules `run-role` and `interface`)

A public script is a promise to every caller, so it is written down. Every `SKILL.md` ends with a "## Interface"
section (no heading after it, fenced code blocks aside) with one bullet per script at the top of its `scripts/`
folder, starting with the script name in backticks (`` - `ledger.mjs show T --json` -> `{task, state, ...}` ``), or
"No scripts." when there are none; a script that only its own skill runs lives in `scripts/lib/`. The lint fails a
missing section, a section that is not the last, a top-level script that is not listed, a listed script that does not
exist, and "No scripts." in a skill that has some. Every `runRole(role, script, ...)` call must give the role and the
script as string literals, the script as a bare `<name>.mjs`, and some skill with that `jh-role` must list that
script in its Interface section; otherwise the call fails.

## The old shared import (rule `import-from-role`)

`importFromRole` loaded another skill's internal module by role, which was coupling in a role's clothing. It no longer
exists, and the word anywhere under `skills/` fails: run the other skill's public script with `runRole` instead.
