import type { AccountProviderAlias } from "@genesiscz/utils/ai/providers/alias-list";
import { classifyCommand } from "@genesiscz/utils/process/classify";
import type { ProcessEntry } from "@genesiscz/utils/process/processes";
import { isShellProgram } from "@genesiscz/utils/shell/programs";

/**
 * What runs in a tab, from its tty's processes. This is the one place that reads an agent off a command line: it
 * asks `classifyCommand` (src/utils/process/classify.ts), which knows binary paths, node and bun wrappers, the
 * GenesisTools.app launcher and every resume flag (`--resume`, `-r`, `--session-id`, `resume`, `--resume=`).
 * Four hand-rolled readers did this before, each with its own subset (review F27).
 */

/** An agent session running on a tty, read off its process command line. */
export interface TtyAgent {
    kind: AccountProviderAlias;
    sessionId?: string;
}

/**
 * The ttys where this user runs exactly one process, and it is a shell: the tab's own login shell, waiting at
 * its prompt. Any other process (an agent, an ssh, a `tail -f`, a background job) makes the tab busy, and so
 * does a SECOND shell: a script that runs under `bash` and waits for input looks like a shell by name, and
 * typing into it would feed its stdin (2026-10-14, caught by the live proof). `login` is root's, so it is not
 * counted.
 */
export function idleShellTtys(processes: ProcessEntry[], uid: number): Set<string> {
    const byTty = new Map<string, ProcessEntry[]>();

    for (const entry of processes) {
        if (entry.tty && entry.uid === uid && !entry.zombie) {
            byTty.set(entry.tty, [...(byTty.get(entry.tty) ?? []), entry]);
        }
    }

    const idle = new Set<string>();

    for (const [tty, entries] of byTty) {
        if (entries.length === 1 && isShellProgram(entries[0].name)) {
            idle.add(tty);
        }
    }

    return idle;
}

/** The agent process a command line runs (`/…/claude --resume <id>`, `grok -r <id>`), its session lower-cased. */
export function agentOfCommand(command: string): TtyAgent | undefined {
    const proc = classifyCommand(command);

    // A wrapper (node or bun running the agent's script, a versioned binary) runs the agent too.
    if (
        (proc.kind !== "agent" && proc.kind !== "wrapper") ||
        (proc.provider !== "claude" && proc.provider !== "grok" && proc.provider !== "codex")
    ) {
        return undefined;
    }

    return { kind: proc.provider, ...(proc.sessionId ? { sessionId: proc.sessionId.toLowerCase() } : {}) };
}

/** `tools <agent> run|start|resume …` from any checkout path: the launcher that starts the agent. */
const TOOLS_AGENT_LAUNCHER = /(?:^|[\s/])tools\s+(claude|cc|grok|codex)\s+(?:run|start|resume)\b/;

/** Does this command line run the agent, as its process or through the `tools <agent>` launcher? */
export function commandRunsAgent(command: string, agent: AccountProviderAlias): boolean {
    const proc = classifyCommand(command);

    if ((proc.kind === "agent" || proc.kind === "wrapper") && proc.provider === agent) {
        return true;
    }

    const launcher = command.match(TOOLS_AGENT_LAUNCHER)?.[1];
    return (launcher === "cc" ? "claude" : launcher) === agent;
}

/** The agent each busy tty runs, from the first agent command line on it (`/…/grok -r <id>`, `claude --resume <id>`). */
export function agentsOnTtys(processes: ProcessEntry[], uid: number): Map<string, TtyAgent> {
    const agents = new Map<string, TtyAgent>();

    for (const entry of processes) {
        if (!entry.tty || entry.uid !== uid || entry.zombie || !entry.command || agents.has(entry.tty)) {
            continue;
        }

        const agent = agentOfCommand(entry.command);

        if (agent) {
            agents.set(entry.tty, agent);
        }
    }

    return agents;
}

/** Every recognized running session id → its tty or `(no tty)`, including agents sharing a tty and headless runs. */
export function runningAgentSessions(processes: ProcessEntry[], uid: number): Map<string, string> {
    const sessions = new Map<string, string>();

    for (const entry of processes) {
        if (entry.uid !== uid || entry.zombie || !entry.command) {
            continue;
        }

        const agent = agentOfCommand(entry.command);

        if (agent?.sessionId) {
            sessions.set(agent.sessionId, entry.tty ?? "(no tty)");
        }
    }

    return sessions;
}
