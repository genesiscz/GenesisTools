// Copied from /Users/Martin/Tresors/Projects/Kalendora/src/eval-engine/system.ts at 2026-11-12T06:18:59+01:00 at commit hash 2b9937db296fcb22d402376689d926a71fe9f165
/**
 * The contract a project implements: its vocabulary (tools, setup, signals) and a live connection to one deployment.
 * Types and one error class. No transport types: the engine never sees HTTP, NDJSON or a provider SDK.
 */
import type { z } from "zod";

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type JsonObject = { [key: string]: Json };

export interface ModelRef {
    /** The name used in matrices, flags, cells and file names: "openai:gpt-5-mini", "basic". */
    id: string;
    label: string;
    /** Models that share a provider account share a limit: one adaptive limiter per key. */
    limitKey: string;
}

/** What a live system says about itself. Read once per run, stored in the manifest. */
export interface SystemInfo {
    models: ModelRef[];
    /** Names of the prompt variants. The first one is "the system as it is now". */
    variants: string[];
    /** Anything that names the system's code version (a commit, a build id). `compare` notes when it differs. */
    fingerprint: string | null;
}

export interface OpenRequest<TResolved> {
    model: ModelRef;
    variant: string;
    /** The scenario's setup after `resolveSetup`, the same value on every attempt and on `--resume`. */
    setup: TResolved;
    /** The run this conversation belongs to. Tag what you create with it, so `cleanup` can find it. */
    runId: string;
    /** The conversation key ("<scenario>~<model>~<variant>~r<repeat>"). */
    key: string;
    signal: AbortSignal;
}

export interface ToolCall {
    name: string;
    input: Json;
    output?: Json;
    /** Set when the tool threw or its input did not validate. */
    error?: string;
}

export interface Usage {
    inputTokens: number;
    outputTokens: number;
    cachedInputTokens?: number;
    /** What the call cost, when the system knows. `maxCostUsd` sums these. */
    costUsd?: number;
}

/** One model call inside a turn, for the transcript. */
export interface ModelStep {
    text: string;
    toolCalls: ToolCall[];
    finishReason: string | null;
    usage: Usage;
}

/** Everything the system did in answer to one user turn. */
export interface TurnResult<TSignals> {
    /** The whole text the user saw. Empty when the system gave no answer. */
    reply: string;
    /** Every tool call of the turn, in order. */
    toolCalls: ToolCall[];
    /** Default "observed". "unavailable": `tool` and `onlyTools` checks are inconclusive, not failed. */
    toolEvidence?: "observed" | "unavailable";
    /** The project's facts about this turn and the state after it. Parsed with `EvalSystem.signals`. */
    signals: TSignals;
    /** The system prompt of this turn, when the system can show it. Stored once per distinct text. */
    systemPrompt?: string;
    /** Per-turn context the model got beside the system prompt. */
    context?: string;
    /** The model that answered, as the provider named it. */
    observedModel?: string;
    steps?: ModelStep[];
    usage: Usage;
    latencyMs: number;
    firstTokenMs?: number;
}

export type SystemErrorKind = "rate-limit" | "transient" | "blocked";

/**
 * The only way a system reports "this was not the model's behaviour".
 * - "rate-limit": the limiter of the model's `limitKey` halves and pauses; the conversation starts again later.
 * - "transient": the conversation starts again later (a dropped stream, a 5xx, a timeout).
 * - "blocked": trying again cannot help (a missing key, an unknown model). The whole cell stops.
 * Any other thrown error counts as "transient".
 */
export class EvalSystemError extends Error {
    readonly kind: SystemErrorKind;
    readonly detail: { retryAfterMs?: number; cause?: unknown };

    constructor(kind: SystemErrorKind, message: string, detail: { retryAfterMs?: number; cause?: unknown } = {}) {
        super(message);
        this.name = "EvalSystemError";
        this.kind = kind;
        this.detail = detail;
    }
}

/** Any thrown value as an `EvalSystemError`: an unknown error is "transient". */
export function asSystemError(error: unknown): EvalSystemError {
    if (error instanceof EvalSystemError) {
        return error;
    }
    const message = error instanceof Error ? error.message : String(error);
    return new EvalSystemError("transient", message, { cause: error });
}

/** How a conversation ended. The system decides what to keep (for example failed ones, for a person to open). */
export type CloseOutcome = "passed" | "failed" | "inconclusive" | "discarded";

/** A text completion for the harness's own model calls: the judge and the simulated user. */
export interface CompletionRequest {
    purpose: "judge" | "simulator";
    /** A model id from `SystemInfo.models`, as the project's `harness` setting names it. */
    model: string;
    system: string;
    messages: { role: "user" | "assistant"; content: string }[];
    maxOutputTokens: number;
    signal: AbortSignal;
}

export interface Completion {
    text: string;
    usage: Usage;
}

/** One thing `cleanup` removed. */
export interface CleanupItem {
    id: string;
    /** The run tag it carried, when the system knows it. */
    runId?: string;
    description?: string;
}

/** A live connection to one deployment of the system. Throws `EvalSystemError` for anything that is not behaviour. */
export interface SystemConnection<TResolved, TSignals, THandle> {
    describe(context: { signal: AbortSignal }): Promise<SystemInfo>;
    /** A new, empty conversation. The handle is opaque to the engine. */
    open(request: OpenRequest<TResolved>): Promise<THandle>;
    /** Sends one user turn and waits for the whole answer. Never called twice with the same turn. */
    send(handle: THandle, text: string, context: { signal: AbortSignal }): Promise<TurnResult<TSignals>>;
    /** Always called once per opened conversation. An error here is noted in the record and changes nothing. */
    close(handle: THandle, outcome: CloseOutcome): Promise<void>;
    /** Absent: judge checks are inconclusive and simulated steps are refused when the run is planned. */
    complete?(request: CompletionRequest): Promise<Completion>;
    /** Removes what earlier runs left behind (all runs, or one `runId`). The `cleanup` command prints the result. */
    cleanup?(request: { runId?: string; signal: AbortSignal }): Promise<{ removed: CleanupItem[] }>;
}

/** A zod object schema of the signals. The engine reads its `shape` to check every signal path a scenario uses. */
export type SignalsSchema<TSignals> = z.ZodType<TSignals> & { readonly shape: Readonly<Record<string, z.ZodType>> };

export interface ResolveContext {
    /** The moment the run was planned. The same value on `--resume`. */
    now: Date;
}

/**
 * A project's system under test: a static vocabulary (enough to validate and print scenarios with nothing running)
 * and `connect` (a live connection to one deployment).
 *
 * `TSetup` is what a scenario writes (after the setup schema's defaults). `TResolved` is what `open` receives:
 * `resolveSetup` turns the one into the other once, when the run is planned (for example a named clock anchor into an
 * instant). It must return a plain JSON value; the manifest stores it.
 */
export interface EvalSystem<TSetup, TSignals, TTool extends string, THandle = unknown, TResolved = TSetup> {
    name: string;
    tools: readonly TTool[];
    setup: z.ZodType<TSetup>;
    signals: SignalsSchema<TSignals>;
    /** Bump when the code that computes the signals changes meaning. `compare` leaves out scenarios across a change. */
    signalsVersion: number;
    resolveSetup(setup: TSetup, context: ResolveContext): TResolved;
    /** `target` is the CLI's `--target` value, or undefined for the project's default. */
    connect(target: string | undefined): SystemConnection<TResolved, TSignals, THandle>;
}

/** What `defineEvalSystem` takes: `resolveSetup` may be left out, and the setup is then passed to `open` as it is. */
export type EvalSystemDefinition<TSetup, TSignals, TTool extends string, THandle, TResolved> = Omit<
    EvalSystem<TSetup, TSignals, TTool, THandle, TResolved>,
    "resolveSetup"
>;

export function defineEvalSystem<TSetup, TSignals, const TTool extends string, THandle, TResolved>(
    system: EvalSystemDefinition<TSetup, TSignals, TTool, THandle, TResolved> & {
        resolveSetup(setup: TSetup, context: ResolveContext): TResolved;
    }
): EvalSystem<TSetup, TSignals, TTool, THandle, TResolved>;
export function defineEvalSystem<TSetup, TSignals, const TTool extends string, THandle>(
    system: EvalSystemDefinition<TSetup, TSignals, TTool, THandle, TSetup> & { resolveSetup?: undefined }
): EvalSystem<TSetup, TSignals, TTool, THandle, TSetup>;
export function defineEvalSystem<TSetup, TSignals, TTool extends string, THandle>(
    system: EvalSystemDefinition<TSetup, TSignals, TTool, THandle, TSetup> & {
        resolveSetup?(setup: TSetup, context: ResolveContext): TSetup;
    }
): EvalSystem<TSetup, TSignals, TTool, THandle, TSetup> {
    return { ...system, resolveSetup: system.resolveSetup ?? keepSetup };
}

function keepSetup<T>(setup: T): T {
    return setup;
}
