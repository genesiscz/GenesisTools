import type { AccountEntry } from "@genesiscz/utils/ai/config/schema";
import { PROVIDER_ALIASES } from "@genesiscz/utils/ai/providers/aliases";
import { toolsEntrypoint } from "@genesiscz/utils/cli/tools";
import { shellCommandLine, shellQuote } from "@genesiscz/utils/shell/quote";

/** The agents `tools cmux agents new` can start. Each one has a `tools <id> run` door with the same shape. */
export const SESSION_AGENT_IDS = ["claude", "grok", "codex"] as const;

export type SessionAgentId = (typeof SESSION_AGENT_IDS)[number];

export interface SessionAgent {
    id: SessionAgentId;
    /** Plugin id of the agent's accounts (`anthropic-sub`, `grok-sub`, `openai-sub`). */
    provider: string;
    /** What the agent's TUI quits on. `close` types it before it closes the workspace. */
    exitCommand: string;
}

const AGENTS: Record<SessionAgentId, SessionAgent> = {
    claude: { id: "claude", provider: PROVIDER_ALIASES.claude, exitCommand: "/exit" },
    grok: { id: "grok", provider: PROVIDER_ALIASES.grok, exitCommand: "/exit" },
    codex: { id: "codex", provider: PROVIDER_ALIASES.codex, exitCommand: "/quit" },
};

export function isSessionAgentId(value: string): value is SessionAgentId {
    return (SESSION_AGENT_IDS as readonly string[]).includes(value);
}

export function sessionAgent(id: SessionAgentId): SessionAgent {
    return AGENTS[id];
}

/** An inline prompt is typed into the terminal, so it stays small; a longer one goes through --prompt-file. */
const PROMPT_CAP = 8_192;

/**
 * The shell line typed into the new workspace: `tools <agent> run <account> [-m <model>] [-- <prompt>]`.
 * A prompt file is read when the line runs (`"$(cat file)"`), so a long prompt is never typed.
 */
export function agentRunCommand(input: {
    agent: SessionAgentId;
    account: string;
    model?: string;
    prompt?: string;
    promptFile?: string;
    /** Claude only: start it with `--cross-messages`, so `tools claude message` lands without approval. */
    crossMessages?: boolean;
}): string {
    const account = input.account.trim();

    if (!account) {
        throw new Error("account is required");
    }

    if (input.prompt && input.promptFile) {
        throw new Error("pass only one of --prompt and --prompt-file");
    }

    if (input.prompt && Buffer.byteLength(input.prompt, "utf8") > PROMPT_CAP) {
        throw new Error(`prompt is over ${PROMPT_CAP} bytes; pass it with --prompt-file instead`);
    }

    // This checkout's entrypoint, never a bare `tools`: in a worktree that resolves off $PATH to the main checkout.
    const argv = [
        toolsEntrypoint(),
        input.agent,
        "run",
        account,
        ...(input.model ? ["-m", input.model] : []),
        ...(input.crossMessages && input.agent === "claude" ? ["--cross-messages"] : []),
    ];

    if (input.promptFile) {
        return `${shellCommandLine([...argv, "--"])} "$(cat ${shellQuote(input.promptFile)})"`;
    }

    if (input.prompt) {
        return shellCommandLine([...argv, "--", input.prompt]);
    }

    return shellCommandLine(argv);
}

/**
 * The run line with a pid note in front: the shell that runs it writes its own pid first, so `close` can
 * tell when the agent has quit (the shell has no child left) without scanning other processes.
 */
export function withPidNote(command: string, pidFile: string): string {
    return `printf '%s' $$ > ${shellQuote(pidFile)}; ${command}`;
}

export type AccountChoice = Pick<AccountEntry, "id" | "name" | "provider" | "enabled">;

/**
 * The account a new session runs as: exactly the one asked for (id, name, or a unique part of the name).
 * There is no default on purpose: the caller lists the accounts with their budgets and lets the user (or
 * an agent that tells the user) choose.
 */
export function pickSessionAccount<T extends AccountChoice>(input: {
    agent: SessionAgent;
    accounts: readonly T[];
    requested: string;
}): T {
    const enabled = input.accounts.filter((account) => account.provider === input.agent.provider && account.enabled);
    const names = enabled.map((account) => account.name).join(", ") || "none";
    const needle = input.requested.toLowerCase();
    const exact = enabled.filter((account) => account.id === input.requested || account.name === input.requested);
    const hits = exact.length > 0 ? exact : enabled.filter((account) => account.name.toLowerCase().includes(needle));

    if (hits.length === 1) {
        return hits[0];
    }

    throw new Error(
        hits.length === 0
            ? `no ${input.agent.id} account matches "${input.requested}" (known: ${names})`
            : `"${input.requested}" matches ${hits.length} ${input.agent.id} accounts: ${hits.map((a) => a.name).join(", ")}`
    );
}
