import { createHash } from "node:crypto";
import { shellQuote } from "@genesiscz/utils/shell/quote";

/** Claude Code's longest Bash timeout (`BASH_MAX_TIMEOUT_MS`, default 600000): a script runs to its end within it. */
export const EXEC_BASH_TIMEOUT_MS = 600_000;

const DELIMITER_PREFIX = "GT_EXEC_";
/** The hash lengths a delimiter may use, shortest first; a longer one is taken only if the script holds the shorter. */
const DELIMITER_HEX_LENGTHS = [8, 16, 64];
const RUNNER_FILE = "/exec/runner.ts";

function sha256Hex(text: string): string {
    return createHash("sha256").update(text).digest("hex");
}

/**
 * The heredoc delimiter for a script, given the script's sha256: `GT_EXEC_` and its first 8 hex digits, or 16 or 64
 * when the script holds that line itself. A fixed delimiter would end the heredoc early at a script line that equals
 * it; this one would have to be in the script whose hash names it.
 */
export function delimiterFor(js: string, hash: string): string {
    const lines = new Set(js.split("\n"));

    for (const length of DELIMITER_HEX_LENGTHS) {
        const delimiter = `${DELIMITER_PREFIX}${hash.slice(0, length)}`;

        if (!lines.has(delimiter)) {
            return delimiter;
        }
    }

    throw new Error("exec: the script holds every delimiter its own sha256 names");
}

export function execDelimiter(js: string): string {
    return delimiterFor(js, sha256Hex(js));
}

/** The Bash tool input that runs one `exec` script: the runner reads the script verbatim from a quoted heredoc. */
export interface ExecBashInput {
    command: string;
    description: string;
    timeout: number;
}

/** The first line of the script that says something, for Claude Code's one-line description of the call. */
function summaryLine(js: string): string {
    const line = js
        .split("\n")
        .map((text) => text.trim())
        .find((text) => text.length > 0 && !text.startsWith("// @exec:"));
    const text = line ?? "script";

    return text.length > 80 ? `${text.slice(0, 77)}...` : text;
}

export function execBashInput({
    js,
    bun,
    runner,
    sessionId,
}: {
    js: string;
    /** The Bun binary that runs the runner, by absolute path. */
    bun: string;
    /** The runner file, by absolute path, in the proxy's own checkout. */
    runner: string;
    /** The Claude Code session, whose `store` and `load` the script uses. */
    sessionId?: string;
}): ExecBashInput {
    const delimiter = execDelimiter(js);
    const session = sessionId ? ` --session ${shellQuote(sessionId)}` : "";

    return {
        command: `${shellQuote(bun)} ${shellQuote(runner)}${session} <<'${delimiter}'\n${js}\n${delimiter}`,
        description: `exec: ${summaryLine(js)}`,
        timeout: EXEC_BASH_TIMEOUT_MS,
    };
}

const COMMAND_SHAPE = new RegExp(`^([^\\n]*)<<'(${DELIMITER_PREFIX}[0-9a-f]+)'\\n`);

/**
 * The script of a Bash command `execBashInput` built, byte for byte, or undefined for any other command. The runner
 * path may be any checkout's (a worktree's, the main one's), so only its file name is checked; the delimiter must
 * be the one the script's own hash names, so a command that only looks alike is left alone.
 */
export function parseExecBashCommand(command: string): string | undefined {
    const head = COMMAND_SHAPE.exec(command);

    if (!head) {
        return undefined;
    }

    const prefix = head[1] ?? "";
    const delimiter = head[2] ?? "";
    const tail = `\n${delimiter}`;

    if (!prefix.includes(RUNNER_FILE) || !command.endsWith(tail) || command.length < head[0].length + tail.length) {
        return undefined;
    }

    const js = command.slice(head[0].length, command.length - tail.length);

    return execDelimiter(js) === delimiter ? js : undefined;
}
