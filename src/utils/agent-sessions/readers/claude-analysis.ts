import { isRecord } from "@genesiscz/utils/ai/usage/transcripts/parse-helpers";
import type { SessionAnalysisReader, SessionCall, SessionCompaction } from "../analysis-types";
import { factsOrFailure, forEachTranscriptLine, isoOf, parseRow } from "./analysis-lines";

import {
    claudeCall,
    decodeClaudeRow,
    isCompactBoundary,
    lastClaudeContext,
    readClaudeLoops,
} from "./claude-analysis-loops";
import { collectResumes } from "./claude-resumes";

/**
 * Claude's analysis facts. Calls are the assistant rows with usage, deduplicated by message id (Claude Code writes one
 * row per content block, each carrying the same usage). A compaction is a system row of subtype `compact_boundary`.
 * Claude transcripts carry no quota reading: the limits live in response headers the CLI does not write down.
 */
export const claudeAnalysis: SessionAnalysisReader = {
    lastContext: lastClaudeContext,
    resumes(path, selection = {}) {
        return readClaudeLoops(path, selection, collectResumes);
    },
    async callTrace(transcriptPath) {
        const seen = new Set<string>();
        const items: SessionCall[] = [];

        const failed = await forEachTranscriptLine(transcriptPath, (line) => {
            if (!line.includes('"assistant"')) {
                return;
            }

            const row = decodeClaudeRow(line, transcriptPath);
            const call = row && claudeCall(row);
            if (!call || seen.has(call.id)) {
                return;
            }

            seen.add(call.id);
            items.push(call);
        });

        return factsOrFailure(items, failed);
    },

    async compactions(transcriptPath) {
        const items: SessionCompaction[] = [];

        const failed = await forEachTranscriptLine(transcriptPath, (line) => {
            if (!line.includes("compact_boundary")) {
                return;
            }

            const row = parseRow(line, transcriptPath);

            if (!row || !isCompactBoundary(row)) {
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

        return factsOrFailure(items, failed);
    },

    async quotaReadings() {
        return {
            supported: false,
            reason: "Claude Code writes no quota reading into its transcript; the usage poller records the windows",
        };
    },
};
