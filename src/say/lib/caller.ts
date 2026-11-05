import { basename } from "node:path";
import { type AgentIdentity, type CallerProcess, whoIsCalling } from "@genesiscz/utils/agent/identity";
import { env } from "@genesiscz/utils/env";
import { runtimeAgentOfCommand } from "@genesiscz/utils/process/classify";
import { profiler } from "@genesiscz/utils/profile";

const prof = profiler.scope("agent-context");

/** One process on the way from the `tools say` invocation up to launchd. */
export type AncestryFrame = CallerProcess["ancestry"][number];

/**
 * Who ran `tools say`, captured in the foreground process BEFORE it exits.
 *
 * The detached speaker child cannot capture this: its parent is the foreground
 * process, which is gone within a second, and the shell above it exits with it.
 */
export interface CallerContext {
    /** `claude-code` / `codex` / `grok` / `copilot`, or `unknown` for a plain terminal. */
    agent: string;
    sessionId: string | null;
    /** The host's own agent label, e.g. `claude-code_2-1-263_agent` from `AI_AGENT`. */
    aiAgent: string | null;
    /** The account the caller's harness was launched as (`tools claude run`, teammate wrappers); a proxy target is not an account. */
    account: string | null;
    surfaceId: string | null;
    workspaceId: string | null;
    tabId: string | null;
    tmuxPane: string | null;
    termProgram: string | null;
    cwd: string;
    /** The parent of the `tools say` process: normally the shell the agent ran the command in. */
    callerPid: number;
    /** Parent chain from `callerPid` upward, nearest first. Empty when the process table could not be read. */
    ancestry: AncestryFrame[];
}

const SHELL_BASENAMES = new Set(["zsh", "bash", "sh", "fish", "dash"]);
const RUNTIME_BASENAMES = new Set(["bun", "node"]);

function argv0Basename(command: string): string {
    const argv0 = command.trim().split(/\s+/)[0] ?? "";
    return basename(argv0);
}

/** Is this frame an agent running a session (a harness or Copilot; not an MCP door or a helper binary)? */
function isAgentFrame(command: string): boolean {
    return runtimeAgentOfCommand(command) !== null;
}

function isLauncherFrame(base: string, command: string): boolean {
    return (
        base === "GenesisTools" ||
        base.startsWith("gt-") ||
        /\/src\/say\/index\.tsx?\b/.test(command) ||
        /\/tools say\b/.test(command)
    );
}

function scriptLabel(command: string): string {
    const tokens = command.trim().split(/\s+/).slice(1);

    if (tokens[0] === "run") {
        tokens.shift();
    }

    const script = tokens.shift();

    if (!script) {
        return argv0Basename(command);
    }

    const repoRelative = script.replace(/^.*\/GenesisTools\//, "");
    const label = repoRelative === script ? basename(script) : repoRelative;

    return [label, ...tokens.slice(0, 3)].join(" ");
}

/**
 * The chain as a short, human line: `zsh ← claude[64911] ← zsh ← tools cc run foltyn ← cmux`.
 * Launcher frames (the GenesisTools.app launcher, its `gt-*` shims, the `tools say`
 * wrapper itself) are noise on every call and are dropped.
 */
export function describeAncestry(frames: AncestryFrame[]): string {
    const labels: string[] = [];

    for (const frame of frames) {
        const base = argv0Basename(frame.command);

        if (!base || isLauncherFrame(base, frame.command)) {
            continue;
        }

        if (isAgentFrame(frame.command)) {
            labels.push(`${base}[${frame.pid}]`);
            continue;
        }

        if (SHELL_BASENAMES.has(base)) {
            labels.push(base);
            continue;
        }

        if (RUNTIME_BASENAMES.has(base)) {
            labels.push(scriptLabel(frame.command));
            continue;
        }

        labels.push(base);
    }

    return labels.join(" ← ");
}

/**
 * The call log's caller row from an identity (the process facet filled). The agent is the identity's: with the process
 * facet, a caller the environment does not name is named by its parent chain there, and gets that harness's account.
 * The terminal and account come from the identity's own facets: a blank value is no value, and an account is the one
 * the caller's harness was launched as.
 */
export function callerContextOf(identity: AgentIdentity, extra: { callerPid: number }): CallerContext {
    const ancestry = identity.process?.ancestry ?? [];

    return {
        agent: identity.agent,
        sessionId: identity.sessionId,
        aiAgent: identity.aiAgent,
        account: identity.account?.account ?? null,
        surfaceId: identity.terminal?.cmux?.surfaceId ?? null,
        workspaceId: identity.terminal?.cmux?.workspaceId ?? null,
        tabId: identity.terminal?.cmux?.tabId ?? null,
        tmuxPane: identity.terminal?.tmux?.pane ?? null,
        termProgram: identity.terminal?.app?.program ?? null,
        cwd: identity.cwd ?? process.cwd(),
        callerPid: extra.callerPid,
        ancestry,
    };
}

/** Everything about the process that ran `tools say`. Kernel reads, `ps` only for other users' frames; never throws. */
export async function captureCallerContext(): Promise<CallerContext> {
    return prof.measureAsync("say.captureCallerContext", readCallerContext);
}

async function readCallerContext(): Promise<CallerContext> {
    const identity = whoIsCalling({ origin: "local", env: env.getProcessEnv() }, { facets: ["process"] });
    return callerContextOf(identity, { callerPid: process.ppid });
}
