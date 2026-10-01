/**
 * The `tools` wrapper's orphan watchdog, for a worker the wrapper exec'd into directly (no
 * GenesisTools launcher in between, which happens under a GenesisTools app face). The wrapper
 * used to stay as this worker's parent only to poll for this.
 *
 * macOS has no PR_SET_PDEATHSIG: when the process that started `tools` dies, this worker is
 * reparented to launchd (ppid 1) and would run on for days. So: SIGTERM ourselves, and SIGKILL
 * 5 s later if a handler kept us alive. Detached starts never get this preload (tool-exec.ts).
 *
 * No imports on purpose: it runs before every such tool, so it must cost nothing to load.
 */

const POLL_MS = 2000;
const KILL_AFTER_MS = 5000;

const timer = setInterval(() => {
    if (process.ppid !== 1) {
        return;
    }

    clearInterval(timer);
    // pid-verified: process.pid is read live for this very process, never from stored state, so it cannot be recycled.
    process.kill(process.pid, "SIGTERM");
    // pid-verified: the timer runs only inside this process, so process.pid still names it when SIGKILL follows.
    setTimeout(() => process.kill(process.pid, "SIGKILL"), KILL_AFTER_MS).unref();
}, POLL_MS);

timer.unref();
