import { basename } from "node:path";
import type { Harness } from "../hooks/harness";
import { readProcessBasics } from "./process-basics";

const HARNESSES: readonly Harness[] = ["claude", "codex", "grok"];
const MAX_ANCESTORS = 12;

/** The agent process a hook belongs to. */
export interface AgentProcess {
    harness: Harness;
    pid: number;
}

/** An agent process as the ancestor walk found it, with what it was started with. */
export interface FoundAgent extends AgentProcess {
    command: string;
    /** Its controlling terminal (`ttys003`); null for none. */
    tty: string | null;
}

/** Accept only supported coding-agent harness names at untrusted input boundaries. */
export function harnessNamed(value: unknown): Harness | null {
    return HARNESSES.find((harness) => harness === value) ?? null;
}

/** Identify a coding agent from its executable or Node CLI script, including versioned binary names. */
export function agentNamed(command: string): Harness | null {
    const [program = "", script = ""] = command.trim().split(/\s+/, 2);

    for (const arg of [program, script]) {
        const harness = harnessNamed(/^(claude|codex|grok)(?:$|[-.])/.exec(basename(arg))?.[1]);

        if (harness) {
            return harness;
        }
    }

    // An npm install of Claude Code runs as `node …/@anthropic-ai/claude-code/cli.js`.
    return command.includes("/@anthropic-ai/claude-code/") ? "claude" : null;
}

/**
 * The agent process this hook belongs to: the nearest ancestor whose program is claude, codex or grok.
 * A hook runs under a shell, so its parent is rarely the agent itself. One kernel read per level, no
 * spawn. The nearest one is right also for a Codex worker started from a
 * Claude session, whose chain holds both.
 */
export function findAgentProcess(startPid = process.ppid): FoundAgent | null {
    let pid = startPid;

    for (let depth = 0; depth < MAX_ANCESTORS && pid > 1; depth++) {
        const basics = readProcessBasics(pid);

        if (!basics || basics.command === null) {
            return null;
        }

        const harness = agentNamed(basics.command);

        if (harness) {
            return { harness, pid, command: basics.command, tty: basics.tty };
        }

        pid = basics.ppid;
    }

    return null;
}

/** Flags that make each agent run one scripted turn instead of its terminal UI. */
const HEADLESS_FLAGS: Record<Harness, ReadonlySet<string>> = {
    // `--input-format stream-json` is the Agent SDK driving claude over stdin.
    claude: new Set(["-p", "--print", "--input-format"]),
    grok: new Set(["-p", "--prompt", "--prompt-file"]),
    codex: new Set(),
};
const CODEX_HEADLESS_COMMANDS = new Set(["exec", "e", "app-server", "mcp-server", "mcp", "proto"]);

/**
 * True for an agent that runs without its terminal UI: `claude -p`, `grok -p`, `codex exec`, a Codex
 * app-server. Such a process is never the tab's occupant, even though it inherits the tab's
 * CMUX_SURFACE_ID and, unless it was detached, its controlling terminal as well: a babysit grok worker
 * and a Codex app-server both wrote session records onto the Claude tab that started them (2026-10-14).
 */
export function isHeadlessAgent(agent: { harness: Harness; command: string }): boolean {
    const tokens = agent.command.trim().split(/\s+/);

    if (agent.harness === "codex") {
        const at = tokens.findIndex((token) => /^codex(?:$|[-.])/.test(basename(token)));
        return tokens.slice(at + 1).some((token) => CODEX_HEADLESS_COMMANDS.has(token));
    }

    return tokens.some((token) => HEADLESS_FLAGS[agent.harness].has(token));
}
