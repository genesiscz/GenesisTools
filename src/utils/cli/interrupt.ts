/**
 * Copies of one Ctrl-C arrive within this window. Measured 2026-09-28: through `tools` and the
 * app launcher, every copy landed within 15 ms of the first.
 */
export const INTERRUPT_DUPLICATE_WINDOW_MS = 500;

export interface InterruptOptions {
    /** Convert SIGTERM into cancellation too. The parent process must enforce any hard termination deadline. */
    handleTermination?: boolean;
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
    // Set by the first Ctrl-C only: a SIGTERM also aborts the signal, and must not make a first Ctrl-C look like a second.
    let firstAt: number | undefined;
    const handler = () => {
        if (firstAt === undefined) {
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
    const terminate = () => controller.abort();
    process.on("SIGINT", handler);
    if (options.handleTermination) {
        process.on("SIGTERM", terminate);
    }
    try {
        return await fn(controller.signal);
    } finally {
        // A forwarded copy of the first Ctrl-C may still be on its way. Without a listener it would take
        // the default action and end the process while it prints what it found.
        if (options.handleTermination) {
            process.off("SIGTERM", terminate);
        }
        const remaining = firstAt === undefined ? 0 : window - (now() - firstAt);
        const release = () => {
            process.off("SIGINT", handler);
            releaseInterruptObserver();
        };

        if (remaining > 0) {
            setTimeout(release, remaining).unref();
        } else {
            release();
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
 *
 * It is installed only once a tool has a SIGINT listener of its own. A JavaScript listener cannot run
 * while the event loop is blocked, so one installed up front made every tool unkillable during
 * synchronous work: `tools ai-spend` read gigabytes of transcripts in one blocking pass and ignored
 * Ctrl-C until it finished (measured 2026-10-04, 15 s). With no listener the kernel's default action
 * ends the process at once, which is what the observer would have done anyway.
 */
const observed = new WeakMap<object, () => void>();

/**
 * Detach the observer once its tool's last SIGINT listener is gone, so Ctrl-C takes the default action
 * again during later synchronous work. The next listener the tool adds attaches it again.
 *
 * Bun's `process` never emits `removeListener`, so the observer cannot notice a removal by itself:
 * the code that removes the tool's listener calls this. `withInterrupt` does. A handler a tool removes
 * on its own leaves the observer in place, as before.
 */
export function releaseInterruptObserver(target: NodeJS.Process = process): void {
    observed.get(target)?.();
}

export function observeInterrupts(target: NodeJS.Process = process): void {
    // Once per process: a second observer would count the first as the tool's own handler, and with
    // no real handler neither would re-raise, so Ctrl-C would be ignored.
    if (observed.has(target)) {
        return;
    }

    let interrupted = false;
    let attached = false;
    const observer = () => {
        if (target.listenerCount("SIGINT") > 1) {
            interrupted = true;
            return;
        }

        attached = false;
        target.off("SIGINT", observer);
        // pid-verified: target.pid is this process; re-raising lets the default SIGINT action end it.
        target.kill(target.pid, "SIGINT");
    };

    const attach = () => {
        if (attached) {
            return;
        }

        attached = true;
        // First in line, so it records the interrupt even when the tool's own handler ends the process.
        target.prependListener("SIGINT", observer);
    };

    observed.set(target, () => {
        if (attached && target.listenerCount("SIGINT") === 1) {
            attached = false;
            target.off("SIGINT", observer);
        }
    });
    target.on("exit", (code) => {
        if (interrupted && (code ?? 0) === 0) {
            target.exitCode = INTERRUPTED_EXIT_CODE;
        }
    });
    // `newListener` fires before the tool's listener is added, so the observer still sits first.
    target.on("newListener", (event, listener) => {
        if (event === "SIGINT" && listener !== observer) {
            attach();
        }
    });

    if (target.listenerCount("SIGINT") > 0) {
        attach();
    }
}
