// Copied from /Users/Martin/Tresors/Projects/Kalendora/src/eval-engine/testing.ts at 2026-11-12T06:18:59+01:00 at commit hash 2b9937db296fcb22d402376689d926a71fe9f165
/**
 * `fakeSystem(script)`: an in-memory system with scripted replies, tool calls, signals and errors, a log of every
 * call, and `fakeClock()` for the limiter and the backoff. For the engine's tests and for a project's own tests.
 */
import { z } from "zod";
import type { Clock } from "./schedule";
import {
    type CleanupItem,
    type CloseOutcome,
    type Completion,
    type CompletionRequest,
    defineEvalSystem,
    type EvalSystem,
    type ModelRef,
    type ResolveContext,
    type SignalsSchema,
    type ToolCall,
    type Usage,
} from "./system";

/** A clock that moves only when told: `advance(ms)`, or by itself on every `sleep` when `auto` is true. */
export interface FakeClock extends Clock {
    advance(ms: number): Promise<void>;
    /** Every `sleep` asked for so far, in milliseconds. */
    readonly sleeps: number[];
}

export function fakeClock(options: { start?: number; auto?: boolean } = {}): FakeClock {
    let now = options.start ?? Date.UTC(2026, 10, 16, 7, 0, 0);
    const sleeps: number[] = [];
    const waiting: { at: number; done: () => void }[] = [];
    const flush = () => {
        waiting.sort((a, b) => a.at - b.at);
        while (waiting.length && waiting[0].at <= now) {
            waiting.shift()?.done();
        }
    };
    return {
        sleeps,
        now: () => now,
        sleep(ms) {
            sleeps.push(ms);
            if (options.auto) {
                now += Math.max(0, ms);
                return Promise.resolve();
            }
            return new Promise((done) => {
                waiting.push({ at: now + Math.max(0, ms), done });
                flush();
            });
        },
        async advance(ms) {
            now += ms;
            flush();
            await new Promise((done) => setImmediate(done));
        },
    };
}

/** What a scripted turn returns. `error` is thrown instead of answering. */
export interface FakeTurn<TSignals> {
    reply?: string;
    toolCalls?: ToolCall[];
    /** Merged over the script's `defaultSignals`. */
    signals?: Partial<TSignals>;
    toolEvidence?: "observed" | "unavailable";
    systemPrompt?: string;
    usage?: Partial<Usage>;
    latencyMs?: number;
    error?: Error;
}

export interface FakeTurnContext<TSetup> {
    key: string;
    runId: string;
    model: string;
    variant: string;
    setup: TSetup;
    /** 1-based turn of this conversation. */
    turn: number;
    text: string;
    /** How many conversations were opened for this key so far, this one included. */
    opened: number;
}

export interface FakeScript<TSetup, TSignals, TTool extends string> {
    name?: string;
    tools: readonly TTool[];
    setup?: z.ZodType<TSetup>;
    signals: SignalsSchema<TSignals>;
    defaultSignals: TSignals;
    signalsVersion?: number;
    /** Turns the scenario's setup into what `open` receives, once per run (here: the same type). */
    resolveSetup?: (setup: TSetup, context: ResolveContext) => TSetup;
    /** Default: one model "fake" with limit key "fake". */
    models?: ModelRef[];
    /** Default: ["current"]. */
    variants?: string[];
    fingerprint?: string | null;
    /** The answer to one user turn. */
    reply(context: FakeTurnContext<TSetup>): FakeTurn<TSignals>;
    /** The judge and the simulated user. Absent: the system has no `complete`. A thrown error is the provider's. */
    complete?(request: CompletionRequest): Completion;
    /** Thrown by `describe` (an unreachable system). */
    describeError?: Error;
    /** Thrown by `open` for these keys, on every attempt. */
    openError?(context: { key: string; opened: number }): Error | undefined;
    /** With a cleanup function, which removes every conversation still open under the run tag. */
    cleanup?: boolean;
}

export interface FakeLog {
    opened: { key: string; runId: string; model: string; variant: string; setup: unknown }[];
    sent: { key: string; text: string }[];
    closed: { key: string; outcome: CloseOutcome }[];
    completions: CompletionRequest[];
    targets: (string | undefined)[];
}

interface FakeHandle {
    key: string;
    runId: string;
    turn: number;
    opened: number;
}

const DefaultModels: ModelRef[] = [{ id: "fake", label: "Fake model", limitKey: "fake" }];

/** An in-memory system. `log` records every call. */
export function fakeSystem<TSetup, TSignals, const TTool extends string>(
    script: FakeScript<TSetup, TSignals, TTool>
): EvalSystem<TSetup, TSignals, TTool, FakeHandle> & { log: FakeLog } {
    const log: FakeLog = { opened: [], sent: [], closed: [], completions: [], targets: [] };
    const openCounts = new Map<string, number>();
    const live = new Map<string, FakeHandle>();
    const setupSchema: z.ZodType<TSetup> = script.setup ?? z.custom<TSetup>(() => true);
    const system = defineEvalSystem({
        name: script.name ?? "fake",
        tools: script.tools,
        setup: setupSchema,
        signals: script.signals,
        signalsVersion: script.signalsVersion ?? 1,
        resolveSetup: script.resolveSetup ?? ((setup: TSetup) => setup),
        connect(target) {
            log.targets.push(target);
            const setups = new Map<string, TSetup>();
            return {
                async describe() {
                    if (script.describeError) {
                        throw script.describeError;
                    }
                    return {
                        models: script.models ?? DefaultModels,
                        variants: script.variants ?? ["current"],
                        fingerprint: script.fingerprint ?? null,
                    };
                },
                async open(request) {
                    const opened = (openCounts.get(request.key) ?? 0) + 1;
                    openCounts.set(request.key, opened);
                    const error = script.openError?.({ key: request.key, opened });
                    if (error) {
                        throw error;
                    }
                    log.opened.push({
                        key: request.key,
                        runId: request.runId,
                        model: request.model.id,
                        variant: request.variant,
                        setup: request.setup,
                    });
                    const handle: FakeHandle = { key: request.key, runId: request.runId, turn: 0, opened };
                    setups.set(request.key, request.setup);
                    live.set(`${request.runId}/${request.key}/${opened}`, handle);
                    return handle;
                },
                async send(handle, text) {
                    handle.turn++;
                    log.sent.push({ key: handle.key, text });
                    const opening = log.opened.findLast((o) => o.key === handle.key);
                    const setup = setups.get(handle.key);
                    if (!opening || setup === undefined) {
                        throw new Error(`no open conversation ${handle.key}`);
                    }
                    const turn = script.reply({
                        key: handle.key,
                        runId: handle.runId,
                        model: opening.model,
                        variant: opening.variant,
                        setup,
                        turn: handle.turn,
                        text,
                        opened: handle.opened,
                    });
                    if (turn.error) {
                        throw turn.error;
                    }
                    return {
                        reply: turn.reply ?? "",
                        toolCalls: turn.toolCalls ?? [],
                        toolEvidence: turn.toolEvidence,
                        signals: { ...script.defaultSignals, ...turn.signals },
                        systemPrompt: turn.systemPrompt,
                        usage: { inputTokens: 10, outputTokens: 5, ...turn.usage },
                        latencyMs: turn.latencyMs ?? 1,
                    };
                },
                async close(handle, outcome) {
                    log.closed.push({ key: handle.key, outcome });
                    live.delete(`${handle.runId}/${handle.key}/${handle.opened}`);
                },
                ...(script.complete
                    ? {
                          complete: async (request: CompletionRequest) => {
                              log.completions.push(request);
                              return script.complete
                                  ? script.complete(request)
                                  : { text: "", usage: { inputTokens: 0, outputTokens: 0 } };
                          },
                      }
                    : {}),
                ...(script.cleanup
                    ? {
                          cleanup: async ({ runId }: { runId?: string }) => {
                              const removed: CleanupItem[] = [];
                              for (const [id, handle] of live) {
                                  if (runId && handle.runId !== runId) {
                                      continue;
                                  }
                                  removed.push({ id, runId: handle.runId, description: `conversation ${handle.key}` });
                                  live.delete(id);
                              }
                              return { removed };
                          },
                      }
                    : {}),
            };
        },
    });
    return { ...system, log };
}
