import { isRecord } from "@genesiscz/utils/ai/usage/transcripts/parse-helpers";
import type { SessionAnalysisReader, SessionCompaction, SessionQuotaReading } from "../analysis-types";
import { callsOfParser, factsOf, forEachTranscriptLine, isoOf, parseRow } from "./analysis-lines";
import { createCodexUsageParser } from "./codex-usage";

function record(value: unknown): Record<string, unknown> | null {
    return isRecord(value) && !Array.isArray(value) ? value : null;
}

/** One `rate_limits` slot (`primary`, `secondary`) as a reading; null for an empty slot. */
function readingOf(slot: string, value: unknown, t: string): SessionQuotaReading | null {
    const window = record(value);

    if (!window || typeof window.used_percent !== "number") {
        return null;
    }

    const resetsAt =
        typeof window.resets_at === "number"
            ? isoOf(window.resets_at)
            : typeof window.resets_in_seconds === "number"
              ? new Date(Date.parse(t) + window.resets_in_seconds * 1000).toISOString()
              : null;

    return {
        t,
        slot,
        usedPercent: window.used_percent,
        windowMinutes: typeof window.window_minutes === "number" ? window.window_minutes : null,
        resetsAt,
    };
}

/**
 * Codex's analysis facts. Calls come from the same usage parser the spend report uses (the `token_count` deltas). A
 * compaction is a `compacted` rollout item, or a `context_compacted` event of an older rollout. Each `token_count`
 * event carries the account's `rate_limits`, so Codex is the one harness whose transcript holds quota readings.
 */
export const codexAnalysis: SessionAnalysisReader = {
    async callTrace(transcriptPath) {
        return callsOfParser(transcriptPath, createCodexUsageParser({ file: transcriptPath, state: undefined }));
    },

    async compactions(transcriptPath) {
        const items: SessionCompaction[] = [];

        const failed = await forEachTranscriptLine(transcriptPath, (line) => {
            if (!line.includes("compacted")) {
                return;
            }

            const row = parseRow(line, transcriptPath);
            const payload = record(row?.payload);
            const t = isoOf(row?.timestamp);
            const compacted =
                row?.type === "compacted" || (row?.type === "event_msg" && payload?.type === "context_compacted");

            if (row && t && compacted) {
                items.push({ t, trigger: row.type === "compacted" ? "auto" : null, preTokens: null });
            }
        });

        return factsOf(items, failed);
    },

    async quotaReadings(transcriptPath) {
        const items: SessionQuotaReading[] = [];
        // The last reading per slot: a primary and a secondary reading alternate in every row.
        const last = new Map<string, string>();

        const failed = await forEachTranscriptLine(transcriptPath, (line) => {
            if (!line.includes("rate_limits")) {
                return;
            }

            const row = parseRow(line, transcriptPath);
            const payload = record(row?.payload);
            const limits = record(payload?.rate_limits);
            const t = isoOf(row?.timestamp);

            if (!limits || !t) {
                return;
            }

            for (const slot of ["primary", "secondary"]) {
                const reading = readingOf(slot, limits[slot], t);

                // Every token_count repeats the same reading until the next poll; keep only a change.
                const key = reading ? `${slot}:${reading.usedPercent}:${reading.resetsAt}` : "";

                if (reading && key !== last.get(slot)) {
                    items.push(reading);
                    last.set(slot, key);
                }
            }
        });

        return factsOf(items, failed);
    },
};
