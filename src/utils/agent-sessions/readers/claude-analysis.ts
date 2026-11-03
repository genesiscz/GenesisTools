import { parseTranscriptLine } from "@genesiscz/utils/ai/usage/spend/parse";
import { isRecord } from "@genesiscz/utils/ai/usage/transcripts/parse-helpers";
import type { SessionAnalysisReader, SessionCall, SessionCompaction } from "../analysis-types";
import { factsOf, forEachTranscriptLine, isoOf, parseRow } from "./analysis-lines";

/** Claude Code writes local notices (API errors, "No response.") as assistant rows of this model: not model calls. */
const SYNTHETIC_MODEL = "<synthetic>";

/**
 * Claude's analysis facts. Calls are the assistant rows with usage, deduplicated by message id (Claude Code writes one
 * row per content block, each carrying the same usage). A compaction is a system row of subtype `compact_boundary`.
 * Claude transcripts carry no quota reading: the limits live in response headers the CLI does not write down.
 */
export const claudeAnalysis: SessionAnalysisReader = {
    async callTrace(transcriptPath) {
        const seen = new Set<string>();
        const items: SessionCall[] = [];

        const failed = await forEachTranscriptLine(transcriptPath, (line) => {
            if (!line.includes('"assistant"')) {
                return;
            }

            const event = parseTranscriptLine(line);

            if (!event || !event.timestamp || event.model === SYNTHETIC_MODEL || seen.has(event.messageId)) {
                return;
            }

            seen.add(event.messageId);
            items.push({
                id: event.messageId,
                t: new Date(event.timestamp).toISOString(),
                model: event.model,
                input: event.inputTokens,
                cacheRead: event.cacheReadTokens,
                cacheWrite: event.cacheCreationTokens,
                ...(event.cacheCreation1hTokens === undefined ? {} : { cacheWrite1h: event.cacheCreation1hTokens }),
                output: event.outputTokens,
                sidechain: event.isSidechain === true,
                aggregate: false,
            });
        });

        return factsOf(items, failed);
    },

    async compactions(transcriptPath) {
        const items: SessionCompaction[] = [];

        const failed = await forEachTranscriptLine(transcriptPath, (line) => {
            if (!line.includes("compact_boundary")) {
                return;
            }

            const row = parseRow(line, transcriptPath);

            if (!row || row.type !== "system" || row.subtype !== "compact_boundary") {
                return;
            }

            const t = isoOf(row.timestamp);
            const meta = isRecord(row.compactMetadata) ? row.compactMetadata : {};

            if (t) {
                items.push({
                    t,
                    trigger: typeof meta.trigger === "string" ? meta.trigger : null,
                    preTokens: typeof meta.preTokens === "number" ? meta.preTokens : null,
                });
            }
        });

        return factsOf(items, failed);
    },

    async quotaReadings() {
        return {
            supported: false,
            reason: "Claude Code writes no quota reading into its transcript; the usage poller records the windows",
        };
    },
};
