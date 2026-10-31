import { isAgentLauncher } from "@app/cmux/lib/launchers";
import type { AccountEntry } from "@genesiscz/utils/ai/config/schema";
import { ACCOUNT_PROVIDER_ALIASES } from "@genesiscz/utils/ai/providers/alias-list";
import { harnessDriver, harnessPluginId } from "@genesiscz/utils/ai/providers/harness-index";
import { toolsEntrypoint } from "@genesiscz/utils/cli/tools";
import { hasMembers, toolParts } from "@genesiscz/utils/harness/tool-parts";
import { shellWords } from "@genesiscz/utils/session-changes/words";
import { shellCommandLine, shellQuote } from "@genesiscz/utils/shell/quote";
import type { SessionProviderBlocks } from "./session-store";

/** The agents `tools cmux agents new` can start: every harness. Each one has a `tools <id> run` door with the same shape. */
export const SESSION_AGENT_IDS = ACCOUNT_PROVIDER_ALIASES;

export type SessionAgentId = (typeof SESSION_AGENT_IDS)[number];

/**
 * The cmux part of a harness (`agents/<harness id>.ts`): what only the cmux tool knows about the
 * agent, for launch, capture, replay and restore. Everything else comes from the harness driver (`sessionAgent`).
 */
export interface CmuxAdapter {
    /** Whether its `tools <id> run` door takes `--cross-messages` / `--no-cross-messages` (Claude's peer channel). */
    crossMessages: boolean;
    /**
     * What `agents new` adds to the launch so a second client can reach the session without keystrokes: the
     * `tools <id> run` flags and the record block that names the endpoint. Null when the agent has no such launch.
     */
    launchExtras: ((input: { account: string; sessionId: string }) => SessionLaunchExtras) | null;
    /**
     * A tab title without what the agent draws around the session title: a ` - grok · <id>` suffix (Grok, Codex) or
     * a spinner glyph and ` · <id>` (Claude). Replay and adopt match the rest against session titles.
     */
    stripTitle(title: string): string;
    /** The prompt the agent waits at before it opens anything, which a restore may quit through; null for none. */
    trustPrompt: TrustPrompt | null;
}

/** A first-run dialog on the agent's screen: the text that shows it, and the key that quits the agent there. */
export interface TrustPrompt {
    screen: RegExp;
    quitKey: string;
}

export interface SessionAgent extends CmuxAdapter {
    id: SessionAgentId;
    /** Plugin id of the agent's accounts (`anthropic-sub`, `grok-sub`, `openai-sub`). */
    provider: string;
    /** What the agent's TUI quits on. `close` types it before it closes the workspace. */
    exitCommand: string;
    /** The native subcommand that resumes a session (`codex resume <id>`); null when a flag does it. */
    resumeSubcommand: string | null;
}

export interface SessionLaunchExtras {
    /** `tools <id> run` flags, placed before the prompt. */
    args: string[];
    /** The session record's provider block. */
    providers: SessionProviderBlocks;
}

/** The spinner glyph a busy or idle agent draws in front of its tab title. */
export const SPINNER_PREFIX = /^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏✳⠐●○◐◑◒◓]\s*/u;

/** A title stripper for a CLI that appends ` - <name>` (and an optional ` · <short id>`) to its tab title. */
export function harnessSuffixStripper(name: string): (title: string) => string {
    const suffix = new RegExp(`\\s+-\\s+${name}(?:\\s+·\\s+[0-9a-f]{7,8})?\\s*$`, "i");
    return (title) => title.replace(suffix, "").trim();
}

/**
 * The cmux part of every harness: `agents/<harness id>.ts` exports it as `cmuxPart` (`toolParts`), because its launch
 * extras need the cmux and grok tools, which `@genesiscz/utils` cannot import. A new harness adds its module there.
 */
export const CMUX_AGENTS = toolParts<CmuxAdapter>({
    meta: import.meta,
    folder: "agents",
    exportName: "cmuxPart",
    isPart: hasMembers<CmuxAdapter>("crossMessages", "launchExtras", "stripTitle", "trustPrompt"),
});

/** The cmux part of one harness. */
export function cmuxAdapter(id: SessionAgentId): CmuxAdapter {
    return CMUX_AGENTS.of(id);
}

export function isSessionAgentId(value: string): value is SessionAgentId {
    return (SESSION_AGENT_IDS as readonly string[]).includes(value);
}

export function sessionAgent(id: SessionAgentId): SessionAgent {
    return {
        id,
        provider: harnessPluginId(id),
        exitCommand: harnessDriver(id).parts.exit.command,
        resumeSubcommand: harnessDriver(id).parts.launch.resumeSyntax.subcommand ? "resume" : null,
        ...CMUX_AGENTS.of(id),
    };
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
    /**
     * Claude only: `true` passes `--cross-messages`, `false` passes `--no-cross-messages`, and unset passes neither,
     * so `tools claude run` applies the saved launch preference (`tools claude config cross-messages`).
     */
    crossMessages?: boolean;
    /** The agent's `launchExtras` flags, placed before the prompt. */
    agentArgs?: readonly string[];
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
        ...(input.crossMessages !== undefined && CMUX_AGENTS.of(input.agent).crossMessages
            ? [input.crossMessages ? "--cross-messages" : "--no-cross-messages"]
            : []),
        ...(input.agentArgs ?? []),
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

const PID_NOTE_RE = /^printf '%s' \$\$ > (?:'(?:[^']|'\\'')*'|\S+); /;

/**
 * Shell words up to `--` and the untouched tail, or undefined when the prefix holds anything but plain words
 * (an expansion, a pipe, a second command). Enough to read back what `shellCommandLine` wrote.
 */
function leadingShellWords(line: string): { words: string[]; passthrough?: string } | undefined {
    const words: string[] = [];
    let word = "";
    let inWord = false;

    for (let index = 0; index < line.length; index++) {
        const char = line[index];

        if (char === "'" || char === '"') {
            const end = line.indexOf(char, index + 1);
            const quoted = end < 0 ? undefined : line.slice(index + 1, end);

            if (quoted === undefined || (char === '"' && /[$`\\]/.test(quoted))) {
                return undefined;
            }

            word += quoted;
            inWord = true;
            index = end;
            continue;
        }

        if (char === "\\") {
            word += line[index + 1] ?? "";
            inWord = true;
            index++;
            continue;
        }

        if (/\s/.test(char)) {
            if (inWord && word === "--") {
                return { words, passthrough: line.slice(index) };
            }

            if (inWord) {
                words.push(word);
            }

            word = "";
            inWord = false;
            continue;
        }

        if (/[;&|<>()`$]/.test(char)) {
            return undefined;
        }

        word += char;
        inWord = true;
    }

    if (inWord && word !== "--") {
        words.push(word);
    }

    return { words };
}

function bareShellWord(word: string): string {
    return /^[A-Za-z0-9_./:@=-]+$/.test(word) ? word : shellQuote(word);
}

function agentRunParts(command: string): { agent: SessionAgentId; words: string[]; passthrough?: string } | undefined {
    const leading = leadingShellWords(command.trim().replace(PID_NOTE_RE, ""));
    if (!leading) {
        return undefined;
    }

    const { words } = leading;
    if (words.length < 4 || words[0].split("/").at(-1) !== "tools" || words[2] !== "run") {
        return undefined;
    }

    const agent = words[1];
    return isSessionAgentId(agent) ? { ...leading, agent } : undefined;
}

/** Literal executable and account from a tools-run prefix, even when its pass-through tail needs a session fallback. */
export function agentRunContext(
    command: string
): { agent: SessionAgentId; executable: string; account: string } | undefined {
    const parts = agentRunParts(command);
    return parts ? { agent: parts.agent, executable: parts.words[0], account: parts.words[3] } : undefined;
}

/**
 * The plain launcher inside a line `agentRunCommand` (and `withPidNote`) wrote, without the pid note and
 * without the prompt: `tools claude run work -m sonnet`, `tools codex run work`, `tools grok run work`. The account
 * stays, because a session lives in its account's home (Sonnet F13c: Codex and Grok tabs resumed under the default
 * home). Native options and Codex's resume tail stay intact; `droppedInitialTask` says whether a task was removed.
 * Undefined for any other command.
 *
 * Restore must resume the session such a tab ran. Replaying the recorded line itself sends the first
 * prompt again and starts a second session that repeats the whole task (2026-10-14: a production triage
 * tab would have started the triage over).
 */
export function agentRunLauncher(
    command: string
): { agent: SessionAgentId; launcher: string; droppedInitialTask: boolean } | undefined {
    const parts = agentRunParts(command);
    if (!parts) {
        return undefined;
    }

    const { agent, words, passthrough } = parts;

    // Native options and Codex's resume subcommand are not an initial task to remove.
    const firstArgument = passthrough ? shellWords(passthrough)[0] : undefined;
    const resume = sessionAgent(agent).resumeSubcommand;
    const native = firstArgument?.value.startsWith("-") || (resume !== null && firstArgument?.value === resume);
    const prefix = words.map(bareShellWord).join(" ");
    const launcher = native ? `${prefix} --${passthrough}` : prefix;
    if (native && !isAgentLauncher(launcher)) {
        return undefined;
    }

    return {
        agent,
        launcher,
        droppedInitialTask: Boolean(firstArgument) && !native,
    };
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
