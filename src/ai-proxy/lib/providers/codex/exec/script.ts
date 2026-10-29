import { CHARS_PER_TOKEN, truncateMiddle } from "@app/ai-proxy/lib/providers/codex/exec/exec-command";
import type { ExecCommand, ExecCommandArgs, ExecStore } from "@app/ai-proxy/lib/providers/codex/exec/types";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { isObject } from "@genesiscz/utils/object";

/**
 * The most an `exec` result prints after its header. Claude Code cuts a Bash tool's output at 30,000 characters
 * (`BASH_MAX_OUTPUT_LENGTH`, default 30000 in the 2.1.3xx binary) and keeps the rest in a file the model must read
 * again; the header and Claude Code's own lines fit in the 2,000 left over.
 */
export const EXEC_OUTPUT_CHARS = 28_000;

/** The nested tools a script can call, as `ALL_TOOLS` lists them. */
const NESTED_TOOLS = [
    {
        name: "exec_command",
        description: "Runs a shell command to its end and returns { output, exit_code, wall_time_seconds }.",
    },
];

const PRAGMA = /^[ \t]*\/\/ @exec:([^\r\n]*)/;

export interface ExecPragma {
    maxOutputTokens?: number;
    /** Accepted and ignored: a script always runs to its end. */
    yieldTimeMs?: number;
}

/** The optional first-line `// @exec: {...}` pragma; a line that is not valid JSON counts as no pragma. */
export function parseExecPragma(source: string): ExecPragma {
    const line = PRAGMA.exec(source);

    if (!line) {
        return {};
    }

    try {
        const parsed = SafeJSON.parse(line[1] ?? "", { strict: true });

        if (!isObject(parsed)) {
            return {};
        }

        const number = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : undefined);
        const maxOutputTokens = number(parsed.max_output_tokens);
        const yieldTimeMs = number(parsed.yield_time_ms);

        return {
            ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
            ...(yieldTimeMs !== undefined ? { yieldTimeMs } : {}),
        };
    } catch (err) {
        logger.debug({ err }, "ai-proxy exec: the pragma line is not JSON; it counts as no pragma");
        return {};
    }
}

/** `text(value)`: a string as it is, anything else through JSON when it can be, as Codex's `text` does. */
function textItem(value: unknown): string {
    if (typeof value === "string") {
        return value;
    }

    try {
        const json = SafeJSON.stringify(value);
        return typeof json === "string" ? json : String(value);
    } catch (err) {
        logger.debug({ err }, "ai-proxy exec: text() got a value JSON cannot hold");
        return String(value);
    }
}

class ExitSignal {}

function commandArgs(input: unknown): ExecCommandArgs {
    if (typeof input === "string") {
        return { cmd: input };
    }

    if (isObject(input) && typeof input.cmd === "string") {
        return { ...input, cmd: input.cmd };
    }

    throw new Error("exec_command failed: pass a command string or an object with a string `cmd`");
}

/**
 * Names the script sees in place of the real globals: a Codex script runs in a bare V8 isolate with "no Node, no file
 * system, no network access, no console", and its model writes for that. Work outside the script goes through
 * `tools.exec_command`, where the shell guard sees it.
 */
const HIDDEN_GLOBALS = ["process", "Bun", "require", "module", "console", "fetch"] as const;

export interface RunExecScriptOptions {
    source: string;
    execCommand: ExecCommand;
    store: ExecStore;
    now?: () => number;
}

/** Runs one `exec` script to its end and returns its result as Codex prints it, cut to fit Claude Code's Bash output. */
export async function runExecScript({
    source,
    execCommand,
    store,
    now = () => performance.now(),
}: RunExecScriptOptions): Promise<string> {
    const startedAt = now();
    const pragma = parseExecPragma(source);
    const items: string[] = [];
    const timers = new Set<ReturnType<typeof setTimeout>>();
    let failure: string | undefined;

    const helpers: Record<string, unknown> = {
        tools: { exec_command: (input: unknown) => execCommand(commandArgs(input)) },
        text: (value: unknown) => {
            items.push(textItem(value));
        },
        exit: () => {
            throw new ExitSignal();
        },
        store: (key: unknown, value: unknown) => store.store(String(key), value),
        load: (key: unknown) => store.load(String(key)),
        ALL_TOOLS: NESTED_TOOLS,
        setTimeout: (callback: () => void, delayMs?: number) => {
            const timer = setTimeout(() => {
                timers.delete(timer);
                callback();
            }, delayMs);
            timers.add(timer);
            return timer;
        },
        clearTimeout: (timer?: ReturnType<typeof setTimeout>) => {
            if (timer !== undefined) {
                timers.delete(timer);
                clearTimeout(timer);
            }
        },
    };

    try {
        const names = [...Object.keys(helpers), ...HIDDEN_GLOBALS];
        const body = new Function(...names, `return (async () => {\n${source}\n})();`);
        await body(...Object.values(helpers), ...HIDDEN_GLOBALS.map(() => undefined));
    } catch (error) {
        if (!(error instanceof ExitSignal)) {
            failure = error instanceof Error ? error.message : String(error);
        }
    }

    // Pending timeouts do not keep a script alive.
    for (const timer of timers) {
        clearTimeout(timer);
    }

    const seconds = Math.max(0, (now() - startedAt) / 1000).toFixed(1);
    const header = `Script ${failure === undefined ? "completed" : "failed"}\nWall time ${seconds} seconds\nOutput:\n`;
    const all = failure === undefined ? items : [...items, `Script error:\n${failure}`];
    const budget = Math.min(EXEC_OUTPUT_CHARS, (pragma.maxOutputTokens ?? Number.POSITIVE_INFINITY) * CHARS_PER_TOKEN);

    return header + truncateMiddle(all.join("\n"), Math.max(1, Math.floor(budget))).text;
}
