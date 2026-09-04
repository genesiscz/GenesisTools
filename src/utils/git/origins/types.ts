export type OriginKind = "github" | "gitlab";

/** One vocabulary for both hosts: gh already speaks it, glab's `opened`/`merged`/`closed` is mapped. */
export type PrState = "OPEN" | "MERGED" | "CLOSED";

export interface PrInfo {
    number: number;
    state: PrState;
    /** The base branch the PR/MR targets. */
    target: string;
    url: string;
}

/**
 * `pr` null with `error` null means the host has no PR for that head; `error` set means the
 * CLI could not answer (missing binary, not logged in, timeout, rate limit). Callers that
 * delete something on the strength of "no open PR" must treat `error` as "unknown".
 */
export interface PrLookup {
    pr: PrInfo | null;
    error: string | null;
}

/** Read-only view of the hosting service; v1 answers one question per head branch. */
export interface OriginDriver {
    kind: OriginKind;
    /** The newest PR/MR whose head is `branch`, open first. A failed lookup is NOT "no PR": read `error`. */
    prForHead(branch: string): Promise<PrLookup>;
}

export interface CommandResult {
    code: number;
    stdout: string;
    stderr: string;
}

/** Spawns a host CLI (`gh`, `glab`); injected so tests never need the binary. */
export type CommandRunner = (cmd: string[], opts: { cwd: string; timeoutMs: number }) => Promise<CommandResult>;
