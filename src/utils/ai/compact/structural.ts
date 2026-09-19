import { logger } from "@genesiscz/utils/logger";
import { profiler } from "@genesiscz/utils/profile";
import { measureBytes, serializeCompactMessage, truncateResult } from "./format";
import {
    type CompactDecision,
    type CompactMessage,
    type CompactResult,
    type CompactToolCall,
    type CompactVerdict,
    isEmptyMessage,
    SUMMARY_MARKER,
} from "./schema";

const log = logger.child({ component: "ai:compact:structural" });
const prof = profiler.scope("jev-compact");

/**
 * "0 errors, 0 warnings" is a PASS. Counting it as a failure hard-pinned a clean 6.6 KB lint report
 * on this Mac on 2026-09-18 and made the whole run a no-op, so the clean counts are removed before
 * the failure words are looked for.
 */
const CLEAN_COUNT_PATTERN = /\b(?:0|no)\s+(?:errors?|failures?|warnings?|problems?)\b/gi;
const FAILURE_PATTERN = /error|failed|failure|exception|traceback|panic:|exit(?: code)? [1-9]/i;
const PIN_MARKER = "#pin";
/** A result must beat the truncation head by this factor before "a later call supersedes it" drops it. */
const SUPERSEDED_FACTOR = 4;

export interface StructuralCompactOptions {
    /** Target share of the input to keep. The reduction target is `1 - keep`. */
    keep: number;
    /** How many trailing messages are protected from a drop. */
    pin: number;
    maxResult: number;
    threshold: number;
    keepTokens?: number;
}

export interface CallRef {
    call: CompactToolCall;
    messageIndex: number;
    /** Position in the document, used to drop the oldest eligible call first. */
    order: number;
}

export interface CompactPins {
    /** Trailing messages: never dropped, results still truncated. */
    tail: Set<number>;
    /** `#pin`, the last user turn and the last failing call: never dropped, result kept verbatim. */
    hard: Set<number>;
}

export type VerdictMap = Map<string, CompactDecision>;

export function collectCalls(messages: CompactMessage[]): CallRef[] {
    const refs: CallRef[] = [];
    for (const message of messages) {
        for (const call of message.toolCalls) {
            refs.push({ call, messageIndex: message.index, order: refs.length });
        }
    }

    return refs;
}

function carriesMarker(message: CompactMessage, marker: string): boolean {
    if (message.content.includes(marker)) {
        return true;
    }

    return message.toolCalls.some((call) => (call.result ?? "").includes(marker));
}

export function looksFailed(result: string): boolean {
    return FAILURE_PATTERN.test(result.replace(CLEAN_COUNT_PATTERN, ""));
}

/** The 410 heuristics: the last user turn, the last failing tool call, and every `#pin` marker. */
export function computePins(messages: CompactMessage[], pin: number): CompactPins {
    const cutoff = Math.max(0, messages.length - Math.max(0, pin));
    const tail = new Set(messages.slice(cutoff).map((message) => message.index));
    const hard = new Set<number>();

    const lastUser = messages.findLast((message) => message.role === "user");
    if (lastUser) {
        hard.add(lastUser.index);
    }

    const lastFailure = messages.findLast((message) =>
        message.toolCalls.some((call) => looksFailed(call.result ?? ""))
    );
    if (lastFailure) {
        hard.add(lastFailure.index);
    }

    for (const message of messages) {
        if (carriesMarker(message, PIN_MARKER)) {
            hard.add(message.index);
        }
    }

    return { tail, hard };
}

function decision(options: {
    ref: CallRef;
    verdict: CompactVerdict;
    reason: string;
    keptChars: number;
}): CompactDecision {
    return {
        callId: options.ref.call.id,
        messageIndex: options.ref.messageIndex,
        toolName: options.ref.call.name,
        verdict: options.verdict,
        reason: options.reason,
        layer: 1,
        resultChars: options.ref.call.result?.length ?? 0,
        keptChars: options.keptChars,
    };
}

export function initialVerdicts(refs: CallRef[], pins: CompactPins, options: StructuralCompactOptions): VerdictMap {
    const totals = new Map<string, number>();
    for (const ref of refs) {
        totals.set(ref.call.name, (totals.get(ref.call.name) ?? 0) + 1);
    }

    const seen = new Map<string, number>();
    const verdicts: VerdictMap = new Map();
    for (const ref of refs) {
        const count = (seen.get(ref.call.name) ?? 0) + 1;
        seen.set(ref.call.name, count);
        const result = ref.call.result ?? "";
        const protectedMessage = pins.hard.has(ref.messageIndex) || pins.tail.has(ref.messageIndex);

        if (pins.hard.has(ref.messageIndex) || result.length <= options.maxResult) {
            const reason = pins.hard.has(ref.messageIndex) ? "pinned_verbatim" : "small_result";
            verdicts.set(ref.call.id, decision({ ref, verdict: "keep", reason, keptChars: result.length }));
            continue;
        }

        const superseded = (totals.get(ref.call.name) ?? 0) > count;
        if (!protectedMessage && superseded && result.length > options.maxResult * SUPERSEDED_FACTOR) {
            verdicts.set(ref.call.id, decision({ ref, verdict: "drop", reason: "superseded", keptChars: 0 }));
            continue;
        }

        verdicts.set(
            ref.call.id,
            decision({
                ref,
                verdict: "truncate",
                reason: "truncate_result",
                keptChars: truncateResult(result, options.maxResult).length,
            })
        );
    }

    return verdicts;
}

function resultText(
    call: CompactToolCall,
    verdict: CompactDecision | undefined,
    maxResult: number
): string | undefined {
    if (call.result === undefined || verdict?.verdict === "drop") {
        return undefined;
    }

    if (verdict?.summary && verdict.summaryText !== undefined) {
        return `${SUMMARY_MARKER} ${verdict.summaryText}`;
    }

    return verdict?.verdict === "truncate" ? truncateResult(call.result, maxResult) : call.result;
}

export function renderCompact(
    messages: CompactMessage[],
    verdicts: VerdictMap,
    maxResult: number
): { messages: CompactMessage[]; lines: string[]; outBytes: number } {
    const kept: CompactMessage[] = [];
    for (const message of messages) {
        if (message.raw !== undefined) {
            kept.push(message);
            continue;
        }

        const toolCalls = message.toolCalls
            .filter((call) => verdicts.get(call.id)?.verdict !== "drop")
            .map((call) => ({ ...call, result: resultText(call, verdicts.get(call.id), maxResult) }));
        const next: CompactMessage = { ...message, toolCalls };
        if (!isEmptyMessage(next)) {
            kept.push(next);
        }
    }

    const lines = kept.map((message) => serializeCompactMessage(message));
    return { messages: kept, lines, outBytes: measureBytes(lines) };
}

/**
 * Drops the oldest eligible call until the keep-ratio target is met. A call in a pinned message is
 * never eligible; truncation has already shrunk it.
 */
export function applyKeepRatio(options: {
    messages: CompactMessage[];
    refs: CallRef[];
    pins: CompactPins;
    verdicts: VerdictMap;
    inBytes: number;
    structural: StructuralCompactOptions;
}): number {
    const target = 1 - options.structural.keep;
    let rendered = renderCompact(options.messages, options.verdicts, options.structural.maxResult);
    let reduction = options.inBytes === 0 ? 0 : 1 - rendered.outBytes / options.inBytes;
    const eligible = options.refs.filter(
        (ref) =>
            !options.pins.hard.has(ref.messageIndex) &&
            !options.pins.tail.has(ref.messageIndex) &&
            options.verdicts.get(ref.call.id)?.verdict !== "drop"
    );

    for (const ref of eligible) {
        if (reduction >= target) {
            break;
        }

        options.verdicts.set(ref.call.id, decision({ ref, verdict: "drop", reason: "keep_ratio", keptChars: 0 }));
        rendered = renderCompact(options.messages, options.verdicts, options.structural.maxResult);
        reduction = options.inBytes === 0 ? 0 : 1 - rendered.outBytes / options.inBytes;
    }

    return reduction;
}

/**
 * Emits the extra decision row that proves a drop did not orphan a `tool_result`: when the call and
 * its result lived in different messages, BOTH blocks leave together.
 */
export function pairedDropDecisions(refs: CallRef[], verdicts: VerdictMap): CompactDecision[] {
    const extra: CompactDecision[] = [];
    for (const ref of refs) {
        const verdict = verdicts.get(ref.call.id);
        const from = ref.call.resultFrom;
        if (verdict?.verdict !== "drop" || from === undefined || from === ref.messageIndex) {
            continue;
        }

        extra.push({ ...verdict, messageIndex: from, reason: "paired_drop", keptChars: 0 });
    }

    return extra;
}

export interface StructuralPass {
    refs: CallRef[];
    pins: CompactPins;
    verdicts: VerdictMap;
    inBytes: number;
    options: StructuralCompactOptions;
    baseline: { messages: CompactMessage[]; lines: string[]; outBytes: number };
}

/**
 * Layer 1 without the reporting. Layer 2 reuses this state so `--llm` overrides the heuristic
 * verdicts in place instead of running the whole pass a second time on a different input.
 */
export function runStructuralPass(messages: CompactMessage[], options: StructuralCompactOptions): StructuralPass {
    const end = prof.start("structural");
    const refs = collectCalls(messages);
    const baseline = renderCompact(
        messages,
        new Map(refs.map((ref) => [ref.call.id, decision({ ref, verdict: "keep", reason: "baseline", keptChars: 0 })])),
        options.maxResult
    );
    const inBytes = baseline.outBytes;
    const resolved =
        options.keepTokens === undefined
            ? options
            : { ...options, keep: Math.min(options.keep, (options.keepTokens * 4) / Math.max(inBytes, 1)) };
    const pins = computePins(messages, resolved.pin);
    const verdicts = initialVerdicts(refs, pins, resolved);
    applyKeepRatio({ messages, refs, pins, verdicts, inBytes, structural: resolved });
    end();
    return { refs, pins, verdicts, inBytes, options: resolved, baseline };
}

export function finishCompact(messages: CompactMessage[], pass: StructuralPass, sourceBytes = 0): CompactResult {
    const rendered = renderCompact(messages, pass.verdicts, pass.options.maxResult);
    const reduction = pass.inBytes === 0 ? 0 : 1 - rendered.outBytes / pass.inBytes;
    const decisions = [...pass.verdicts.values(), ...pairedDropDecisions(pass.refs, pass.verdicts)];
    const counts = { messages: messages.length, toolCalls: pass.refs.length, sourceBytes };
    const layer2 = { used: false, jevRequests: 0, summaries: 0, replaced: 0, discarded: 0 };
    const byVerdict = { keep: 0, truncate: 0, drop: 0 };
    for (const item of pass.verdicts.values()) {
        byVerdict[item.verdict] += 1;
    }

    log.info(
        {
            messages: messages.length,
            toolCalls: pass.refs.length,
            inBytes: pass.inBytes,
            outBytes: rendered.outBytes,
            reduction: Number(reduction.toFixed(4)),
            pinnedTail: pass.pins.tail.size,
            pinnedHard: pass.pins.hard.size,
            decisions: byVerdict,
        },
        "Compaction pass complete"
    );

    if (reduction < pass.options.threshold) {
        log.info(
            { reduction, threshold: pass.options.threshold },
            "Reduction below threshold; returning the input unchanged"
        );
        return {
            format: "generic-jsonl",
            messages: pass.baseline.messages,
            lines: pass.baseline.lines,
            decisions,
            stats: { inBytes: pass.inBytes, outBytes: pass.inBytes, reduction: 0, unchanged: true },
            layer2,
            counts,
            reason: "below_threshold",
        };
    }

    return {
        format: "generic-jsonl",
        messages: rendered.messages,
        lines: rendered.lines,
        decisions,
        stats: { inBytes: pass.inBytes, outBytes: rendered.outBytes, reduction, unchanged: false },
        layer2,
        counts,
    };
}

export function compactStructural(messages: CompactMessage[], options: StructuralCompactOptions): CompactResult {
    return finishCompact(messages, runStructuralPass(messages, options));
}
