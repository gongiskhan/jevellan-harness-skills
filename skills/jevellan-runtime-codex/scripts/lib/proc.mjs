// Process helpers: is a pid alive, does a process group still have members, signal a process group, wait for a pid
// to go.

const cell = new Int32Array(new SharedArrayBuffer(4));
export function sleepMs(ms) {
  Atomics.wait(cell, 0, 0, ms);
}

export function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

// A group id a signal may be sent to. 0 and 1 never are: kill(-0) is this process's own group and kill(-1) is every
// process the owner has.
function groupId(pid) {
  return Number.isInteger(pid) && pid > 1;
}

// Whether the process group led by `pid` still has a member. Workers are spawned detached, so each leads its own
// group; the group outlives its leader while a child the worker started is still running. A pid that leads no group
// (a reused pid, say) is not a group.
export function groupAlive(pid) {
  if (!groupId(pid)) return false;
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

// Signals the process group led by `pid`, never the pid alone: a pid that leads no group may belong to anything.
export function signalGroup(pid, signal) {
  if (!groupId(pid)) return false;
  try {
    process.kill(-pid, signal);
    return true;
  } catch {
    return false;
  }
}

// SIGKILL to the group at once, for a process that was just spawned and must not run.
export function killGroup(pid) {
  return signalGroup(pid, 'SIGKILL');
}

// Waits up to `ms` for `pid` to exit. Returns true when it is gone.
export function waitForExit(pid, ms) {
  const deadline = Date.now() + ms;
  while (pidAlive(pid)) {
    if (Date.now() >= deadline) return false;
    sleepMs(100);
  }
  return true;
}

// SIGTERM to the group, then SIGKILL after `graceMs` while any member is still there, whether or not the leader
// itself is. Returns how it ended.
export function stopGroup(pid, graceMs = 10_000) {
  if (!groupAlive(pid)) return 'not running';
  signalGroup(pid, 'SIGTERM');
  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline) {
    if (!groupAlive(pid)) return 'SIGTERM';
    sleepMs(100);
  }
  signalGroup(pid, 'SIGKILL');
  for (let i = 0; i < 50 && groupAlive(pid); i += 1) sleepMs(100);
  return 'SIGKILL';
}
