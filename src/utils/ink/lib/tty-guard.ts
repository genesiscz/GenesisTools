import { isInteractive } from "@genesiscz/utils/cli/is-interactive";
import { out } from "@genesiscz/utils/logger";

/**
 * Checks stdin is a TTY before an Ink screen tries to mount. Ink's `useInput`
 * raw-mode hook throws a full React/reconciler stack when stdin is not a TTY
 * (agents, CI, cron — vadimdemedes/ink#"isRawModeSupported"), which reads as a
 * crash rather than a clear message (#446 item 4).
 *
 * Prints ONE line to stderr, sets `process.exitCode = 1`, and returns false so
 * every blocked entry point exits the same way without each call site having
 * to remember to set it.
 *
 * `stdin` is the stream Ink will read: pass `options.stdin` when the render gets
 * one, since Ink uses it instead of process.stdin.
 */
export function requireInteractiveTty(input: { hint?: string; stdin?: { isTTY?: boolean } } = {}): boolean {
    const interactive = input.stdin ? input.stdin.isTTY === true : isInteractive();

    if (interactive) {
        return true;
    }

    const suffix = input.hint ? `; ${input.hint}` : "";
    out.printlnErr(`this view needs an interactive terminal${suffix}`);
    process.exitCode = 1;
    return false;
}
