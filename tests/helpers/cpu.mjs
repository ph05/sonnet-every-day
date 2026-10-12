// CPU-time meter for the performance tests. Wall-clock budgets fail on a loaded machine (the same 8 MB validation took 2 to 9 s of wall time
// for under 1 s of CPU), so the budgets are CPU time. But this process's own CPU time (process.cpuUsage) misses what it hands to child
// processes (the validator runs `node --check` children) and everything spent waiting, so the meter adds the CPU of the children this
// process has waited for (cutime + cstime of /proc/self/stat; Linux only, elsewhere the children count as 0) and the tests keep a loose
// wall-clock backstop next to the CPU budget: an order-of-magnitude stall still fails, a busy machine does not.
import fs from 'node:fs';
import os from 'node:os';

/**
 * How many times slower than an idle machine a wall-clock bound should be allowed to be right now: the 1-minute load average per CPU,
 * at least 1. The "does not hang" and "stays fast" bounds that cannot be CPU budgets (a browser, a timeout) are multiplied by it, so they
 * keep their full strictness on an idle machine (CI, the kaizen gate) and stop failing on a box shared with other test runs
 * (it was at 6 runnable processes per CPU while this was written, and a 6 s browser run took 40 s).
 */
export const loadFactor = () => Math.max(1, os.loadavg()[0] / Math.max(1, os.availableParallelism()));

/** Clock ticks per second of the /proc counters: USER_HZ, 100 on every Linux the suite runs on (`getconf CLK_TCK`). */
const TICKS_PER_SECOND = 100;

/** CPU time of the children this process has waited for so far, in ms; 0 where /proc is not available. */
export function childCpuMs() {
  try {
    const stat = fs.readFileSync('/proc/self/stat', 'utf8');
    // field 2 (the command name) is in parentheses and may hold spaces: count the fields after the last ')'. Field 3 is index 0, so
    // cutime (field 16) is index 13 and cstime (field 17) is index 14.
    const rest = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    const ticks = Number(rest[13]) + Number(rest[14]);
    return Number.isFinite(ticks) ? (ticks * 1000) / TICKS_PER_SECOND : 0;
  } catch {
    return 0;
  }
}

/** True where childCpuMs() can see children (Linux). */
export const childCpuAvailable = () => {
  try {
    return fs.existsSync('/proc/self/stat');
  } catch {
    return false;
  }
};

/**
 * Starts a meter: `stop()` returns { cpuMs, ownMs, childMs, wallMs } since the call. cpuMs = this process's user+system time plus the CPU
 * of the children it waited for in between.
 */
export function startMeter() {
  const own0 = process.cpuUsage();
  const child0 = childCpuMs();
  const wall0 = performance.now();
  return {
    stop() {
      const own = process.cpuUsage(own0);
      const ownMs = (own.user + own.system) / 1000;
      const childMs = Math.max(0, childCpuMs() - child0);
      return { cpuMs: ownMs + childMs, ownMs, childMs, wallMs: performance.now() - wall0 };
    },
  };
}
