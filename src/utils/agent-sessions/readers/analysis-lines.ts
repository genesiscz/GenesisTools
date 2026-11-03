import { isRecord } from "@genesiscz/utils/ai/usage/transcripts/parse-helpers";
import type { DriverLineParser, DriverUsageEvent } from "@genesiscz/utils/ai/usage/transcripts/types";
import { readLines } from "@genesiscz/utils/fs/read-lines";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import type { SessionCall, SessionFacts } from "../analysis-types";

/**
 * Every non-empty line of a transcript (plain or `.zst`), in file order. Answers why the file could not be read
 * (missing, unreadable, or failed midway), or undefined when every line was read: a reader turns that reason into
 * `{ supported: false, reason }`, never into an empty or partial list that reads as a real one.
 */
export async function forEachTranscriptLine(path: string, visit: (line: string) => void): Promise<string | undefined> {
    try {
        for await (const line of readLines(path)) {
            if (line.trim()) {
                visit(line);
            }
        }

        return undefined;
    } catch (err) {
        logger.debug({ err, path }, "[session-analysis] could not read the transcript");
        return `the transcript could not be read: ${err instanceof Error ? err.message : String(err)}`;
    }
}

/** The facts a transcript walk collected, or why it could not give them. */
export function factsOrFailure<T>(items: T[], failed: string | undefined): SessionFacts<T> {
    return failed === undefined ? { supported: true, items } : { supported: false, reason: failed };
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
export async function callsOfParser(path: string, parser: DriverLineParser): Promise<SessionFacts<SessionCall>> {
    const seen = new Set<string>();
    const calls: SessionCall[] = [];

    const failed = await forEachTranscriptLine(path, (line) => {
        parser.parseLine(line, (event) => {
            if (!event.timestamp || seen.has(event.id)) {
                return;
            }

            seen.add(event.id);
            calls.push(callOfDriverEvent(event));
        });
    });

    return factsOrFailure(
        calls.sort((a, b) => Date.parse(a.t) - Date.parse(b.t)),
        failed
    );
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
