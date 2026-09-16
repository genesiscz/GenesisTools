/**
 * Provider-neutral statusline contract.
 *
 * A coding-agent host (Claude Code today; Codex and Grok have no statusline hook yet) pipes a
 * JSON document to a command on every render. The host's `StatuslineFeature` turns that
 * document into a `StatuslinePayload`, and the generic renderer in `./render.ts` turns the
 * payload into one or two lines. Everything the renderer cannot know about the host (which
 * model a transcript really ran, what the session is called, which account launched it)
 * comes back through the feature's optional resolvers.
 */

export interface StatuslineUsage {
    inputTokens: number;
    cacheCreationTokens: number;
    cacheReadTokens: number;
}

export interface StatuslinePayload {
    /** Host id, e.g. `claude-code`. */
    host: string;
    cwd: string;
    projectDir: string | null;
    sessionId: string | null;
    transcriptPath: string | null;
    /** The host's own idea of the model, which may lag a `/model` switch. */
    modelDisplayName: string | null;
    contextWindowSize: number | null;
    usage: StatuslineUsage | null;
    /** True for a subagent frame; the graft line is the only thing rendered for those. */
    isAgentFrame: boolean;
    /** The raw stdin document, forwarded verbatim to extension scripts and the metrics post. */
    raw: Record<string, unknown>;
}

export interface AccountSegmentData {
    name: string;
    /** Rounded percentages, null when the bucket is absent. */
    fiveHour: number | null;
    sevenDay: number | null;
    sevenDayFable: number | null;
    /** The account's own poll is a replay (expired grant, org block). */
    stale: boolean;
    /** Epoch ms of the cache write the numbers came from. */
    fetchedAt: number | null;
}

export interface StatuslineExtension {
    /** A command run with the raw payload on stdin; its stdout lines join the output. */
    command: string;
    position: "before" | "after";
    /** Kill it after this long and drop its output. */
    timeoutMs: number;
}

export interface StatuslineConfig {
    /** Token delta since the previous render, from a per-session state file. */
    showDelta: boolean;
    /** Session title or short id plus the last message time. */
    showSession: boolean;
    /** Account name plus cached usage percentages. */
    showAccount: boolean;
    /** Branch and dirty count. */
    showGit: boolean;
    /** Append graft's graph line in a checkout that has a graph. */
    graft: { enabled: boolean; shim: string; ttlMs: number };
    /** Post the raw payload to a local metrics sink, fire and forget. */
    metricsPost: { enabled: boolean; url: string; timeoutMs: number };
    /** How long a git branch and dirty count may be reused before `git status` runs again. */
    gitTtlMs: number;
    /** Wrap another statusline script: run it and place its lines before or after ours. */
    extends: StatuslineExtension | null;
    /** Terminal width to assume when none can be detected. */
    fallbackColumns: number;
    /** The host's statusline command before `install` replaced it, so `uninstall` can put it back. */
    previousCommand: string | null;
}

export interface RenderTimings {
    [step: string]: number;
}

export interface RenderResult {
    lines: string[];
    timings: RenderTimings;
    /** Background work that outlives the lines (the metrics post); resolves when done or timed out. */
    settled: Promise<void>;
}

/** Everything a host contributes. Members are optional so a host can start small. */
export interface StatuslineFeature {
    /** Human name of the host, e.g. "Claude Code". */
    readonly host: string;
    /** Turn the host's stdin document into the neutral payload, or null when it is not this host's. */
    parsePayload(raw: Record<string, unknown>): StatuslinePayload | null;
    /** The model that really produced the last turn, when the host's field lags. Returns a display name. */
    resolveModel?(payload: StatuslinePayload): Promise<string | null>;
    /** Wall-clock of the last real message, as local `HH:MM:SS`, for the prompt-cache gauge. */
    resolveLastMessageTime?(payload: StatuslinePayload): Promise<string | null>;
    /** A user-set session title. */
    resolveSessionName?(payload: StatuslinePayload): Promise<string | null>;
    /** The subscription account this session runs as, plus its cached usage. */
    resolveAccount?(payload: StatuslinePayload): Promise<AccountSegmentData | null>;
    /** Whether the host reserves an autocompact buffer; null when the host has no such setting. */
    resolveAutocompact?(): Promise<boolean | null>;
    /** The host's settings file that names the statusline command. */
    settingsPath(): string;
    /** The command the host currently runs, or null when none is set. */
    readInstalledCommand(): Promise<string | null>;
    /** Set (or with null, remove) the statusline command in the host's settings. */
    writeInstalledCommand(command: string | null): Promise<void>;
}
