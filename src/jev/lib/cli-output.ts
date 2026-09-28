import { suggestEnumFlag } from "@genesiscz/utils/cli";
import { withInterrupt } from "@genesiscz/utils/cli/interrupt";
import { ui } from "@genesiscz/utils/cli/ui";
import { logger, out } from "@genesiscz/utils/logger";

const ERROR_LINE_MAX_CHARS = 400;

/**
 * Shared output policy for the jev live-policy verbs.
 *
 * - Machine results go to stdout through `out.result` only.
 * - A terminal error is ONE plain stderr line plus `process.exitCode = 1`. The line never carries
 *   the input document: a comment-json parse error embeds the whole unparsed text, which is how
 *   `tools jev compact session.jsonl` once echoed 10 KB into a clack box. The full error goes to
 *   the log file.
 * - Human status lines use `ui.*` (dense, no clack box drawing).
 */
export function printResult(value: unknown): void {
    out.result(value);
}

export function failPlain(error: unknown, context?: Record<string, unknown>): void {
    const message = error instanceof Error ? error.message : String(error);
    logger.error({ error, ...context }, "jev command failed");
    const firstLine = message.split(/\r?\n/, 1)[0] ?? message;
    const shown =
        firstLine.length > ERROR_LINE_MAX_CHARS
            ? `${firstLine.slice(0, ERROR_LINE_MAX_CHARS)}… (${message.length} chars; full text in the log)`
            : firstLine;
    ui.err(shown);
    process.exitCode = 1;
}

/**
 * Runs `fn` with an AbortSignal that fires on SIGINT and is detached afterwards. The copies of one
 * Ctrl-C that `tools` and the app launcher forward count once; see `withInterrupt`.
 */
export async function withSigint<T>(fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
    return withInterrupt(fn, { onInterrupt: () => logger.info("SIGINT received; aborting the jev command") });
}

export function parseEnum<T extends readonly string[]>(
    value: string | boolean | undefined,
    values: T,
    flag: string,
    command: string
): T[number] | undefined {
    if (typeof value === "string" && (values as readonly string[]).includes(value)) {
        return value;
    }

    ui.err(suggestEnumFlag(command, flag, [...values]));
    process.exitCode = 1;
    return undefined;
}
