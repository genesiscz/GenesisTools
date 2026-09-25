/** How a file was changed: a harness file tool names its path exactly; `bash` is inferred from a shell call. */
export type ChangeVia = "edit" | "write" | "notebook" | "bash";

/**
 * How sure the attribution is.
 * - `exact`: a file tool changed it (the transcript names the path and the tool succeeded).
 * - `high`: a shell command NAMED the path as a write target and a capture saw it change.
 * - `medium`: a capture saw it change during a command that can write files it does not name
 *   (a codemod, a formatter pass, a script).
 * - `low`: the command names it as a write target but no capture confirms the change.
 */
export type ChangeConfidence = "exact" | "high" | "medium" | "low";

/**
 * Why a detected change is not the session's own work. Every reason has one rule in
 * `rules.ts` or `command.ts` and one test.
 */
export type ExclusionReason =
    /** git rewrote the working tree: checkout, switch, rebase, merge, stash, reset, pull, commit hooks. */
    | "git-rewrite"
    /** A test runner's output: coverage, junit, snapshots, or anything a test-only command left. */
    | "test-output"
    /** A build's output: dist/, build/, .build/, target/, node_modules/, or anything a build-only command left. */
    | "build-output"
    /** A log file: `*.log`, or a file under a `logs/` directory. */
    | "log-file"
    /** A cache: `.cache/`, `~/.genesis-tools`, `~/Library/Caches`, tool caches. */
    | "cache"
    /** A temporary directory: the OS temp dir, `/tmp`, `/var/folders`. */
    | "temp-dir"
    /** A lockfile changed in a turn that ran no install. */
    | "lockfile-churn"
    /** Outside every working directory of the session, and no file tool named it. */
    | "outside-cwd"
    /** An app bundle or a compiled binary. */
    | "app-bundle"
    /** Git's own metadata under `.git/` (index, refs, info/exclude), never a working-tree file. */
    | "git-metadata"
    /** The command only reads (or only runs tests/builds), so the change came from another writer. */
    | "not-written-by-command"
    /** The file tool call failed, so it changed nothing. */
    | "tool-failed";

/** One row of the per-session change log the agents hook writes (`~/.genesis-tools/agents/<id>/changes.jsonl`). */
export interface LoggedChange {
    ts: string;
    session: string;
    turn: string;
    tool: string;
    /** The tool call that made the change. Rows written before 2026-09-24 do not carry it. */
    toolUseId?: string;
    cwd: string;
    path: string;
    beforeOid: string | null;
    afterOid: string | null;
    source: "edit" | "write" | "bash";
    skipped?: "binary" | "large";
}

/** One tool call of the session, read from the transcript. */
export interface SessionToolCall {
    id: string;
    turnId: string;
    name: string;
    /** When the model emitted the call (epoch ms), or null when the transcript has no time. */
    startedAt: number | null;
    /** When its result was recorded (epoch ms), or null for a call without a result. */
    finishedAt: number | null;
    cwd: string | null;
    /** The subagent that made the call, or null for the main thread. */
    agentId: string | null;
    isError: boolean;
    /** `file_path` / `notebook_path` of a file tool. */
    filePath: string | null;
    /** The Bash command text. */
    command: string | null;
    /** File-tool bytes: the text before the call (null for a created file) and after it, when derivable. */
    before?: string | null;
    after?: string | null;
    /** Files the harness itself saw a Bash call change (Claude's `bashEditDiff`). `created` = the hunk starts from nothing. */
    harnessDetected?: { path: string; created: boolean }[];
}

export interface SessionTurn {
    turnId: string;
    /** 0-based position of the prompt in the session. */
    index: number;
    at: string | null;
    prompt: string;
}

export interface SessionTranscript {
    sessionId: string;
    turns: SessionTurn[];
    calls: SessionToolCall[];
    /** Every working directory the session's entries report. */
    cwds: string[];
}

export interface TurnFile {
    path: string;
    via: ChangeVia;
    confidence: ChangeConfidence;
    /** Git blob id of the file before the turn's first change, when known. */
    beforeOid?: string | null;
    /** Git blob id after the turn's last change, when known. `undefined` is unknown; `null` is deleted. */
    afterOid?: string | null;
    skipped?: "binary" | "large" | "no-before-state" | "no-after-state";
    toolUseIds: string[];
    /** Set when a subagent made the change. */
    agentIds?: string[];
    /** The command a `bash` change came from (first one), for review. */
    command?: string;
}

export interface ExcludedFile {
    path: string;
    reason: ExclusionReason;
    via: ChangeVia;
    toolUseIds: string[];
    command?: string;
}

export interface TurnChanges {
    turnId: string;
    /** Prompt index in the session (0-based), or null for a turn only the change log knows. */
    index: number | null;
    at: string | null;
    files: TurnFile[];
    excluded: ExcludedFile[];
}

export interface SessionChanges {
    sessionId: string;
    /** Every turn in prompt order, including turns that changed nothing. */
    turns: TurnChanges[];
    /** The whole session: first before-state to last after-state per path. */
    files: TurnFile[];
}

/** Stores blobs and returns their git ids in the same order. Without one, ids are computed in-process. */
export type BlobStore = (blobs: Buffer[]) => string[];
