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

export interface WorkerMeta {
    name: string;
    sessionId: string;
    cwd: string;
    turns: number;
    createdAt: string;
}

/** A backend that runs the turn in-process answers with the turn; a daemon answers with an ack. */
export type WorkerVerbOutcome = { kind: "turn"; report: WorkerTurnReport } | { kind: "ack"; result: unknown };

export interface WorkerSpawnInput {
    name: string;
    cwd: string;
    prompt: string;
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
    /** Extra spawn flags: codex `--effort --write --mode --session --writable-root`; grok `--readonly --worker-home --auth`. */
    extendSpawn?(command: Command): void;
    extendSteer?(command: Command): void;
    extendTail?(command: Command): void;
    spawn(input: WorkerSpawnInput): Promise<WorkerVerbOutcome>;
    steer(meta: Meta, input: WorkerSteerInput): Promise<WorkerVerbOutcome>;
    /** ps-backed backends answer from the process table; codex from the daemon pid and last event age. */
    liveness(meta: Meta): Promise<WorkerLiveness>;
    /** End the running turn; the session survives. Every backend has this. */
    interruptTurn(meta: Meta): Promise<WorkerVerbOutcome | void>;
    /** Tear the daemon down. Only a backend that has one. */
    shutdown?(meta: Meta): Promise<WorkerVerbOutcome | void>;
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
