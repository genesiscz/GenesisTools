import type { PinAuth, PinAuthSource } from "@genesiscz/utils/agent-sessions/pins";

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
