/**
 * How one conversation is played: open, bind and choose, send each turn exactly once, evaluate, simulated blocks,
 * final checks, close. Owns the transcript types `ConversationRecord` and `TurnRecord`.
 */
import type { z } from "zod";
import {
    EvalConfigError,
    type Expectation,
    fillCheck,
    fillScenarioText,
    type OtherwiseBranch,
    resolveBindings,
    type Scenario,
    type ScriptedStep,
    type SimulatedStep,
    toJson,
    type WhenBranch,
} from "./document";
import {
    addUsage,
    conversationOutcome,
    type ExpectationVerdict,
    emptyUsage,
    evaluateCheck,
    evaluateExpectations,
    type JudgeAnswer,
    type JudgeRequest,
    type Outcome,
    type PlacedExpectation,
    type Scope,
    type TranscriptLine,
} from "./evaluate";
import { buildJudgeRequest, buildSimulatorRequest, parseJudgeAnswer, readSimulatorText } from "./harness-models";
import {
    asSystemError,
    type CloseOutcome,
    EvalSystemError,
    type Json,
    type ModelRef,
    type ModelStep,
    type SystemConnection,
    type SystemErrorKind,
    type ToolCall,
    type Usage,
} from "./system";

export interface CellRef {
    scenario: string;
    scenarioHash: string;
    model: string;
    variant: string;
}

/** One turn as the transcript stores it. */
export interface TurnRecord {
    /** 1-based. */
    turn: number;
    /** Index into `doc.steps`. The turns of a simulated block share one step. */
    step: number;
    /** For a `choose` step: the name of the branch that was played. */
    choice: string | null;
    user: { text: string; source: "script" | "simulator" };
    reply: string;
    toolCalls: ToolCall[];
    toolEvidence: "observed" | "unavailable";
    signals: Json;
    /** sha256 (8 hex) of the system prompt; the run folder keeps its text once. */
    promptHash: string | null;
    context: string | null;
    observedModel: string | null;
    steps: ModelStep[];
    usage: Usage;
    latencyMs: number;
    firstTokenMs: number | null;
    verdicts: ExpectationVerdict[];
}

export interface SimulatorBlock {
    step: number;
    turns: number;
    endedBy: "until" | "stop-word" | "max-turns";
}

/** The transcript of one finished conversation. Written once, never rewritten. */
export interface ConversationRecord {
    schema: "eval-conversation/1";
    run: string;
    /** "<scenario id>~<model>~<variant>~r<repeat>": the file name and the name in `failures`. */
    key: string;
    cell: CellRef;
    repeat: number;
    outcome: Outcome;
    safetyMiss: boolean;
    safetyUnverified: boolean;
    /** false: the conversation stopped early (at its first gate or safety failure, or it broke after one). */
    completed: boolean;
    /** The infrastructure error that broke the conversation after a proven failure; null otherwise. */
    brokenBy: { kind: SystemErrorKind; message: string } | null;
    /** `close` threw; the outcome is unchanged. */
    closeError: string | null;
    /** 1 for the first conversation opened for this key in this invocation. */
    attempt: number;
    startedAt: string;
    finishedAt: string;
    /** The resolved setup `open` received. */
    setup: Json;
    bindings: Record<string, Json>;
    turns: TurnRecord[];
    /** Verdicts of `scenario.final`. */
    final: ExpectationVerdict[];
    simulator: SimulatorBlock[];
    systemUsage: Usage;
    /** Judge and simulator calls. */
    harnessUsage: Usage;
}

export interface ConversationDeps<TResolved, TSignals, THandle> {
    connection: SystemConnection<TResolved, TSignals, THandle>;
    /** Parses `TurnResult.signals`; signals outside the schema are a "blocked" error. */
    signals: z.ZodType<TSignals>;
    model: ModelRef;
    runId: string;
    /** Runs `task` under the adaptive limit of `limitKey`. Every `send` and `complete` goes through it. */
    limited<T>(limitKey: string, task: () => Promise<T>): Promise<T>;
    harness: { judge: ModelRef | null; simulator: ModelRef | null };
    /** Stores a system prompt once and returns its hash. */
    putPrompt(text: string): Promise<string>;
    /** false: stop at the first gate or safety failure. true: play every step anyway. */
    keepGoing: boolean;
    signal: AbortSignal;
    now(): Date;
}

export interface ConversationInput<TResolved> {
    key: string;
    repeat: number;
    attempt: number;
    scenario: Scenario;
    cell: CellRef;
    setup: TResolved;
}

function evaluationTranscript(turns: readonly TurnRecord[]): TranscriptLine[] {
    return turns.flatMap((turn): TranscriptLine[] => [
        { role: "user", text: turn.user.text, toolCalls: [] },
        { role: "assistant", text: turn.reply, toolCalls: turn.toolCalls },
    ]);
}

function turnScope(turn: TurnRecord, turns: readonly TurnRecord[]): Scope {
    return {
        kind: "turn",
        turn: turn.turn,
        toolCalls: turn.toolCalls,
        toolEvidence: turn.toolEvidence,
        replies: [turn.reply],
        signals: turn.signals,
        transcript: evaluationTranscript(turns.slice(0, turn.turn)),
    };
}

function conversationScope(turns: readonly TurnRecord[]): Scope {
    const last = turns[turns.length - 1];
    return {
        kind: "conversation",
        turn: turns.length,
        toolCalls: turns.flatMap((t) => t.toolCalls),
        toolEvidence: turns.some((t) => t.toolEvidence === "unavailable") ? "unavailable" : "observed",
        replies: turns.map((t) => t.reply),
        signals: last ? last.signals : {},
        transcript: evaluationTranscript(turns),
    };
}

function engineVerdict(id: string, place: "binding" | "choose", turn: number, reason: string): ExpectationVerdict {
    return {
        id,
        severity: "gate",
        place,
        turn,
        result: "fail",
        reason,
        check: null,
        branch: null,
        tree: { label: place, result: "fail", reason },
    };
}

const isGatingFailure = (v: ExpectationVerdict) => v.severity !== "advisory" && v.result === "fail";

/** Thrown inside the loop to stop the conversation early after a proven failure. */
class StopConversation {}

/**
 * Plays one conversation from `open` to `close` and returns its record.
 * Throws `EvalSystemError` only when nothing can be said about behaviour: an infrastructure error before any proven
 * failure. A proven failure followed by an infrastructure error is returned as the final record. Always calls `close`
 * for an opened conversation.
 */
export async function runConversation<TResolved, TSignals, THandle>(
    input: ConversationInput<TResolved>,
    deps: ConversationDeps<TResolved, TSignals, THandle>
): Promise<ConversationRecord> {
    const { scenario } = input;
    const { connection } = deps;
    const startedAt = deps.now().toISOString();
    const handle = await connection.open({
        model: deps.model,
        variant: input.cell.variant,
        setup: input.setup,
        runId: deps.runId,
        key: input.key,
        signal: deps.signal,
    });

    const turns: TurnRecord[] = [];
    const verdicts: ExpectationVerdict[] = [];
    const simulator: SimulatorBlock[] = [];
    let bindings: Record<string, Json> = {};
    let harnessUsage = emptyUsage();
    let completed = false;
    let brokenBy: EvalSystemError | null = null;
    let final: ExpectationVerdict[] = [];
    const always: PlacedExpectation[] = scenario.doc.always.map((expectation) => ({ expectation, place: "always" }));
    const complete = connection.complete?.bind(connection);

    const askJudge = async (request: JudgeRequest): Promise<JudgeAnswer> => {
        const judge = deps.harness.judge;
        if (!judge || !complete) {
            return { result: "inconclusive", reason: "no judge is configured", usage: emptyUsage() };
        }
        let usage = emptyUsage();
        let problem = "";
        for (let attempt = 1; attempt <= 2; attempt++) {
            try {
                const answer = await deps.limited(judge.limitKey, () =>
                    complete({ ...buildJudgeRequest(request, judge.id), signal: deps.signal })
                );
                usage = addUsage(usage, answer.usage);
                const parsed = parseJudgeAnswer(answer.text);
                if (parsed) {
                    return { ...parsed, usage };
                }
                problem = "the judge's answer was not readable";
            } catch (error) {
                problem = `the judge failed: ${asSystemError(error).message}`;
            }
        }
        return { result: "inconclusive", reason: problem, usage };
    };

    const record = (verdict: ExpectationVerdict) => {
        turns[turns.length - 1]?.verdicts.push(verdict);
        if (!turns.length) {
            final.push(verdict);
        }
        verdicts.push(verdict);
    };

    const playTurn = async (
        text: string,
        source: "script" | "simulator",
        step: number,
        choice: string | null,
        expect: readonly Expectation[]
    ) => {
        const result = await deps.limited(deps.model.limitKey, () =>
            connection.send(handle, text, { signal: deps.signal })
        );
        const parsed = deps.signals.safeParse(result.signals);
        if (!parsed.success) {
            const detail = parsed.error.issues.map((i) => `${i.path.map(String).join(".")}: ${i.message}`).join("; ");
            throw new EvalSystemError("blocked", `the system returned signals outside its schema (${detail})`);
        }
        const turn: TurnRecord = {
            turn: turns.length + 1,
            step,
            choice,
            user: { text, source },
            reply: result.reply,
            toolCalls: result.toolCalls,
            toolEvidence: result.toolEvidence ?? "observed",
            signals: toJson(parsed.data),
            promptHash: result.systemPrompt ? await deps.putPrompt(result.systemPrompt) : null,
            context: result.context ?? null,
            observedModel: result.observedModel ?? null,
            steps: result.steps ?? [],
            usage: result.usage,
            latencyMs: result.latencyMs,
            firstTokenMs: result.firstTokenMs ?? null,
            verdicts: [],
        };
        turns.push(turn);
        const placed: PlacedExpectation[] = [
            ...expect.map((expectation): PlacedExpectation => ({ expectation, place: "turn" })),
            ...always,
        ];
        const evaluated = await evaluateExpectations(placed, turnScope(turn, turns), bindings, askJudge);
        harnessUsage = addUsage(harnessUsage, evaluated.judgeUsage);
        evaluated.verdicts.forEach(record);
        if (!deps.keepGoing && evaluated.verdicts.some(isGatingFailure)) {
            throw new StopConversation();
        }
        return turn;
    };

    const bind = (map: Readonly<Record<string, string>> | undefined) => {
        if (!map) {
            return;
        }
        const previous = turns[turns.length - 1];
        if (!previous) {
            record(
                engineVerdict(
                    "binding:previous",
                    "binding",
                    0,
                    "binding needs a previous turn; simulator produced none"
                )
            );
            throw new StopConversation();
        }
        const resolved = resolveBindings(map, previous.signals);
        if (!resolved.ok) {
            record(engineVerdict(`binding:${resolved.name}`, "binding", previous.turn, resolved.reason));
            throw new StopConversation();
        }
        bindings = { ...bindings, ...resolved.values };
    };

    const playScripted = async (
        step: ScriptedStep | WhenBranch | OtherwiseBranch,
        index: number,
        choice: string | null
    ) => {
        bind(step.bind);
        await playTurn(fillScenarioText(step.user, bindings), "script", index, choice, step.expect ?? []);
    };

    const playSimulated = async (step: SimulatedStep, index: number) => {
        const model = deps.harness.simulator;
        if (!model || !complete) {
            throw new EvalSystemError("blocked", "a simulated step needs the project's simulator model and `complete`");
        }
        const block: SimulatorBlock = { step: index, turns: 0, endedBy: "max-turns" };
        simulator.push(block);
        for (let i = 0; i < step.simulate.maxTurns; i++) {
            const completion = await deps.limited(model.limitKey, () =>
                complete({
                    ...buildSimulatorRequest(step.simulate, evaluationTranscript(turns), model.id),
                    signal: deps.signal,
                })
            );
            harnessUsage = addUsage(harnessUsage, completion.usage);
            const next = readSimulatorText(completion.text);
            if (next.stop) {
                block.endedBy = "stop-word";
                return;
            }
            const turn = await playTurn(next.text, "simulator", index, null, step.expect ?? []);
            block.turns++;
            const until = step.simulate.until;
            if (
                until &&
                evaluateCheck(fillCheck(until, bindings), turnScope(turn, turns), new Map()).verdict.result === "pass"
            ) {
                block.endedBy = "until";
                return;
            }
        }
    };

    try {
        for (const [index, step] of scenario.doc.steps.entries()) {
            if ("simulate" in step) {
                await playSimulated(step, index);
            } else if ("choose" in step) {
                const previous = turns[turns.length - 1];
                if (!previous) {
                    record(
                        engineVerdict(
                            `choose:s${index + 1}`,
                            "choose",
                            0,
                            "choose needs a previous turn; simulator produced none"
                        )
                    );
                    throw new StopConversation();
                }
                const scope = turnScope(previous, turns);
                const branch = step.choose.find(
                    (b) =>
                        "otherwise" in b ||
                        evaluateCheck(fillCheck(b.when, bindings), scope, new Map()).verdict.result === "pass"
                );
                if (!branch) {
                    record(
                        engineVerdict(
                            `choose:s${index + 1}`,
                            "choose",
                            previous.turn,
                            "no branch of choose matched the previous turn, and it has no otherwise"
                        )
                    );
                    throw new StopConversation();
                }
                const outer = bindings;
                try {
                    await playScripted(branch, index, branch.name ?? null);
                } finally {
                    bindings = outer;
                }
            } else {
                await playScripted(step, index, null);
            }
        }
        completed = true;
        if (scenario.doc.final.length) {
            const placed = scenario.doc.final.map(
                (expectation): PlacedExpectation => ({ expectation, place: "final" })
            );
            const evaluated = await evaluateExpectations(placed, conversationScope(turns), bindings, askJudge);
            harnessUsage = addUsage(harnessUsage, evaluated.judgeUsage);
            final = evaluated.verdicts;
        }
    } catch (error) {
        if (error instanceof EvalConfigError) {
            record(engineVerdict("binding:template", "binding", turns.length, error.message));
        } else if (!(error instanceof StopConversation)) {
            const systemError = asSystemError(error);
            if (!conversationOutcome(verdicts, false)) {
                await closeQuietly({ connection, handle, outcome: "discarded", signal: deps.signal });
                throw systemError;
            }
            brokenBy = systemError;
        }
    }

    const fold = conversationOutcome([...verdicts, ...final], completed);
    // A stop without a proven failure cannot happen: every stop follows a gating failure.
    const outcome = fold ?? { outcome: "inconclusive", safetyMiss: false, safetyUnverified: false };
    const closeError = await closeQuietly({ connection, handle, outcome: outcome.outcome, signal: deps.signal });
    return {
        schema: "eval-conversation/1",
        run: deps.runId,
        key: input.key,
        cell: input.cell,
        repeat: input.repeat,
        outcome: outcome.outcome,
        safetyMiss: outcome.safetyMiss,
        safetyUnverified: outcome.safetyUnverified,
        completed,
        brokenBy: brokenBy ? { kind: brokenBy.kind, message: brokenBy.message } : null,
        closeError,
        attempt: input.attempt,
        startedAt,
        finishedAt: deps.now().toISOString(),
        setup: toJson(input.setup),
        bindings,
        turns,
        final,
        simulator,
        systemUsage: turns.reduce((sum, t) => addUsage(sum, t.usage), emptyUsage()),
        harnessUsage,
    };
}

async function closeQuietly<THandle>({
    connection,
    handle,
    outcome,
    signal,
}: {
    connection: { close(handle: THandle, outcome: CloseOutcome): Promise<void> };
    handle: THandle;
    outcome: CloseOutcome;
    signal: AbortSignal;
}): Promise<string | null> {
    try {
        await new Promise<void>((resolve, reject) => {
            const finish = (error?: unknown) => {
                clearTimeout(timer);
                signal.removeEventListener("abort", onAbort);
                if (error) {
                    reject(error);
                } else {
                    resolve();
                }
            };
            const onAbort = () => finish(new Error("conversation cleanup aborted"));
            const timer = setTimeout(() => finish(new Error("conversation cleanup exceeded 1000 ms")), 1000);
            signal.addEventListener("abort", onAbort, { once: true });
            void Promise.resolve()
                .then(() => connection.close(handle, outcome))
                .then(() => finish(), finish);
            if (signal.aborted) {
                onAbort();
            }
        });
        return null;
    } catch (error) {
        return error instanceof Error ? error.message : String(error);
    }
}
