// Process helpers: is a pid alive, signal a process group, wait for a pid to go.

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

// Signals the process group led by `pid` (workers are spawned detached, so they lead their own group), falling
// back to the pid alone when the group is gone.
export function signalGroup(pid, signal) {
  try {
    process.kill(-pid, signal);
    return true;
  } catch {
    try {
      process.kill(pid, signal);
      return true;
    } catch {
      return false;
    }
  }
}

// SIGTERM, then SIGKILL after `graceMs` when the process is still there. Returns how it ended.
export function stopGroup(pid, graceMs = 10_000) {
  if (!pidAlive(pid)) return 'not running';
  signalGroup(pid, 'SIGTERM');
  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline) {
    if (!pidAlive(pid)) return 'SIGTERM';
    sleepMs(100);
  }
  signalGroup(pid, 'SIGKILL');
  for (let i = 0; i < 50 && pidAlive(pid); i += 1) sleepMs(100);
  return 'SIGKILL';
}
