import { booleanProbability } from "@genesiscz/utils/ai/evaluation/answers";
import type { EvaluationResponse, Evaluator } from "@genesiscz/utils/ai/evaluation/service";
import { ai } from "@genesiscz/utils/ai/tasks/facade";
import { chunk } from "@genesiscz/utils/array";
import { logger } from "@genesiscz/utils/logger";
import { profiler } from "@genesiscz/utils/profile";
import { truncateResult } from "./format";
import type { CompactDecision, CompactMessage, CompactResult, CompactVerdict } from "./schema";
import { SUMMARY_MARKER } from "./schema";
import {
    type CallRef,
    finishCompact,
    runStructuralPass,
    type StructuralCompactOptions,
    type StructuralPass,
} from "./structural";

const log = logger.child({ component: "ai:compact:llm" });
const prof = profiler.scope("jev-compact");

/** Invariant 4 of the live-policy plan: the admission threshold is 0.8 and is never lowered. */
export const JEV_BOOLEAN_THRESHOLD = 0.8;
export const JEV_BATCH_SIZE = 20;
const SUMMARY_TARGET_CHARS = 300;
const DEFAULT_MAX_SUMMARIES = 20;
const CONTEXT_CHARS = 300;
const INPUT_CHARS = 200;
const HEAD_CHARS = 400;
const TAIL_CHARS = 200;

export type CompactSummarizer = (text: string, maxChars: number) => Promise<string>;

export const defaultSummarizer: CompactSummarizer = async (text, maxChars) => {
    const result = await ai.summarize(text, { maxLength: maxChars });
    return result.summary.trim();
};

/**
 * Three-valued on purpose. `undefined` means Jev was not confident either way, and the caller must
 * keep the heuristic verdict rather than read an uncertain answer as a "no".
 */
export function booleanAnswer(
    result: EvaluationResponse,
    id: string,
    threshold = JEV_BOOLEAN_THRESHOLD
): boolean | undefined {
    const probability = booleanProbability(result, id);
    if (probability === null) {
        return undefined;
    }

    if (probability >= threshold) {
        return true;
    }

    return probability <= 1 - threshold ? false : undefined;
}

function conversation(messages: CompactMessage[]) {
    return messages
        .filter((message) => message.role === "user" || message.role === "assistant")
        .map((message) => ({ role: message.role, text: message.content.slice(0, CONTEXT_CHARS) }))
        .filter((message) => message.text !== "");
}

/**
 * Every question ships explicit true/false criteria. Measured on this Mac on 2026-09-18: the same
 * three questions WITHOUT criteria came back at 0.52 / 0.57 / 0.43 on the 10 KB fixture, so nothing
 * cleared the 0.8 gate and `--llm` decided nothing. With criteria the same input answered 0.87 and
 * 0.22 on the calls Jev was sure about. Lowering the gate instead is forbidden (invariant 4).
 */
function decideQuestions(batch: CallRef[]) {
    return Object.fromEntries(
        batch.flatMap((ref, position) => [
            [
                `keep_call_${position}`,
                {
                    type: "boolean" as const,
                    instructions: `Tool call ${ref.call.id} (${ref.call.name}) must stay in the transcript.`,
                    criteria: {
                        true: "A later turn refers to this call, or the conversation stops making sense without it.",
                        false: "Nothing later depends on it; removing the call and its result changes no later turn.",
                    },
                },
            ],
            [
                `keep_result_${position}`,
                {
                    type: "boolean" as const,
                    instructions: `The FULL result of ${ref.call.id} must stay verbatim.`,
                    criteria: {
                        true: "Later turns need details spread across the whole result, so a truncated head loses them.",
                        false: "A truncated head of the result is enough for every later turn.",
                    },
                },
            ],
            [
                `summarizable_${position}`,
                {
                    type: "boolean" as const,
                    instructions: `A ${SUMMARY_TARGET_CHARS}-character summary of the ${ref.call.id} result is enough.`,
                    criteria: {
                        true: "The result is a list or report whose gist is what later turns use.",
                        false: "Later turns quote exact values from it, or the result is already short.",
                    },
                },
            ],
        ])
    );
}

function decideState(messages: CompactMessage[], batch: CallRef[], pass: StructuralPass) {
    return {
        conversation: conversation(messages),
        calls: batch.map((ref) => ({
            id: ref.call.id,
            name: ref.call.name,
            input: (ref.call.input ?? "").slice(0, INPUT_CHARS),
            result_chars: ref.call.result?.length ?? 0,
            result_head: (ref.call.result ?? "").slice(0, HEAD_CHARS),
            heuristic: pass.verdicts.get(ref.call.id)?.verdict ?? "keep",
        })),
    };
}

/**
 * Jev only moves a call it is confident about. An unanswered `keep_result` leaves the layer-1
 * verdict alone, except that a confident "this call must stay" lifts a heuristic drop to a
 * truncate: keeping the drop would contradict the answer Jev did give.
 */
function resolveVerdict(
    keepCall: boolean | undefined,
    keepResult: boolean | undefined,
    heuristic: CompactVerdict | undefined
): CompactVerdict | undefined {
    if (keepCall === false) {
        return "drop";
    }

    if (keepCall !== true) {
        return undefined;
    }

    if (keepResult === true) {
        return "keep";
    }

    if (keepResult === false) {
        return "truncate";
    }

    return heuristic === "drop" ? "truncate" : undefined;
}

/**
 * Jev decides keep / truncate / drop per tool call, and the answer REPLACES the heuristic verdict
 * in `pass.verdicts`, which is what the renderer reads. Writing the answers into a report while the
 * output keeps the heuristic decisions is bug B9, and it made `--llm` a no-op.
 */
export async function decideWithJev(options: {
    messages: CompactMessage[];
    pass: StructuralPass;
    evaluate: Evaluator;
    signal?: AbortSignal;
}): Promise<{ requests: number; summarizable: Set<string> }> {
    const candidates = options.pass.refs.filter((ref) => {
        const verdict = options.pass.verdicts.get(ref.call.id)?.verdict;
        return verdict === "truncate" || verdict === "drop";
    });
    const summarizable = new Set<string>();
    if (!candidates.length) {
        log.info("Layer 2 had no truncated or dropped tool call to ask Jev about");
        return { requests: 0, summarizable };
    }

    let requests = 0;
    for (const batch of chunk(candidates, JEV_BATCH_SIZE)) {
        options.signal?.throwIfAborted();
        log.info({ calls: batch.length, questions: batch.length * 3 }, "Asking Jev for per-call compaction verdicts");
        const evaluation = await prof.measureAsync("jev-decide", () =>
            options.evaluate({
                signal: options.signal,
                input: { state: decideState(options.messages, batch, options.pass), questions: decideQuestions(batch) },
            })
        );
        requests += 1;

        for (const [position, ref] of batch.entries()) {
            const keepCall = booleanAnswer(evaluation, `keep_call_${position}`);
            const keepResult = booleanAnswer(evaluation, `keep_result_${position}`);
            if (booleanAnswer(evaluation, `summarizable_${position}`) === true) {
                summarizable.add(ref.call.id);
            }

            const previous = options.pass.verdicts.get(ref.call.id);
            const verdict = resolveVerdict(keepCall, keepResult, previous?.verdict);
            if (!previous || !verdict || verdict === previous.verdict) {
                log.debug(
                    { call: ref.call.id, keepCall, keepResult, verdict: previous?.verdict },
                    "Jev was not confident enough to move this call; the layer-1 verdict stands"
                );
                continue;
            }

            const kept =
                verdict === "drop"
                    ? 0
                    : verdict === "keep"
                      ? (ref.call.result?.length ?? 0)
                      : truncateResult(ref.call.result ?? "", options.pass.options.maxResult).length;
            options.pass.verdicts.set(ref.call.id, { ...previous, verdict, reason: "jev", layer: 2, keptChars: kept });
            log.info({ call: ref.call.id, from: previous.verdict, to: verdict }, "Jev replaced the layer-1 verdict");
        }
    }

    return { requests, summarizable };
}

interface SummaryCandidate {
    ref: CallRef;
    decision: CompactDecision;
    summary: string;
}

async function proposeSummaries(options: {
    pass: StructuralPass;
    summarizable: Set<string>;
    summarize: CompactSummarizer;
    maxSummaries: number;
    signal?: AbortSignal;
}): Promise<SummaryCandidate[]> {
    const proposals: SummaryCandidate[] = [];
    for (const ref of options.pass.refs) {
        if (proposals.length >= options.maxSummaries) {
            break;
        }

        const decision = options.pass.verdicts.get(ref.call.id);
        const result = ref.call.result ?? "";
        if (decision?.verdict !== "truncate" || !options.summarizable.has(ref.call.id)) {
            continue;
        }

        options.signal?.throwIfAborted();
        log.info({ call: ref.call.id, chars: result.length }, "Summarizing a truncated tool result");
        const summary = await prof.measureAsync("summarize", () => options.summarize(result, SUMMARY_TARGET_CHARS));
        if (summary.trim()) {
            proposals.push({ ref, decision, summary: summary.trim() });
        }
    }

    return proposals;
}

/**
 * A summary may replace a truncated head only after Jev calls it faithful to the original. The
 * generated text is never trusted on its own, and a discarded summary costs nothing: the truncated
 * head that layer 1 chose is still there.
 */
export async function gateSummaries(options: {
    proposals: SummaryCandidate[];
    pass: StructuralPass;
    evaluate: Evaluator;
    signal?: AbortSignal;
}): Promise<{ requests: number; replaced: number; discarded: number }> {
    let requests = 0;
    let replaced = 0;
    let discarded = 0;

    for (const batch of chunk(options.proposals, JEV_BATCH_SIZE)) {
        options.signal?.throwIfAborted();
        const state = batch.map((candidate) => ({
            id: candidate.ref.call.id,
            name: candidate.ref.call.name,
            original_head: (candidate.ref.call.result ?? "").slice(0, HEAD_CHARS),
            original_tail: (candidate.ref.call.result ?? "").slice(-TAIL_CHARS),
            summary: candidate.summary,
        }));
        const questions = Object.fromEntries(
            batch.map((_candidate, position) => [
                `faithful_${position}`,
                {
                    type: "boolean" as const,
                    instructions: "The summary is faithful to the original tool result.",
                    criteria: {
                        true: "Every claim in the summary is supported by the original head or tail.",
                        false: "The summary invents a fact, contradicts the original, or drops what the original is about.",
                    },
                },
            ])
        );
        log.info({ summaries: batch.length }, "Asking Jev whether each proposed summary is faithful");
        const evaluation = await prof.measureAsync("faithful-gate", () =>
            options.evaluate({ signal: options.signal, input: { state, questions } })
        );
        requests += 1;

        for (const [position, candidate] of batch.entries()) {
            if (booleanAnswer(evaluation, `faithful_${position}`) !== true) {
                discarded += 1;
                log.info({ call: candidate.ref.call.id }, "Summary failed the faithfulness gate; keeping the head");
                continue;
            }

            replaced += 1;
            options.pass.verdicts.set(candidate.ref.call.id, {
                ...candidate.decision,
                reason: "jev_summary",
                layer: 2,
                summary: true,
                summaryText: candidate.summary,
                keptChars: candidate.summary.length + SUMMARY_MARKER.length + 1,
            });
        }
    }

    return { requests, replaced, discarded };
}

export async function compactWithJev(options: {
    messages: CompactMessage[];
    structural: StructuralCompactOptions;
    evaluate: Evaluator;
    summaries?: boolean;
    summarize?: CompactSummarizer;
    maxSummaries?: number;
    sourceBytes?: number;
    signal?: AbortSignal;
}): Promise<CompactResult> {
    const pass = runStructuralPass(options.messages, options.structural);
    const decided = await decideWithJev({
        messages: options.messages,
        pass,
        evaluate: options.evaluate,
        signal: options.signal,
    });
    let jevRequests = decided.requests;
    let summaries = 0;
    let replaced = 0;
    let discarded = 0;

    if (options.summaries) {
        const proposals = await proposeSummaries({
            pass,
            summarizable: decided.summarizable,
            summarize: options.summarize ?? defaultSummarizer,
            maxSummaries: options.maxSummaries ?? DEFAULT_MAX_SUMMARIES,
            signal: options.signal,
        });
        summaries = proposals.length;
        const gated = await gateSummaries({ proposals, pass, evaluate: options.evaluate, signal: options.signal });
        jevRequests += gated.requests;
        replaced = gated.replaced;
        discarded = gated.discarded;
    }

    const result = finishCompact(options.messages, pass, options.sourceBytes ?? 0);
    log.info({ jevRequests, summaries, replaced, discarded }, "Layer 2 complete");
    return { ...result, layer2: { used: true, jevRequests, summaries, replaced, discarded } };
}
