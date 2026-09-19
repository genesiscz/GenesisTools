import type { Evaluator } from "@genesiscz/utils/ai/evaluation/service";
import { logger } from "@genesiscz/utils/logger";
import { profiler } from "@genesiscz/utils/profile";
import { type CompactSummarizer, compactWithJev } from "./llm";
import type { CompactResult } from "./schema";
import { type CompactSource, loadCompactMessages } from "./sources";
import { compactStructural, type StructuralCompactOptions } from "./structural";

const log = logger.child({ component: "ai:compact" });
const prof = profiler.scope("jev-compact");

export const COMPACT_DEFAULTS: StructuralCompactOptions = { keep: 0.5, pin: 6, maxResult: 800, threshold: 0.25 };

export interface CompactSessionOptions extends Partial<StructuralCompactOptions> {
    text: string;
    /** Needed for `--source claude|codex|grok`: the native readers parse from disk. */
    filePath?: string;
    source?: CompactSource;
    llm?: boolean;
    summaries?: boolean;
    evaluate?: Evaluator;
    summarize?: CompactSummarizer;
    maxSummaries?: number;
    signal?: AbortSignal;
}

/**
 * The one compaction entry point. The CLI command, the MCP tool and `--follow` all call this, so a
 * behaviour can never exist on one door and not the others.
 */
export async function compactSession(options: CompactSessionOptions): Promise<CompactResult> {
    const sourceBytes = Buffer.byteLength(options.text, "utf8");
    const source = options.source ?? "auto";
    const structural: StructuralCompactOptions = {
        keep: options.keep ?? COMPACT_DEFAULTS.keep,
        pin: options.pin ?? COMPACT_DEFAULTS.pin,
        maxResult: options.maxResult ?? COMPACT_DEFAULTS.maxResult,
        threshold: options.threshold ?? COMPACT_DEFAULTS.threshold,
        keepTokens: options.keepTokens,
    };
    log.info({ sourceBytes, source, llm: options.llm === true, filePath: options.filePath }, "Compacting a session");

    const parsed = await prof.measureAsync("parse", () =>
        loadCompactMessages({ text: options.text, filePath: options.filePath, source, signal: options.signal })
    );
    log.info({ format: parsed.format, messages: parsed.messages.length }, "Compact input parsed");

    if (options.llm && !options.evaluate) {
        throw new Error("compact --llm needs a Jev evaluator; pass `evaluate`.");
    }

    const result =
        options.llm && options.evaluate
            ? await compactWithJev({
                  messages: parsed.messages,
                  structural,
                  evaluate: options.evaluate,
                  summaries: options.summaries,
                  summarize: options.summarize,
                  maxSummaries: options.maxSummaries,
                  sourceBytes,
                  signal: options.signal,
              })
            : compactStructural(parsed.messages, structural);

    return { ...result, format: parsed.format, counts: { ...result.counts, sourceBytes } };
}

/** The `--table` rows. Rendered on stderr by the caller through `ui.*`, never on stdout. */
export function formatDecisionTable(result: CompactResult): string[] {
    const width = Math.max(4, ...result.decisions.map((decision) => decision.toolName.length));
    return result.decisions.map((decision) => {
        const marks = [decision.verdict === "truncate" ? `${decision.keptChars}/${decision.resultChars}` : ""];
        return [
            String(decision.messageIndex).padStart(4),
            decision.toolName.padEnd(width),
            decision.verdict.padEnd(8),
            decision.reason.padEnd(16),
            `L${decision.layer}`,
            ...marks.filter((mark) => mark !== ""),
        ].join("  ");
    });
}

export { detectCompactFormat, parseCompactDocument, serializeCompactMessage } from "./format";
export { booleanAnswer, type CompactSummarizer, compactWithJev, JEV_BATCH_SIZE, JEV_BOOLEAN_THRESHOLD } from "./llm";
export {
    COMPACT_FORMATS,
    COMPACT_VERDICTS,
    type CompactDecision,
    type CompactFormat,
    type CompactMessage,
    type CompactResult,
    type CompactRole,
    type CompactToolCall,
    type CompactVerdict,
    SUMMARY_MARKER,
} from "./schema";
export { COMPACT_SOURCES, type CompactSource, parseCompactSource } from "./sources";
export { type FollowCompactOptions, followCompact } from "./stream";
export { compactStructural, type StructuralCompactOptions } from "./structural";
