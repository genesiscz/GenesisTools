import type { Command } from "commander";
import type { WorkerBackend } from "./capabilities";
import type { WorkerSurfaces } from "./isolation";
import type { WorkerMetaStore } from "./meta-store";
import type { WorkerTurnReport } from "./turn-report";

/**
 * What a headless-worker backend contributes to the shared worker verbs.
 *
 * Codex is a persistent app-server with a control channel; Grok and Claude spawn the CLI
 * fresh per turn. That difference is real and it fits in three places: the OUTCOME of
 * `spawn` / `steer` (a finished turn versus an acknowledgement), the LIVENESS source (the
 * process table versus a daemon pid), and the MEANING of `stop` (end the turn versus tear
 * the daemon down). Everything else on every worker verb is identical and lives once in
 * `registerWorkerVerbs`: name lookup, the not-found error, the prompt flags, the transcript
 * door, the sessions table, the absent-verb stubs.
 */

/**
 * What every backend's record carries. A turn counter is NOT in here: codex numbers nothing
 * and answers `read` with the current thread, so the turn lives on `latestTurn` below, where a
 * backend without one simply omits it.
 */
export interface WorkerMeta {
    name: string;
    cwd: string;
}

/** A backend that runs the turn in-process answers with the turn; a daemon answers with an ack. */
export type WorkerVerbOutcome = { kind: "turn"; report: WorkerTurnReport } | { kind: "ack"; result: unknown };

export interface WorkerSpawnInput {
    name: string;
    cwd: string;
    /** Absent only when the backend declared `spawnFlags.promptOptional`. */
    prompt?: string;
    model?: string;
    account?: string;
    surfaces: WorkerSurfaces;
    /** The `extendSpawn` extras, as commander parsed them. */
    extras: Record<string, unknown>;
}

export interface WorkerSteerInput {
    prompt: string;
    extras: Record<string, unknown>;
}

export interface WorkerLiveness {
    running: boolean;
    pids?: number[];
    detail?: string;
}

export interface WorkerDriver<Meta extends WorkerMeta = WorkerMeta> {
    backend: WorkerBackend;
    store: WorkerMetaStore<Meta>;
    /**
     * Help-line wording only this backend can supply, because the same verb genuinely does
     * different things: `spawn` blocks for turn 1 on a per-turn backend and starts a daemon on
     * codex, and `read` prints a turn report, raw stream-json or a live thread snapshot.
     */
    help: {
        /** Completes "Start a headless <backend> worker: …". */
        spawn: string;
        /** The whole `steer` description; a daemon acks it, a per-turn backend blocks on it. */
        steer: string;
        /** What `read` prints with no `--format`, as a noun phrase. */
        read: string;
        /** The whole `tail` description. */
        tail: string;
    };
    /** How the shared `spawn` differs here. Everything else a backend needs goes in `extendSpawn`. */
    spawnFlags?: {
        /** `--cwd` must be given: a claude worker never guesses the directory it will write in. */
        cwdRequired?: boolean;
        /** A first prompt is optional: codex spawns the session and waits for a steer. */
        promptOptional?: boolean;
    };
    /**
     * Commander attribute names of an older spelling of `--prompt` / `--prompt-file` that
     * `steer` still accepts. The backend declares the options themselves, hidden, in
     * `extendSteer`; naming them here is what lets the shared prompt reader find them.
     */
    legacyPromptFlags?: { text: string; file: string };
    /** Extra spawn flags: codex `--effort --write --mode --session --writable-root`; grok `--readonly --worker-home --auth`. */
    extendSpawn?(command: Command): void;
    extendSteer?(command: Command): void;
    extendTail?(command: Command): void;
    spawn(input: WorkerSpawnInput): Promise<WorkerVerbOutcome>;
    steer(meta: Meta, input: WorkerSteerInput): Promise<WorkerVerbOutcome>;
    /** ps-backed backends answer from the process table; codex from the daemon pid and last event age. */
    liveness(meta: Meta): Promise<WorkerLiveness>;
    /** End the running turn; the session survives. Every backend has this. */
    interruptTurn(meta: Meta): Promise<WorkerVerbOutcome | undefined>;
    /** Tear the daemon down. Only a backend that has one. */
    shutdown?(meta: Meta): Promise<WorkerVerbOutcome | undefined>;
    /** The turn `read` defaults to. Absent on a backend that does not number turns. */
    latestTurn?(meta: Meta): number;
    /** Transcript file of one finished turn for the transcript door; absent when the door discovers it by name. */
    turnFile?(meta: Meta, turn: number): string;
    /** What `read` prints with no `--format`: grok the turn report, claude raw stream-json, codex the thread snapshot. */
    readDefault(meta: Meta, turn: number): Promise<void>;

    /** What `tail` does with no `--format`, when it is not the transcript door (codex follows its raw event log). */
    tailDefault?(meta: Meta, extras: Record<string, unknown>): Promise<void>;
    /** `sessions` table. */
    rowHeaders: readonly string[];
    row(meta: Meta): string[];
    /** `sessions --json` row; default is the meta itself. */
    jsonRow?(meta: Meta): unknown;
}
