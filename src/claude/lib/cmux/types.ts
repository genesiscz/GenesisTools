/** How a session's account pin was learned. */
export type PinSource = "hook" | "manual";

/**
 * One `session id → account` fact, written by the SessionStart hook from inside the
 * claude process (where TOOLS_CLAUDE_ACCOUNT is visible). `account: null` means the
 * session ran on the plain keychain login, which is a real answer, not a missing one.
 */
/**
 * How the session authenticated.
 *
 * `token` is `tools claude start <account>`, which exports CLAUDE_CODE_OAUTH_TOKEN.
 * `keychain` is `--keychain`, where the account's secondary login is injected into the
 * macOS keychain and no token is exported. Both set TOOLS_CLAUDE_ACCOUNT to the same
 * name, so the account alone cannot tell them apart, and resuming a keychain session
 * on a token bills a different credential than the one it ran on.
 * Absent on pins written before this was recorded.
 */
export type PinAuth = "token" | "keychain";
/**
 * Where `auth` came from. The SessionStart hook used to infer `keychain` whenever
 * `CLAUDE_CODE_OAUTH_TOKEN` was missing, but Claude Code strips that secret from
 * hook children — so every `tools claude start <account>` pin was recorded as
 * keychain. Resume only trusts `keychain` when the source is the launch env or
 * the `--keychain` argv. Pre-fix pins have no source and resume on the token path.
 */
export type PinAuthSource = "launch-env" | "argv" | "oauth-env" | "default-named" | "default-bare";

export interface SessionPin {
    sessionId: string;
    account: string | null;
    auth?: PinAuth;
    authSource?: PinAuthSource;
    model: string | null;
    cwd: string;
    /** cmux's stable workspace UUID (CMUX_WORKSPACE_ID), when the session ran inside cmux. */
    workspaceId: string | null;
    source: PinSource;
    /** Epoch ms of the hook event that produced this record. */
    at: number;
}

/** A resumable session offered in the picker, enriched with everything worth showing. */
export interface RestoreCandidate {
    sessionId: string;
    /** Working directory to resume in — the transcript's own cwd, so worktrees survive. */
    cwd: string;
    /** Project label (the repo directory name), used for per-project workspace grouping. */
    project: string;
    branch: string | null;
    /** Custom title, else the generated summary, else the first prompt. */
    title: string | null;
    /** Last user prompt in the transcript — what you were doing when it stopped. */
    lastPrompt: string | null;
    /** Set when the session ended on a rate-limit error. */
    limitStop: string | null;
    /** Set when the session worked in a subdirectory of the project (a worktree, a package). */
    subdir: string | null;
    mtimeMs: number;
    account: string | null;
    model: string | null;
    /** How the pinned session authenticated; absent for sessions with no pin. */
    auth?: PinAuth;
    authSource?: PinAuthSource;
    /** True when a pin record exists; distinguishes "keychain login" from "never recorded". */
    pinned: boolean;
}

export type LayoutMode = "capped" | "grid" | "tabs";

export interface PlannedSession {
    candidate: RestoreCandidate;
    /** Account this pane will launch as; null means let `tools claude start` ask. */
    account: string | null;
    model: string | null;
}

export interface PlannedPane {
    paneIndex: number;
    /** More than one session means extra surfaces (tabs) stacked in this pane. */
    sessions: PlannedSession[];
}

export interface PlannedWorkspace {
    title: string;
    /** cwd the workspace itself opens in (the first session's). */
    cwd: string;
    panes: PlannedPane[];
}

export interface RestorePlan {
    workspaces: PlannedWorkspace[];
}

/** A saved set of sessions plus the workspace grouping they had when captured. */
export interface SessionSnapshot {
    name: string;
    capturedAt: string;
    entries: SnapshotEntry[];
}

export interface SnapshotEntry {
    sessionId: string;
    cwd: string;
    project: string;
    title: string | null;
    account: string | null;
    model: string | null;
    workspaceId: string | null;
}
