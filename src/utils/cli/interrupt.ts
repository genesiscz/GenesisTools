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
        process.kill(process.pid, "SIGINT");
    };
    process.on("SIGINT", handler);
    try {
        return await fn(controller.signal);
    } finally {
        process.off("SIGINT", handler);
    }
}
