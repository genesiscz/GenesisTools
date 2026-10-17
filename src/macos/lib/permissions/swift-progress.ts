/**
 * SwiftPM prints one `[done/total] Action subject` line per build step when its output is not a terminal. The app
 * build used to read all of it after the build ended (`Bun.spawnSync`), so `tools hub` sat silent for the whole
 * minute of a cold build and looked stuck. These helpers turn those lines into a short, throttled message.
 */
export interface SwiftBuildProgress {
    done: number;
    total: number;
    action: string;
    subject: string;
}

const PROGRESS_LINE = /^\[(\d+)\/(\d+)]\s+(\S+)(?:\s+(.+))?$/;

export function parseSwiftBuildProgress(line: string): SwiftBuildProgress | null {
    const match = PROGRESS_LINE.exec(line.trim());

    if (!match) {
        return null;
    }

    const [, done, total, action, rest] = match;
    // `Compiling GenesisKit Foo.swift` names the module and then the file: the last word is the useful one.
    const subject = rest?.trim().split(/\s+/).at(-1) ?? "";
    return { done: Number(done), total: Number(total), action, subject };
}

/**
 * No percentage: SwiftPM finds more steps while it builds (a cold app build went 760 -> 1088 steps), so a percentage
 * fell from 97% to 69% on a real build and read as going backwards. Counts of a growing total read honestly.
 */
export function formatSwiftBuildProgress(progress: SwiftBuildProgress, elapsedMs: number): string {
    const seconds = Math.floor(elapsedMs / 1000);
    const subject = progress.subject ? ` ${progress.subject}` : "";
    return `swift build step ${progress.done} of ${progress.total}: ${progress.action}${subject}, ${seconds} s`;
}

/**
 * Feeds raw build lines in and calls `emit` with a formatted message: for the first progress line, then at most once
 * per `intervalMs`. A line that is not progress (a warning, an error) is ignored here; the caller keeps all output.
 */
export function createSwiftProgressReporter(
    emit: (message: string) => void,
    intervalMs: number,
    now: () => number = () => performance.now()
): (line: string) => void {
    const started = now();
    let lastEmit = Number.NEGATIVE_INFINITY;

    return (line) => {
        const progress = parseSwiftBuildProgress(line);

        if (!progress) {
            return;
        }

        const at = now();

        if (at - lastEmit < intervalMs) {
            return;
        }

        lastEmit = at;
        emit(formatSwiftBuildProgress(progress, at - started));
    };
}

interface ProgressSpinner {
    start(message?: string): void;
    message(message?: string): void;
    stop(message?: string): void;
}

/** Outside a terminal a spinner cannot redraw, so the progress becomes a plain line this often. */
export const PLAIN_PROGRESS_EVERY_MS = 15_000;

/**
 * How a CLI shows an app build: each step as a line, and the `swift build` progress as one spinner line that
 * redraws in place (a terminal) or as a plain line every 15 s (a pipe or a log). The next step, and `finish`, stop
 * the spinner on its last message, so a failure never prints under a running spinner.
 */
export function createBuildProgressDisplay(options: {
    step: (message: string) => void;
    /** Needed only with `interactive`; without one the progress is printed as plain lines. */
    spinner?: () => ProgressSpinner;
    interactive?: boolean;
    now?: () => number;
}): { onStep: (message: string) => void; onProgress: (message: string) => void; finish: () => void } {
    const now = options.now ?? (() => performance.now());
    const interactive = options.interactive ?? process.stderr.isTTY === true;
    let spinner: ProgressSpinner | null = null;
    let last = "";
    let lastPlain = Number.NEGATIVE_INFINITY;

    const finish = () => {
        if (spinner) {
            spinner.stop(last);
            spinner = null;
        }
    };

    return {
        onStep: (message) => {
            finish();
            options.step(message);
        },
        onProgress: (message) => {
            last = message;

            if (!interactive || !options.spinner) {
                const at = now();

                if (at - lastPlain >= PLAIN_PROGRESS_EVERY_MS) {
                    lastPlain = at;
                    options.step(message);
                }

                return;
            }

            if (spinner) {
                spinner.message(message);
                return;
            }

            spinner = options.spinner();
            spinner.start(message);
        },
        finish,
    };
}
