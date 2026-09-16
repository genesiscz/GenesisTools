import { basename } from "node:path";
import { resolveAgentHost } from "@genesiscz/utils/agent/host";
import { env } from "@genesiscz/utils/env";
import { logger } from "@genesiscz/utils/logger";

const { log } = logger.scoped("say:caller");

/** One process on the way from the `tools say` invocation up to launchd. */
export interface AncestryFrame {
    pid: number;
    command: string;
}

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
    /** `TOOLS_CLAUDE_ACCOUNT`, set by `tools claude run` / teammate wrappers. */
    account: string | null;
    surfaceId: string | null;
    workspaceId: string | null;
    tabId: string | null;
    tmuxPane: string | null;
    termProgram: string | null;
    cwd: string;
    /** The parent of the `tools say` process: normally the shell the agent ran the command in. */
    callerPid: number;
    /** Parent chain from `callerPid` upward, nearest first. Empty when `ps` failed. */
    ancestry: AncestryFrame[];
}

const MAX_ANCESTRY_DEPTH = 20;
const MAX_COMMAND_CHARS = 240;
const PS_TIMEOUT_MS = 2000;

const AGENT_BASENAMES: Record<string, string> = {
    claude: "claude-code",
    codex: "codex",
    grok: "grok",
    copilot: "copilot",
};

const SHELL_BASENAMES = new Set(["zsh", "bash", "sh", "fish", "dash"]);
const RUNTIME_BASENAMES = new Set(["bun", "node"]);

async function runPs(args: string[]): Promise<string> {
    const proc = Bun.spawn(["ps", ...args], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const timer = setTimeout(() => proc.kill("SIGKILL"), PS_TIMEOUT_MS);

    try {
        const [stdout, stderr] = await Promise.all([
            new Response(proc.stdout).text(),
            new Response(proc.stderr).text(),
        ]);
        const code = await proc.exited;

        if (code !== 0) {
            throw new Error(`ps ${args.join(" ")} exited ${code}: ${stderr.trim()}`);
        }

        return stdout;
    } finally {
        clearTimeout(timer);
    }
}

/** Parse `ps -axo pid=,ppid=` into pid → ppid. */
export function parsePidParents(stdout: string): Map<number, number> {
    const parents = new Map<number, number>();

    for (const line of stdout.split("\n")) {
        const match = line.trim().match(/^(\d+)\s+(\d+)$/);

        if (!match) {
            continue;
        }

        parents.set(Number.parseInt(match[1], 10), Number.parseInt(match[2], 10));
    }

    return parents;
}

/** Follow ppid links from `start` upward, stopping before launchd (pid 1) or at a cycle. */
export function walkParents(parents: Map<number, number>, start: number, maxDepth = MAX_ANCESTRY_DEPTH): number[] {
    const chain: number[] = [];
    let pid = start;

    while (pid > 1 && chain.length < maxDepth && !chain.includes(pid)) {
        chain.push(pid);
        const parent = parents.get(pid);

        if (parent === undefined) {
            break;
        }

        pid = parent;
    }

    return chain;
}

/** Parse `ps -p … -o pid=,command=` into pid → command. */
export function parsePidCommands(stdout: string): Map<number, string> {
    const commands = new Map<number, string>();

    for (const line of stdout.split("\n")) {
        const match = line.match(/^\s*(\d+)\s+(.*)$/);

        if (!match) {
            continue;
        }

        commands.set(Number.parseInt(match[1], 10), match[2].trim().slice(0, MAX_COMMAND_CHARS));
    }

    return commands;
}

/**
 * The parent chain of `startPid`, nearest first. Two `ps` calls: the pid→ppid
 * table is tiny, and the full argv is then fetched for the chain only.
 * Any failure logs and returns an empty chain, so speech is never blocked.
 */
export async function captureAncestry(startPid: number): Promise<AncestryFrame[]> {
    try {
        const parents = parsePidParents(await runPs(["-axo", "pid=,ppid="]));
        const chain = walkParents(parents, startPid);

        if (chain.length === 0) {
            return [];
        }

        const commands = parsePidCommands(await runPs(["-p", chain.join(","), "-o", "pid=,command="]));

        return chain.map((pid) => ({ pid, command: commands.get(pid) ?? "" }));
    } catch (err) {
        log.debug({ err, startPid }, "could not capture the caller's process ancestry");
        return [];
    }
}

function argv0Basename(command: string): string {
    const argv0 = command.trim().split(/\s+/)[0] ?? "";
    return basename(argv0);
}

/** The agent binary nearest to the caller in the chain, when the environment did not say. */
export function agentFromAncestry(frames: AncestryFrame[]): string {
    for (const frame of frames) {
        const agent = AGENT_BASENAMES[argv0Basename(frame.command)];

        if (agent) {
            return agent;
        }
    }

    return "unknown";
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

        if (AGENT_BASENAMES[base]) {
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

/** Everything about the process that ran `tools say`. One `ps` round-trip; never throws. */
export async function captureCallerContext(): Promise<CallerContext> {
    const processEnv = env.getProcessEnv();
    const host = resolveAgentHost(processEnv);
    const ancestry = await captureAncestry(process.ppid);
    const agent = host.agent && host.agent !== "unknown" ? host.agent : agentFromAncestry(ancestry);

    return {
        agent,
        sessionId: host.sessionId ?? null,
        aiAgent: host.aiAgent ?? processEnv.AI_AGENT ?? null,
        account: processEnv.TOOLS_CLAUDE_ACCOUNT ?? null,
        surfaceId: processEnv.CMUX_SURFACE_ID ?? null,
        workspaceId: processEnv.CMUX_WORKSPACE_ID ?? null,
        tabId: processEnv.CMUX_TAB_ID ?? null,
        tmuxPane: processEnv.TMUX_PANE ?? null,
        termProgram: processEnv.TERM_PROGRAM ?? null,
        cwd: process.cwd(),
        callerPid: process.ppid,
        ancestry,
    };
}
