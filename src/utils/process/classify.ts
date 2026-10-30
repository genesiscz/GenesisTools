/**
 * What a process is, from its argv alone: an agent CLI (claude, codex, grok, cursor-agent), a
 * GenesisTools wrapper that started one (`tools claude run`), an MCP server, an agent's tool shell,
 * another GenesisTools process, or anything else. Pure, so the hub's resource monitor and its tests
 * read the same rules. `ps` space-joins argv, so every rule is a match on that string; none relies on
 * splitting a path that may contain spaces, except argv[0] of a bare binary.
 */

export const AGENT_PROVIDERS = ["claude", "codex", "grok", "cursor-agent"] as const;
export type AgentProvider = (typeof AGENT_PROVIDERS)[number];

export type ProcKind = "agent" | "wrapper" | "mcp" | "shell" | "tools" | "other";

export interface ProcClass {
    kind: ProcKind;
    provider: AgentProvider | null;
    /** Short readable name: "claude", "tools claude run", "context7-mcp", "claude tool shell". */
    label: string;
    /** A session id the argv or the environment names (`--resume <uuid>`, `…SESSION_ID='<uuid>'`). */
    sessionId: string | null;
    /**
     * An agent binary that runs one of its helpers instead of a session: a `codex-<name>` binary that names no session
     * (`codex-gateway serve`), or the CLI's own MCP door (`claude mcp serve`). It never makes a tab a live agent.
     */
    service: boolean;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** GenesisTools.app's launcher face: `…/GenesisTools.app/Contents/MacOS/GenesisTools <program> [args]`. */
const LAUNCHER_PREFIX = /^\S*\/GenesisTools\.app\/Contents\/MacOS\/GenesisTools\s+/;
/** `…/GenesisTools/src/<tool>/index.ts <verb>` (gt-* launchers, `bun run`) or `…/GenesisTools/tools <tool> <verb>`. */
const TOOL_ENTRY =
    /\/src\/([\w-]+)\/index\.tsx?(?:\s+(\S+))?|\/GenesisTools(?:\/\.worktrees\/[^/\s]+)?\/tools\s+([\w-]+)(?:\s+(\S+))?/;
const WRAPPER_TOOLS: Record<string, AgentProvider> = {
    claude: "claude",
    cc: "claude",
    codex: "codex",
    grok: "grok",
    cursor: "cursor-agent",
    "cursor-agent": "cursor-agent",
};
const WRAPPER_VERBS = new Set(["run", "resume", "start"]);
/** `tools <agent> run|start|resume …` from any checkout path or off PATH: the launcher that starts the agent. */
const TOOLS_LAUNCHER = /(?:^|[\s/])tools\s+([\w-]+)\s+(?:run|start|resume)\b/;
/** A Codex helper binary (`codex-gateway`); a versioned Codex binary has the same shape and tells itself apart by a session. */
const CODEX_HELPER = /^codex-[\w-]+$/;
const INTERPRETERS = /^(?:node|bun|bash|sh|zsh)$/;
const MCP = /mcp-server|mcporter|(?:^|[\s/@_-])mcp(?:$|[\s/_.-])|-mcp\b/i;
const CLAUDE_SHELL = /\/\.claude\/shell-snapshots\//;
const SHELL_SESSION = /SESSION_ID=['"]?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;

function basename(path: string): string {
    return path.split("/").pop() ?? path;
}

/** argv[0] up to the first space: exact for a bare binary; an .app path with a space is cut, and no agent CLI is one. */
function argv0(command: string): string {
    return command.trim().split(/\s+/)[0] ?? "";
}

function agentOf(command: string): AgentProvider | null {
    const first = argv0(command);

    if (first.includes(".app/Contents/")) {
        return null;
    }

    const name = basename(first);

    if (
        name === "claude" ||
        /\/claude\/versions\/[\d.]+$/.test(first) ||
        /@anthropic-ai\/claude-code\/cli\.m?js\b/.test(command)
    ) {
        return "claude";
    }

    if (/^codex(?:-[\w-]+)?$/.test(name) || /@openai\/codex\/bin\/codex\.m?js\b/.test(command)) {
        return "codex";
    }

    if (name === "cursor-agent" || /\/cursor-agent\/versions\/[^/\s]+\/index\.m?js\b/.test(command)) {
        return "cursor-agent";
    }

    if (
        name === "grok" ||
        /^grok-\d+(?:\.\d+)*(?:-[\w-]+)?$/.test(name) ||
        /\bgrok-cli\/dist\/index\.m?js\b/.test(command)
    ) {
        return "grok";
    }

    // A script agent started through an interpreter: `node /x/bin/cursor-agent`, `bash ~/.local/bin/grok`.
    const second = basename(command.trim().split(/\s+/)[1] ?? "");

    if (
        INTERPRETERS.test(name) &&
        (second === "cursor-agent" || second === "claude" || second === "grok" || second === "codex")
    ) {
        return second;
    }

    return null;
}

/** The session id an agent's argv names: `--resume <uuid>`, `-r <uuid>`, `--session-id <uuid>`, `resume <uuid>`. */
export function argvSessionId(command: string): string | null {
    const tokens = command.trim().split(/\s+/);

    for (let index = 0; index < tokens.length - 1; index++) {
        const flag = tokens[index];

        if (["--resume", "-r", "--session-id", "resume", "--continue-session"].includes(flag)) {
            const value = tokens[index + 1].replace(/^['"]|['"]$/g, "");

            if (UUID.test(value)) {
                return value;
            }
        }
    }

    const joined = command.match(/--(?:resume|session-id)=([0-9a-f-]{36})\b/i);
    return joined && UUID.test(joined[1]) ? joined[1] : null;
}

/** The first argument after the agent's entry (the binary, or the script an interpreter runs): `mcp` in `claude mcp serve`. */
function agentSubcommand(command: string): string | undefined {
    const tokens = command.trim().split(/\s+/);
    const entry = INTERPRETERS.test(basename(tokens[0] ?? "")) ? 1 : 0;

    return tokens[entry + 1];
}

function isAgentService(command: string, sessionId: string | null): boolean {
    if (agentSubcommand(command) === "mcp") {
        return true;
    }

    return !sessionId && CODEX_HELPER.test(basename(argv0(command)));
}

export function classifyCommand(raw: string): ProcClass {
    const command = raw.replace(LAUNCHER_PREFIX, "");
    const provider = agentOf(command);

    if (provider) {
        const sessionId = argvSessionId(command);
        return { kind: "agent", provider, label: provider, sessionId, service: isAgentService(command, sessionId) };
    }

    const tool = command.match(TOOL_ENTRY);

    if (tool) {
        const name = tool[1] ?? tool[3] ?? "";
        const verb = tool[2] ?? tool[4] ?? "";
        const label = `tools ${name}${verb && !verb.startsWith("-") ? ` ${verb}` : ""}`;
        const wrapped = WRAPPER_TOOLS[name];

        if (wrapped && WRAPPER_VERBS.has(verb)) {
            return { kind: "wrapper", provider: wrapped, label, sessionId: argvSessionId(command), service: false };
        }

        if (verb === "mcp" || name.includes("mcp")) {
            return { kind: "mcp", provider: null, label, sessionId: null, service: false };
        }

        return { kind: "tools", provider: null, label, sessionId: null, service: false };
    }

    if (CLAUDE_SHELL.test(command)) {
        return {
            kind: "shell",
            provider: "claude",
            label: "claude tool shell",
            sessionId: command.match(SHELL_SESSION)?.[1] ?? null,
            service: false,
        };
    }

    if (MCP.test(command)) {
        return { kind: "mcp", provider: null, label: mcpLabel(command), sessionId: null, service: false };
    }

    return { kind: "other", provider: null, label: basename(argv0(command)), sessionId: null, service: false };
}

/** Does this command line run the provider's agent itself, the binary or its script, and not one of its services? */
export function isAgentProcess(command: string, provider: AgentProvider): boolean {
    const proc = classifyCommand(command);

    return proc.kind === "agent" && proc.provider === provider && !proc.service;
}

/**
 * Does this command line run the provider's agent, as its own process, through a wrapper that starts it, or through
 * a `tools <agent> run|start|resume` launcher of any checkout or off PATH (`/repo/tools codex run`, `zsh -ic exec
 * tools cc resume <id>`)? The launcher form is not a wrapper for `classifyCommand`, which also reads it off a shell
 * that only mentions it.
 */
export function runsAgent(command: string, provider: AgentProvider): boolean {
    const proc = classifyCommand(command);

    if ((proc.kind === "agent" || proc.kind === "wrapper") && proc.provider === provider && !proc.service) {
        return true;
    }

    const launcher = command.match(TOOLS_LAUNCHER)?.[1];

    return launcher !== undefined && WRAPPER_TOOLS[launcher] === provider;
}

/** The token that names the MCP server: `context7-mcp`, `graft mcp` → `graft`, `…/bridgememory-mcp/server.cjs`. */
function mcpLabel(command: string): string {
    const tokens = command.trim().split(/\s+/);
    const at = tokens.findIndex((token) => /mcp/i.test(basename(token)) && !token.startsWith("-"));

    if (at > 0 && tokens[at] === "mcp") {
        return `${basename(tokens[at - 1])} mcp`;
    }

    if (at >= 0) {
        return basename(tokens[at]);
    }

    const pathed = tokens.find((token) => /mcp/i.test(token));

    if (pathed) {
        return pathed.split("/").find((part) => /mcp/i.test(part)) ?? basename(pathed);
    }

    return basename(tokens[0] ?? command);
}
