import { isRecord } from "@genesiscz/utils/ai/usage/transcripts/parse-helpers";
import type { DriverLineParser, DriverUsageEvent } from "@genesiscz/utils/ai/usage/transcripts/types";
import { readLines } from "@genesiscz/utils/fs/read-lines";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import type { SessionCall } from "../analysis-types";

/** Every non-empty line of a transcript (plain or `.zst`), in file order; a file that cannot be read yields none. */
export async function forEachTranscriptLine(path: string, visit: (line: string) => void): Promise<void> {
    try {
        for await (const line of readLines(path)) {
            if (line.trim()) {
                visit(line);
            }
        }
    } catch (err) {
        logger.debug({ err, path }, "[session-analysis] could not read the transcript");
    }
}

/** A JSON object row, or null for a line that is not one. Malformed lines are logged at debug and skipped. */
export function parseRow(line: string, path: string): Record<string, unknown> | null {
    try {
        const value: unknown = SafeJSON.parse(line, { strict: true });

        return isRecord(value) && !Array.isArray(value) ? value : null;
    } catch (err) {
        logger.debug({ err, path }, "[session-analysis] skipping a malformed transcript line");
        return null;
    }
}

export function callOfDriverEvent(event: DriverUsageEvent): SessionCall {
    return {
        id: event.id,
        t: event.timestamp,
        model: event.model,
        input: event.inputTokens,
        cacheRead: event.cacheReadTokens,
        cacheWrite: event.cacheCreationTokens,
        ...(event.cacheCreation1hTokens === undefined ? {} : { cacheWrite1h: event.cacheCreation1hTokens }),
        output: event.outputTokens,
        sidechain: event.isSidechain === true,
        aggregate: event.aggregate === true,
        ...(event.recordedCostUsd === undefined ? {} : { recordedCostUsd: event.recordedCostUsd }),
    };
}

/**
 * The calls a usage line parser emits over one transcript, each id once and every call with a timestamp. The same
 * parser the spend report uses, so a session's analysis and its spend count the same calls.
 */
export async function callsOfParser(path: string, parser: DriverLineParser): Promise<SessionCall[]> {
    const seen = new Set<string>();
    const calls: SessionCall[] = [];

    await forEachTranscriptLine(path, (line) => {
        parser.parseLine(line, (event) => {
            if (!event.timestamp || seen.has(event.id)) {
                return;
            }

            seen.add(event.id);
            calls.push(callOfDriverEvent(event));
        });
    });

    return calls.sort((a, b) => Date.parse(a.t) - Date.parse(b.t));
}

/** An ISO instant of a row's `timestamp` (ISO text, Unix seconds or milliseconds), or null. */
export function isoOf(value: unknown): string | null {
    if (typeof value === "string" && !Number.isNaN(Date.parse(value))) {
        return new Date(value).toISOString();
    }

    if (typeof value === "number" && Number.isFinite(value) && value > 0) {
        return new Date(value < 1e12 ? value * 1000 : value).toISOString();
    }

    return null;
}
