export type StreamOut = "stdout" | "stderr";

export type JsonlLineLevel = "info" | "warn" | "error";

export interface JsonlLineRecord {
    type: "line";
    seq: number;
    out: StreamOut;
    /** Semantic severity; inferred at capture time (PTY-safe). Omitted in older sessions. */
    level?: JsonlLineLevel;
    ts: number;
    text: string;
    /** Original PTY text with ANSI — dashboard fallback when ui.jsonl races. */
    raw?: string;
}

/** Dashboard-only ANSI mirror — same seq as canonical jsonl; never emitted by task logs/tail/get. */
export interface JsonlUiLineRecord {
    type: "line";
    seq: number;
    text: string;
}

export interface JsonlMetaRecord {
    type: "meta";
    session: string;
    command: string;
    mode: "pty" | "pipe";
    cwd: string;
    startedAt: string;
    pid?: number;
}

export interface JsonlExitRecord {
    type: "exit";
    code: number;
    durationMs: number;
    ts: string;
}

// Includes JsonlUiLineRecord so the ui.jsonl reader can narrow records of
// the union via a type predicate without TS complaining the predicate isn't
// assignable to the parameter type. JsonlLineRecord and JsonlUiLineRecord
// both have `type: "line"` so callers need to discriminate further (e.g.
// presence of `out`) when consuming the canonical jsonl.
export type JsonlRecord =
    | JsonlLineRecord
    | JsonlUiLineRecord
    | JsonlMetaRecord
    | JsonlExitRecord
    | Record<string, unknown>;

export interface SessionMetaBase {
    name: string;
    createdAt: number;
    lastActivityAt: number;
}
