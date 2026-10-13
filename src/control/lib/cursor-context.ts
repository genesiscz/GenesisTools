import { agentSessionIds } from "@genesiscz/utils/agent/host";
import { logger } from "@genesiscz/utils/logger";
import { captureSync, processBasename } from "@genesiscz/utils/process/ps";

/**
 * Context for the label beside the animated cursor: why the act happens and who drives it.
 *
 * ax-tool reads both variables in `ActionCursor.emit` and puts them on the label under the action
 * and its target, so a person watching the overlay sees which agent session is moving things and
 * what it said it was doing. Nothing here changes what the act does.
 */

/** The caller's description of the act (`--note` on the CLI, `note` in the computer-use API). */
export const CURSOR_NOTE_ENV = "GENESIS_CONTROL_CURSOR_NOTE";
/** Who drives the act. Computed from the agent host's session id unless the caller set it. */
export const CURSOR_SESSION_ENV = "GENESIS_CONTROL_CURSOR_SESSION";
/** Optional agent name a caller or a spawner sets ("reviewer", "fixer-2"); no host publishes one. */
export const AGENT_NAME_ENV = "GENESIS_AGENT_NAME";

const HOST_LABELS: Record<string, string> = {
    "claude-code": "Claude",
    codex: "Codex",
    grok: "Grok",
    copilot: "Copilot",
};

/** Shells, runtimes and wrappers between a person's app and this process; the label skips them. */
const PLUMBING = new Set([
    "zsh",
    "-zsh",
    "bash",
    "-bash",
    "sh",
    "fish",
    "bun",
    "node",
    "tools",
    "GenesisTools",
    "login",
    "env",
    "sudo",
    "timeout",
    "nohup",
    "script",
]);

export interface ProcessRow {
    pid: number;
    ppid: number;
    command: string;
}

/**
 * "Claude · 1b4001ba · reviewer" for an agent host, else the agent name and the nearest ancestor that
 * is not a shell or a runtime ("cmux", "Terminal"). Undefined when nothing names the driver.
 */
export function cursorSessionLabel({
    environment,
    ancestors,
}: {
    environment: NodeJS.ProcessEnv;
    ancestors?: () => string[];
}): string | undefined {
    const name = environment[AGENT_NAME_ENV]?.trim() || undefined;
    const [host] = agentSessionIds(environment);
    if (host) {
        return [HOST_LABELS[host.agent] ?? host.agent, host.id.slice(0, 8), name].filter(Boolean).join(" · ");
    }

    const parent = ancestors?.().find((command) => !PLUMBING.has(command));
    const label = [name, parent].filter(Boolean).join(" · ");
    return label || undefined;
}

/** Ancestor process names of `pid`, nearest first, from a table of every process. */
export function ancestorNames({ rows, pid }: { rows: ProcessRow[]; pid: number }): string[] {
    const byPid = new Map(rows.map((row) => [row.pid, row]));
    const names: string[] = [];
    let current = byPid.get(pid);
    for (let hops = 0; current && current.ppid > 1 && hops < 16; hops++) {
        const parent = byPid.get(current.ppid);
        if (!parent) {
            break;
        }

        names.push(processBasename(parent.command));
        current = parent;
    }

    return names;
}

export function parseProcessRows(stdout: string): ProcessRow[] {
    const rows: ProcessRow[] = [];
    for (const line of stdout.split("\n")) {
        const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/);
        if (match) {
            rows.push({ pid: Number(match[1]), ppid: Number(match[2]), command: match[3] });
        }
    }

    return rows;
}

/** One `ps` for the whole table, only when no agent host names the session. */
export function ancestorNamesOfThisProcess(): string[] {
    const result = captureSync("ps", ["-Ao", "pid=,ppid=,comm="], { timeoutMs: 1000 });
    if (result.status !== 0) {
        logger.debug({ status: result.status, stderr: result.stderr }, "cursor label: ps failed; no parent name");
        return [];
    }

    return ancestorNames({ rows: parseProcessRows(result.stdout), pid: process.pid });
}

/** The variables ax-tool reads; a key is present only when it has text. */
export function cursorEnvironment({ note, session }: { note?: string; session?: string }): Record<string, string> {
    const environment: Record<string, string> = {};
    const trimmedNote = note?.trim();
    if (trimmedNote) {
        environment[CURSOR_NOTE_ENV] = trimmedNote;
    }

    const trimmedSession = session?.trim();
    if (trimmedSession) {
        environment[CURSOR_SESSION_ENV] = trimmedSession;
    }

    return environment;
}
