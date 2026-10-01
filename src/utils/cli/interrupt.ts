/**
 * Copies of one Ctrl-C arrive within this window. Measured 2026-09-28: through `tools` and the
 * app launcher, every copy landed within 15 ms of the first.
 */
export const INTERRUPT_DUPLICATE_WINDOW_MS = 500;

export interface InterruptOptions {
    /** Runs once, on the first Ctrl-C, before the signal aborts. */
    onInterrupt?: () => void;
    duplicateWindowMs?: number;
    /** Tests only. */
    now?: () => number;
    /** Tests only. Production removes its listener and re-raises SIGINT, so the default action ends the process. */
    forceExit?: () => void;
}

/**
 * Run `fn` with a signal that aborts on Ctrl-C.
 *
 * One Ctrl-C reaches a tool several times: the terminal signals the whole foreground process group,
 * and `./tools` and GenesisTools.app's launcher each forward what they received to their child. A
 * `process.once` listener handles the first copy and leaves the next one to the default action, which
 * killed `tools jev grep` in the middle of printing the evidence it had already found. Copies inside
 * the window count as one. A separate, later Ctrl-C is the user insisting, and ends the process.
 */
export async function withInterrupt<T>(
    fn: (signal: AbortSignal) => Promise<T>,
    options: InterruptOptions = {}
): Promise<T> {
    const controller = new AbortController();
    const window = options.duplicateWindowMs ?? INTERRUPT_DUPLICATE_WINDOW_MS;
    const now = options.now ?? Date.now;
    let firstAt = 0;
    const handler = () => {
        if (!controller.signal.aborted) {
            firstAt = now();
            options.onInterrupt?.();
            controller.abort();
            return;
        }

        if (now() - firstAt <= window) {
            return;
        }

        if (options.forceExit) {
            options.forceExit();
            return;
        }

        process.off("SIGINT", handler);
        // pid-verified: process.pid is this process; re-raising lets the default SIGINT action end it.
        process.kill(process.pid, "SIGINT");
    };
    process.on("SIGINT", handler);
    try {
        return await fn(controller.signal);
    } finally {
        // A forwarded copy of the first Ctrl-C may still be on its way. Without a listener it would take
        // the default action and end the process while it prints what it found.
        const remaining = controller.signal.aborted ? window - (now() - firstAt) : 0;
        if (remaining > 0) {
            setTimeout(() => process.off("SIGINT", handler), remaining).unref();
        } else {
            process.off("SIGINT", handler);
        }
    }
}

/** What a shell reports for a process ended by Ctrl-C: 128 + SIGINT. */
export const INTERRUPTED_EXIT_CODE = 130;

/**
 * Make a Ctrl-C that a tool handles itself still end the process with 130, as an unhandled one does.
 *
 * Scripts and `a && b` chains read 130 as "interrupted". A tool that catches SIGINT to stop cleanly
 * (a follow closing its watcher, `withInterrupt` printing what it found) used to exit 130 only by
 * accident: `tools` and both launcher stages each forwarded the signal, and a later copy killed it.
 * With the wrapper exec'd and one launcher stage, the tool sees one copy and exited 0.
 *
 * The observer never changes what Ctrl-C does. With no other SIGINT listener it removes itself and
 * re-raises, so the default action ends the process exactly as before; with one, it only records the
 * interrupt, and a run that then ends with 0 exits 130. Any other exit code is kept.
 */
const observed = new WeakSet<object>();

export function observeInterrupts(target: NodeJS.Process = process): void {
    // Once per process: a second observer would count the first as the tool's own handler, and with
    // no real handler neither would re-raise, so Ctrl-C would be ignored.
    if (observed.has(target)) {
        return;
    }

    observed.add(target);
    let interrupted = false;
    const observer = () => {
        if (target.listenerCount("SIGINT") > 1) {
            interrupted = true;
            return;
        }

        target.off("SIGINT", observer);
        // pid-verified: target.pid is this process; re-raising lets the default SIGINT action end it.
        target.kill(target.pid, "SIGINT");
    };

    // First in line, so it records the interrupt even when the tool's own handler ends the process.
    target.prependListener("SIGINT", observer);
    target.on("exit", (code) => {
        if (interrupted && (code ?? 0) === 0) {
            target.exitCode = INTERRUPTED_EXIT_CODE;
        }
    });
}
