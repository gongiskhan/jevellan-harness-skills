// An interactive (or -p) Claude Code session of the owner's on a named Claude provider (H-044): a coordinator, or any
// session the owner or Ekoa starts by hand, on a provider other than the owner's own login. session.mjs runs it;
// this file builds what it runs.
//
// What the session gets, compared with a plain `claude` in the owner's terminal:
// - the provider's login and its `env` (providerLogin), ANTHROPIC_MODEL set to the provider's model;
// - its own config folder (sessionConfigDir), so the owner's instructions, memory, MCP servers, plugins and claude.ai
//   login never reach the provider; Claude Code's first-run screens (onboarding, folder trust, the bypass-permissions
//   warning when that mode is asked for) are answered there for the session's folder, as the owner already answered
//   them in his own folder;
// - --strict-mcp-config (only the MCP config files the caller names load) and, for an endpoint, no claude.ai
//   connectors;
// - this plugin (--plugin-dir) when these skills came with one, and the workers' settings (workerSettings): no
//   instruction file of a folder above the session's folder (the owner's home is one, and his personal Claude Code
//   instructions and rules would load from there as a parent folder's), no attribution, no Read or Edit of the
//   harness's secrets;
// - the caller's arguments otherwise unchanged, except --model (a model the provider does not serve becomes its
//   first model) and --remote-control (removed: it needs a claude.ai login, which the session's folder has none of).
//
// Guards (exit 2 with the reason): a Claude provider only; an endpoint needs a `projects` list, a baseUrl without /v1
// and a key file that is a regular file only its owner can read; the session's folder and every --add-dir must lie in
// a listed project.

import fs from 'node:fs';
import path from 'node:path';
import { CLAUDE_KINDS, RuntimeError, SECRET_NAME, assertProjectAllowed, expandHome, findProvider, loadProvidersFile, providerLogin, sessionConfigDir, workerSettings } from './env.mjs';
import { pluginRoot } from './roles.mjs';

// What the caller's environment may not pass on: every ANTHROPIC_* and CLAUDE* variable (other logins and config
// folders, a parent Claude Code session's own variables, settings the provider entry does not make: the session's
// Claude configuration comes from providers.json and its flags only), the hooks' step variables (a session of the
// owner's is not a step), and any variable named like a secret (a GitHub token, say), which the session's model could
// otherwise read back to its provider.
const DROP_EXACT = ['JH_TASK', 'JH_STEP', 'JH_DUTY', 'JH_PROJECT', 'JH_SESSION', 'JH_CWD'];
const SECRET_VARS = ['ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN'];

export function sessionBaseEnv(base = process.env) {
  const env = {};
  for (const [key, value] of Object.entries(base)) {
    if (value === undefined || key.startsWith('ANTHROPIC_') || key.startsWith('CLAUDE') || DROP_EXACT.includes(key) || SECRET_NAME.test(key)) continue;
    env[key] = value;
  }
  return env;
}

// A key file the session reads must be a regular file only its owner can read (chmod 600).
export function assertPrivateKeyFile(provider) {
  const file = expandHome(provider.keyFile ?? '');
  let stat;
  try {
    stat = fs.lstatSync(file);
  } catch {
    throw new RuntimeError(`provider ${provider.name}: key file ${provider.keyFile ?? '(none named)'} is missing; save the key there (the key only) with mode 600`);
  }
  if (!stat.isFile()) throw new RuntimeError(`provider ${provider.name}: key file ${provider.keyFile} must be a regular file`);
  if ((stat.mode & 0o077) !== 0) throw new RuntimeError(`provider ${provider.name}: key file ${provider.keyFile} must be readable by its owner only (chmod 600)`);
}

// Claude Code's flags this script reads or changes; every other argument passes through as it is.
function valueOf(arg, name) {
  return arg.startsWith(`${name}=`) ? arg.slice(name.length + 1) : null;
}

// --settings takes JSON or a file of JSON, as Claude Code's does.
function readSettings(text, cwd) {
  const shown = text.length > 60 ? `${text.slice(0, 60)}...` : text;
  let raw = text;
  if (!text.trim().startsWith('{')) {
    try {
      raw = fs.readFileSync(path.resolve(cwd, text), 'utf8');
    } catch {
      throw new RuntimeError(`--settings ${shown} is neither a JSON object nor a readable file`);
    }
  }
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
  } catch {}
  throw new RuntimeError(`--settings ${shown} does not hold a JSON object`);
}

// Splits the caller's claude arguments into what this script handles and the rest. Mirrors Claude Code's parser for
// the flags it reads: a required value follows the flag or its "=", --remote-control's name is optional (taken when
// the next argument is not a flag), --add-dir takes the arguments that follow up to the next flag. Nothing after
// "--" is read.
export function readClaudeArgs(args) {
  const out = { rest: [], model: null, remoteControl: false, settings: [], addDirs: [], pluginDir: false, bypass: false, strictMcp: false };
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (a === '--') {
      out.rest.push(...args.slice(i));
      break;
    }
    const next = () => {
      if (i + 1 >= args.length) throw new RuntimeError(`${a} needs a value`);
      i += 1;
      return args[i];
    };
    if (a === '--model' || valueOf(a, '--model') !== null) out.model = valueOf(a, '--model') ?? next();
    else if (a === '--remote-control' || valueOf(a, '--remote-control') !== null) {
      out.remoteControl = true;
      if (a === '--remote-control' && i + 1 < args.length && !args[i + 1].startsWith('-')) i += 1;
    } else if (a === '--settings' || valueOf(a, '--settings') !== null) out.settings.push(valueOf(a, '--settings') ?? next());
    else if (a === '--add-dir' || valueOf(a, '--add-dir') !== null) {
      out.rest.push(a);
      const inline = valueOf(a, '--add-dir');
      if (inline !== null) out.addDirs.push(inline);
      while (inline === null && i + 1 < args.length && !args[i + 1].startsWith('-')) {
        i += 1;
        out.addDirs.push(args[i]);
        out.rest.push(args[i]);
      }
    } else {
      if (a === '--plugin-dir' || valueOf(a, '--plugin-dir') !== null) out.pluginDir = true;
      if (a === '--dangerously-skip-permissions') out.bypass = true;
      if (a === '--permission-mode' && args[i + 1] === 'bypassPermissions') out.bypass = true;
      if (a === '--permission-mode=bypassPermissions') out.bypass = true;
      if (a === '--strict-mcp-config') out.strictMcp = true;
      out.rest.push(a);
    }
  }
  return out;
}

// Everything the session runs with, without starting it: {provider, model, project, cwd, configDir, args, env,
// notices}. `env` holds the provider's secret; only session.mjs's child gets it.
export function sessionPlan({ provider: name, cwd = process.cwd(), args = [], base = process.env, plugin = pluginRoot() }) {
  const provider = findProvider(name, loadProvidersFile());
  if (!CLAUDE_KINDS.includes(provider.kind)) throw new RuntimeError(`provider ${provider.name} is ${provider.kind}, not a Claude provider`);
  if (provider.enabled === false) throw new RuntimeError(`provider ${provider.name} is disabled in providers.json`);
  const dir = path.resolve(cwd);
  if (!fs.existsSync(dir)) throw new RuntimeError(`--cwd ${dir} does not exist`);
  if (provider.kind === 'claude-endpoint') {
    if (provider.projects === undefined) {
      throw new RuntimeError(`provider ${provider.name} is an endpoint outside the owner's own logins and has no projects list; name in providers.json (projects) the projects whose material may go to it first`);
    }
    assertPrivateKeyFile(provider);
    if (/\/v1\/?$/.test(provider.baseUrl ?? '')) throw new RuntimeError(`provider ${provider.name}: baseUrl must be the origin without /v1 (Claude Code adds /v1/messages itself), not ${provider.baseUrl}`);
  }
  const project = assertProjectAllowed(provider, dir);
  const read = readClaudeArgs(args);
  for (const extra of read.addDirs) {
    const target = path.resolve(dir, extra);
    if (provider.projects !== undefined) {
      if (!fs.existsSync(target)) throw new RuntimeError(`--add-dir ${extra} does not exist`);
      assertProjectAllowed(provider, target);
    }
  }
  const notices = [];
  const ids = provider.models.map((m) => m.id);
  if (!ids.length) throw new RuntimeError(`provider ${provider.name} has no models`);
  let model = read.model;
  if (!ids.includes(model)) {
    if (model) notices.push(`--model ${model} is not served by ${provider.name}; the session runs on ${ids[0]}`);
    model = ids[0];
  }
  if (read.remoteControl) notices.push(`--remote-control was left out: remote control needs a claude.ai login, and sessions on ${provider.name} have none`);

  // The caller's settings, then the workers' over them: the instruction excludes and the secrets' deny rules are
  // added to the caller's, attribution is replaced.
  const settings = {};
  for (const text of read.settings) Object.assign(settings, readSettings(text, dir));
  const ours = JSON.parse(workerSettings(dir));
  settings.claudeMdExcludes = [...(Array.isArray(settings.claudeMdExcludes) ? settings.claudeMdExcludes : []), ...ours.claudeMdExcludes];
  settings.attribution = ours.attribution;
  const permissions = settings.permissions && typeof settings.permissions === 'object' ? settings.permissions : {};
  settings.permissions = { ...permissions, deny: [...(Array.isArray(permissions.deny) ? permissions.deny : []), ...ours.permissions.deny] };
  const claudeArgs = ['--model', model];
  if (!read.strictMcp) claudeArgs.push('--strict-mcp-config');
  if (plugin && !read.pluginDir) claudeArgs.push('--plugin-dir', plugin);
  claudeArgs.push('--settings', JSON.stringify(settings), ...read.rest);

  const configDir = sessionConfigDir(provider);
  const set = { ...providerLogin(provider), CLAUDE_CONFIG_DIR: configDir };
  if (provider.kind === 'claude-endpoint') {
    set.ANTHROPIC_MODEL = model;
    set.ENABLE_CLAUDEAI_MCP_SERVERS = 'false';
  }
  const inherited = sessionBaseEnv(base);
  const env = { ...inherited, ...set };
  return { provider: provider.name, kind: provider.kind, model, project, cwd: dir, configDir, args: claudeArgs, set, inherited: Object.keys(inherited).filter((k) => !(k in set)).sort(), env, bypass: read.bypass, notices };
}

function readJson(file) {
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

function writeJsonAtomic(file, value) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

// Answers Claude Code's first-run screens in the session's own config folder, for the session's folder only:
// onboarding done, the folder trusted (under each spelling of its path), and, when the caller asked for bypass mode,
// the bypass warning accepted. Writes only what is missing, so an unchanged folder is never rewritten.
export function seedConfig({ configDir, cwd, bypass }) {
  const stateFile = path.join(configDir, '.claude.json');
  const state = readJson(stateFile);
  let changed = false;
  if (state.hasCompletedOnboarding !== true) {
    state.hasCompletedOnboarding = true;
    changed = true;
  }
  const spellings = [cwd];
  try {
    const real = fs.realpathSync(cwd);
    if (!spellings.includes(real)) spellings.push(real);
  } catch {}
  state.projects = state.projects && typeof state.projects === 'object' ? state.projects : {};
  for (const dir of spellings) {
    const entry = state.projects[dir] && typeof state.projects[dir] === 'object' ? state.projects[dir] : {};
    if (entry.hasTrustDialogAccepted !== true) {
      state.projects[dir] = { ...entry, hasTrustDialogAccepted: true };
      changed = true;
    }
  }
  if (changed) writeJsonAtomic(stateFile, state);
  if (bypass) {
    const settingsFile = path.join(configDir, 'settings.json');
    const settings = readJson(settingsFile);
    if (settings.skipDangerousModePermissionPrompt !== true) writeJsonAtomic(settingsFile, { ...settings, skipDangerousModePermissionPrompt: true });
  }
}

// The plan as it may be shown: what the script sets, the secret masked, and only the names of what the session
// inherits from the caller.
export function shownPlan(plan) {
  const set = {};
  for (const [key, value] of Object.entries(plan.set)) set[key] = SECRET_VARS.includes(key) ? '<from the provider\'s key or token file>' : value;
  const { env: _secret, set: _set, ...rest } = plan;
  return { ...rest, set };
}
