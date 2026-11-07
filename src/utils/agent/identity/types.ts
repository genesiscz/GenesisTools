import type { AgentRuntimeContext, CallerAgent, CallerCore, ScopedCaller } from "@genesiscz/utils/agent/context";
import type { HarnessId } from "@genesiscz/utils/harness/types";
import type { CallerTerminals, TerminalId, TerminalSource } from "./terminals";

export type { CallerAgent, CallerCore, CallerTerminals, ScopedCaller, TerminalId };

/**
 * Where one fact came from. A source names the caller (`hook-payload`, `caller-scope`, `env`); a facet
 * or an enricher describes it (`git`, `history`, `process`, `transcript`, a terminal's own source from
 * `TERMINAL_ENRICHERS` (`cmux`, `tmux`, `terminal` for the terminal app), `account`, `t3code` for the
 * host's env thread id and `t3code-store` for the details read from the host's own database); `override` is a value
 * the caller of `whoIsCalling` passed in.
 */
export type FactSource =
    | "hook-payload"
    | "caller-scope"
    | "env"
    | "override"
    | "fallback-cwd"
    | "process-cwd"
    | "session-cwd"
    | "git"
    | "history"
    | "process"
    | "transcript"
    | TerminalSource
    | "t3code"
    | "t3code-store"
    | "account";

/** The cmux surface a caller runs in, as its environment names it. */
export interface CmuxTerminal {
    surfaceId: string;
    workspaceId: string | null;
    tabId: string | null;
}

/** The tmux pane a caller runs in, as its environment names it. */
export interface TmuxTerminal {
    pane: string;
}

/** The terminal app a caller runs in, as its environment names it: its program and its own session ids. */
export interface TerminalApp {
    program: string | null;
    itermSessionId: string | null;
    termSessionId: string | null;
}

/**
 * The host app a caller runs inside (T3 Code), apart from its harness: the thread is the HOST's id, never the
 * provider's session id. The lazy fields come from the host's own store only when the `host` facet is asked.
 */
export interface CallerHost {
    app: "t3code";
    threadId: string;
    providerInstanceId?: string | null;
    model?: string | null;
    projectId?: string | null;
    projectRoot?: string | null;
    parentThreadId?: string | null;
    relationshipToParent?: string | null;
    /** The thread's title in T3 Code, and its parent thread's, so a record can name both without a second read. */
    title?: string | null;
    parentTitle?: string | null;
}

/** The account a caller's harness bills, from the launcher's stamp: an account name, or a proxy target instead. */
export interface CallerAccount {
    /** The harness whose stamp it is (its alias names the variable through `accountEnvVar`). */
    harness: HarnessId;
    account: string | null;
    proxyTarget: string | null;
}

/** The process a caller runs as and its parents, nearest first. Filled only for the `process` facet. */
export interface CallerProcess {
    pid: number;
    ancestry: { pid: number; command: string }[];
}

/**
 * One shape for who is calling, for every log: today's `AgentRuntimeContext` facts plus the model, the effort, the
 * transcript, the turn, subagent and tool call, the account, the terminals, the host app and the process. Every fact
 * is optional, and `sources` says where each one that is set came from.
 */
export interface AgentIdentity extends CallerCore {
    sourceMessage?: AgentRuntimeContext["sourceMessage"];
    isInAgent: boolean;
    aiAgent: string | null;
    sessionTitle?: string | null;
    cwd?: string;
    project?: string;
    repoRoot?: string;
    isWorktree?: boolean;
    worktreePath?: string | null;
    branch?: string | null;
    commitSha?: string | null;
    commitMessage?: string | null;
    model?: string | null;
    effort?: string | null;
    transcriptPath?: string | null;
    turnId?: string;
    subagentId?: string;
    toolUseId?: string;
    account?: CallerAccount;
    terminal?: CallerTerminals;
    host?: CallerHost;
    process?: CallerProcess;
    sources: Partial<Record<FactPath, FactSource>>;
}

export type IdentityField = Exclude<keyof AgentIdentity, "sources">;

/**
 * A part of a field that an observer of its own fills: the cmux surface and the tmux pane sit side by side in
 * `terminal`, and the host's thread id (its env) is a separate observation from the details its database adds. An
 * override of the whole field is recorded under the field itself (`terminal`, `host`).
 */
export type FactPart = `terminal.${TerminalId}` | "host.threadId" | "host.details";

/** What `sources` is keyed by: a whole field, or one independently observed part of it. */
export type FactPath = IdentityField | FactPart;

/**
 * The facts that cost I/O, filled only when asked. `cwd` is the session's live cwd (a process walk); `git` the six
 * checkout facts; `title` the history cache; `transcript` and `model` the harness reader's bounded lookup; `host` the
 * host app's own store; `process` the parent chain.
 */
export type IdentityFacet = "cwd" | "git" | "title" | "transcript" | "model" | "host" | "process";

/**
 * What a hook payload says about its caller, typed: `src/agents/lib/hooks/payload.ts` reads the raw fields (it is
 * their one reader) and hands these over, so this module never touches a raw payload.
 */
export interface HookCallerFacts {
    /** The harness that ran the hook (its id, `claude`), or `copilot`, the host that is no harness. */
    caller: HarnessId | "copilot";
    sessionId?: string;
    toolUseId?: string;
    subagentId?: string;
    turnId?: string;
    model?: string;
    transcriptPath?: string;
    cwd?: string;
}

/** The loopback connection of a remote MCP caller, which the gateway resolves to its owning process (`readPeerCaller`). */
export interface PeerQuery {
    clientPort: number;
    serverPort: number;
    /** The folder that replaces a harness's own session registry (Claude's `~/.claude/sessions`) in a test. */
    registryDirOf?: (harness: HarnessId) => string | undefined;
}

/**
 * A caller in this process tree: its environment is ours to read (a CLI run, a hook, a stdio MCP server). A hook
 * payload, when there is one, names the caller ahead of the environment.
 */
export interface LocalCallerInput {
    origin: "local";
    env: NodeJS.ProcessEnv;
    hook?: HookCallerFacts;
}

/**
 * A caller a resident server serves (the MCP gateway): this process's environment, terminal and account describe
 * nobody it serves, so the input has no `env` at all and nothing reads ours.
 */
export interface RemoteCallerInput {
    origin: "remote";
    /** The caller a request scope holds; the gateway resolves it once per request from the connection's owner. */
    caller?: ScopedCaller;
}

export type CallerInput = LocalCallerInput | RemoteCallerInput;

export interface WhoIsCallingOptions {
    /** The costly facts to fill. None by default: the env-only path does no I/O. */
    facets?: readonly IdentityFacet[];
    /** Values that win over every source; a fact given here is never read (no `git` spawn for a given branch). */
    overrides?: Partial<Omit<AgentIdentity, "sources">>;
    /**
     * The cwd to use when a caller scope exists whose session is explicitly null (a remote caller the gateway could
     * not name): applied below `overrides.cwd` and before the git facts, so they describe the same folder.
     */
    fallbackCwd?: string;
    /** The clock of the transcript lookup's date bound. */
    now?: Date;
    /** The user home the default agent homes sit under; tests pass a fixture. */
    home?: string;
    /** The parent chain of the `process` facet, nearest first (`ancestry` by default); tests pass a fixed chain. */
    processChain?: (pid: number) => CallerProcess["ancestry"];
}

/**
 * One reader of who the caller is: this interface is the seam. `whoIsCalling` asks each source in a fixed order
 * (`CALLER_SOURCES`), and a test replaces them with fakes.
 */
export interface CallerSource {
    readonly id: FactSource;
    read(input: CallerInput): CallerReading | undefined;
}

/** What one source says. `agent` is the caller it names, `unknown` when it names none but knows other facts. */
export type CallerReading = Partial<Omit<AgentIdentity, "sources" | "agent">> & { agent: CallerAgent };

/** The one field group each enricher owns, keyed by the enricher's id. An enricher can write nothing else. */
export interface EnricherSlots {
    /** Every terminal of `TERMINAL_ENRICHERS` the environment names, each under its own source path. */
    terminal: CallerTerminals;
    t3code: CallerHost;
    account: CallerAccount;
}

export type EnricherId = keyof EnricherSlots;

/**
 * What an enricher may look at: the chosen caller (read-only), the caller's environment (a local caller's own, or the
 * keys a request read from a remote caller's process) and the facets asked for.
 */
export interface EnricherView {
    readonly caller: Readonly<Pick<AgentIdentity, "agent" | "sessionId">>;
    readonly env: NodeJS.ProcessEnv;
    readonly facets: ReadonlySet<IdentityFacet>;
}

/**
 * A fact that does not name the caller but describes its place (its terminal, its host app, its account). It returns
 * only its own slot; the composer places it, so an enricher can never change the caller's harness or session, and a
 * failed or absent one leaves every other fact intact.
 */
export interface ContextEnricher<Id extends EnricherId> {
    readonly id: Id;
    /**
     * The variables `enrich` reads for this caller, by name. A remote caller's env is read from its own process by
     * exactly these names (the gateway's peer), so a new enricher reaches a remote caller with no other edit.
     */
    envKeys(caller: EnricherView["caller"]): readonly string[];
    enrich(view: EnricherView): EnricherSlots[Id] | undefined;
}
