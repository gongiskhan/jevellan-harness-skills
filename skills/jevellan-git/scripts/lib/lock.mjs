// Exclusive lock files for the ledger and other short critical sections.
//
// A lock is a file created with O_EXCL that holds "<pid> <epoch ms>". Acquiring retries every 20 ms for up to
// 2 s. A lock is stale when its holder's pid is gone (taken over at once) or when it is older than 10 s (a live pid
// that old can only be a reused pid: nothing holds the ledger lock for more than a few milliseconds). Breaking a
// stale lock goes through a second file, "<lock>.break", so two waiters cannot both remove it and then remove each
// other's fresh lock. Everything is synchronous, so hooks and short scripts stay simple.

import fs from 'node:fs';
import path from 'node:path';

const sleepCell = new Int32Array(new SharedArrayBuffer(4));
export function sleepMs(ms) {
  Atomics.wait(sleepCell, 0, 0, ms);
}

export class LockTimeout extends Error {
  constructor(file) {
    super(`lock busy: ${file}`);
    this.code = 'LOCK_TIMEOUT';
  }
}

// Writes all of `data` at the file's current position (the end, for a file opened to append). writeSync may write
// fewer bytes than asked; the rest is written in further calls, and a call that writes nothing ends it with an error,
// so a cut write is never taken for a whole one.
export function writeAll(fd, data) {
  const buffer = Buffer.isBuffer(data) ? data : Buffer.from(String(data));
  let done = 0;
  while (done < buffer.length) {
    const n = fs.writeSync(fd, buffer, done, buffer.length - done, null);
    if (!(n > 0)) {
      const error = new Error(`write made no progress after ${done} of ${buffer.length} bytes`);
      error.code = 'ESHORTWRITE';
      throw error;
    }
    done += n;
  }
  return done;
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

function readHolder(file) {
  try {
    const text = fs.readFileSync(file, 'utf8');
    const [pid, at] = text.trim().split(/\s+/).map(Number);
    const stat = fs.statSync(file);
    return { text, pid, at: Number.isFinite(at) ? at : stat.mtimeMs, mtimeMs: stat.mtimeMs };
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

function isStale(holder, staleMs) {
  if (!holder) return false;
  const age = Date.now() - holder.at;
  if (!Number.isInteger(holder.pid) || holder.pid <= 0) {
    // Created but not written yet, or garbage: only its age can tell.
    return Date.now() - holder.mtimeMs > staleMs;
  }
  return !pidAlive(holder.pid) || age > staleMs;
}

// Returns true when this call removed the stale lock (or found it gone), false when another breaker holds the guard.
function breakStale(file, seen, staleMs) {
  const guard = `${file}.break`;
  let fd;
  try {
    fd = fs.openSync(guard, 'wx');
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    // A breaker that died mid-break leaves the guard behind; breaking takes microseconds.
    try {
      if (Date.now() - fs.statSync(guard).mtimeMs > GUARD_STALE_MS) fs.unlinkSync(guard);
    } catch {}
    return false;
  }
  try {
    writeAll(fd, `${process.pid} ${Date.now()}`);
    const now = readHolder(file);
    if (now && now.text === seen.text && isStale(now, staleMs)) fs.unlinkSync(file);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  } finally {
    fs.closeSync(fd);
    try {
      fs.unlinkSync(guard);
    } catch {}
  }
  return true;
}

const GUARD_STALE_MS = 2000;

export function acquire(file, { timeoutMs = 2000, retryMs = 20, staleMs = 10000 } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const fd = fs.openSync(file, 'wx', 0o600);
      try {
        writeAll(fd, `${process.pid} ${Date.now()}`);
      } catch (error) {
        // A lock file with a cut holder text would name the wrong pid; it was never held, so remove it.
        fs.closeSync(fd);
        try {
          fs.unlinkSync(file);
        } catch {}
        throw error;
      }
      fs.closeSync(fd);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        try {
          const holder = readHolder(file);
          if (holder && holder.pid === process.pid) fs.unlinkSync(file);
        } catch {}
      };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
    const holder = readHolder(file);
    if (isStale(holder, staleMs)) {
      if (breakStale(file, holder, staleMs)) continue;
      // Another breaker holds the guard, or left it behind; wait for it rather than spin. A stale lock always gets
      // broken in the end, so the wait may run past the deadline by the guard's own staleness window.
      if (Date.now() >= deadline + GUARD_STALE_MS + retryMs * 5) throw new LockTimeout(file);
      sleepMs(retryMs);
      continue;
    }
    if (Date.now() >= deadline) throw new LockTimeout(file);
    sleepMs(retryMs);
  }
}

export function withLock(file, fn, options) {
  const release = acquire(file, options);
  try {
    return fn();
  } finally {
    release();
  }
}
