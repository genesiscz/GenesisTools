import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { logger } from "@genesiscz/utils/logger";
import { toolDataDir } from "@genesiscz/utils/storage/root";
import type { TranscriptEntry } from "@genesiscz/utils/transcribe/types";

export interface LocalSpeech {
    ts: number;
    text: string;
}

const CLOCK_TOLERANCE_MS = 15_000;

/** The speech history `tools say` keeps; its SQLite WAL beside it holds the calls not yet checkpointed. */
export function localSpeechDbPath(): string {
    return toolDataDir("say", "calls.db");
}

/** Reads only completed audible calls, without creating or migrating the speech database. */
export function localSpeechDuring(options: { start: string; end?: string; dbPath?: string }): LocalSpeech[] {
    const file = options.dbPath ?? localSpeechDbPath();
    if (!existsSync(file)) {
        return [];
    }
    const from = Date.parse(options.start);
    const until = options.end ? Date.parse(options.end) : from + 24 * 3600_000;
    let db: Database | undefined;
    try {
        db = new Database(file, { readonly: true });
        return db
            .query<LocalSpeech, [number, number]>(
                "SELECT ts, text FROM calls WHERE status = 'spoken' AND ts BETWEEN ? AND ? ORDER BY ts"
            )
            .all(from - CLOCK_TOLERANCE_MS, until + CLOCK_TOLERANCE_MS);
    } catch (error) {
        logger.warn({ error, file }, "local speech history could not be read");
        return [];
    } finally {
        db?.close();
    }
}

function speechWords(text: string): string[] {
    return (
        text
            .normalize("NFC")
            .toLowerCase()
            .match(/[\p{L}\p{N}]+/gu) ?? []
    );
}

function matchesSpeechCall(spoken: string[], heard: string[]): boolean {
    // A one-word notification must match exactly. Longer calls can lose, gain or change at most two words.
    const tolerance = Math.min(2, Math.floor(spoken.length / 2));
    if (!spoken.length || !heard.length || Math.abs(spoken.length - heard.length) > tolerance) {
        return false;
    }
    function matches(from: number, at: number, remaining: number): boolean {
        while (from < spoken.length && at < heard.length && spoken[from] === heard[at]) {
            from++;
            at++;
        }
        if (from === spoken.length || at === heard.length) {
            return spoken.length - from + heard.length - at <= remaining;
        }
        return (
            remaining > 0 &&
            (matches(from + 1, at + 1, remaining - 1) ||
                matches(from + 1, at, remaining - 1) ||
                matches(from, at + 1, remaining - 1))
        );
    }
    return matches(0, 0, tolerance);
}

export function localSpeechLines(options: {
    transcript: TranscriptEntry[];
    start: string;
    calls: LocalSpeech[];
}): Array<{ index: number; fromSec: number; text: string }> {
    if (!options.calls.length) {
        return [];
    }
    const start = Date.parse(options.start);
    const calls = options.calls.map((call) => ({ ts: call.ts, words: speechWords(call.text) }));
    return options.transcript.flatMap((line, index) => {
        if (line.startSec === undefined) {
            return [];
        }
        const ts = start + line.startSec * 1000;
        const heard = speechWords(line.text);
        const matched = calls.some(
            (call) => Math.abs(call.ts - ts) <= CLOCK_TOLERANCE_MS && matchesSpeechCall(call.words, heard)
        );
        return matched ? [{ index, fromSec: line.startSec, text: line.text }] : [];
    });
}
