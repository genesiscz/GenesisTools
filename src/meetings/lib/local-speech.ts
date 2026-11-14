import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { logger } from "@genesiscz/utils/logger";
import { toolDataDir } from "@genesiscz/utils/storage/root";
import type { TranscriptEntry } from "@genesiscz/utils/transcribe/types";

export interface LocalSpeech {
    ts: number;
    text: string;
}

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
            .all(from - 15_000, until + 15_000);
    } catch (error) {
        logger.warn({ error, file }, "local speech history could not be read");
        return [];
    } finally {
        db?.close();
    }
}

export function localSpeechLines(options: {
    transcript: TranscriptEntry[];
    start: string;
    calls: LocalSpeech[];
}): Array<{ index: number; fromSec: number; text: string }> {
    const start = Date.parse(options.start);
    const words = (text: string) =>
        text
            .normalize("NFC")
            .toLowerCase()
            .replace(/[^\p{L}\p{N}]+/gu, " ")
            .trim();
    return options.transcript.flatMap((line, index) =>
        line.startSec !== undefined &&
        words(line.text) &&
        options.calls.some(
            (call) =>
                Math.abs(call.ts - start - line.startSec! * 1000) <= 15_000 && words(call.text) === words(line.text)
        )
            ? [{ index, fromSec: line.startSec, text: line.text }]
            : []
    );
}
