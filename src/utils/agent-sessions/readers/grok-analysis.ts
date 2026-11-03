import { dirname, join } from "node:path";
import type { SessionAnalysisReader } from "../analysis-types";
import { callsOfParser } from "./analysis-lines";
import { grokCurrentModel } from "./grok-model";
import { createGrokUsageParser } from "./grok-usage";

/** Grok bills in `updates.jsonl` beside the chat history, one `turn_completed` row per turn. */
function updatesPath(transcriptPath: string): string {
    return join(dirname(transcriptPath), "updates.jsonl");
}

/**
 * Grok's analysis facts. Calls are its `turn_completed` usage rows, each the sum of a turn's requests (`aggregate`).
 * Grok keeps only a compaction COUNT (`signals.json`, no instant and no size), and its files hold no quota reading,
 * so both members answer that they cannot.
 */
export const grokAnalysis: SessionAnalysisReader = {
    async callTrace(transcriptPath) {
        const file = updatesPath(transcriptPath);
        return callsOfParser(
            file,
            createGrokUsageParser({
                file,
                state: undefined,
                resolveCurrentModel: () => grokCurrentModel(transcriptPath) ?? undefined,
            })
        );
    },

    async compactions() {
        return {
            supported: false,
            reason: "Grok records only a compaction count (signals.json), with no time or size",
        };
    },

    async quotaReadings() {
        return { supported: false, reason: "Grok's session files carry no quota reading" };
    },
};
