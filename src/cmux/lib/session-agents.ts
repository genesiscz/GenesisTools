import type { AccountEntry } from "@genesiscz/utils/ai/config/schema";
import { PROVIDER_ALIASES } from "@genesiscz/utils/ai/providers/aliases";
import { shellCommandLine, shellQuote } from "@genesiscz/utils/shell/quote";

/** The agents `tools cmux session agent new` can start. Each one has a `tools <id> run` door with the same shape. */
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

    const argv = ["tools", input.agent, "run", account, ...(input.model ? ["-m", input.model] : [])];

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

/** The account a new session runs as: the one asked for, else the app default, else the only enabled one. */
export function pickSessionAccount<T extends AccountChoice>(input: {
    agent: SessionAgent;
    accounts: readonly T[];
    /** `@account/<id>` from the app default of the agent (`defaults.app.<agent>.chat.model`), if any. */
    appDefaultModel?: string;
    requested?: string;
}): T {
    const enabled = input.accounts.filter((account) => account.provider === input.agent.provider && account.enabled);
    const names = enabled.map((account) => account.name).join(", ") || "none";

    if (input.requested) {
        const needle = input.requested.toLowerCase();
        const exact = enabled.filter((account) => account.id === input.requested || account.name === input.requested);
        const hits =
            exact.length > 0 ? exact : enabled.filter((account) => account.name.toLowerCase().includes(needle));

        if (hits.length === 1) {
            return hits[0];
        }

        throw new Error(
            hits.length === 0
                ? `no ${input.agent.id} account matches "${input.requested}" (known: ${names})`
                : `"${input.requested}" matches ${hits.length} ${input.agent.id} accounts: ${hits.map((a) => a.name).join(", ")}`
        );
    }

    const defaultId = input.appDefaultModel?.match(/^@account\/([^:]+)/)?.[1];
    const byDefault = defaultId ? enabled.find((account) => account.id === defaultId) : undefined;

    if (byDefault) {
        return byDefault;
    }

    if (enabled.length === 1) {
        return enabled[0];
    }

    throw new Error(`no default ${input.agent.id} account; pass --account <name> (known: ${names})`);
}
