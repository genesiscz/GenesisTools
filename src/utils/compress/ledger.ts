import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { hostname } from "node:os";
import { dirname } from "node:path";
import { readLinesSync } from "@genesiscz/utils/fs/read-lines";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { genesisToolsDir } from "@genesiscz/utils/storage/root";

/** The on-disk format every writer here produces; bump it when the layout of a `.zst` written here changes. */
export const FORMAT_VERSION = "seekable-zstd-1";

export type LedgerOp = "compress" | "pack" | "decompress" | "unpack" | "remove";

export interface LedgerRecord {
    id: string;
    op: LedgerOp;
    /** Who asked: `cli`, `logs`, `ai-proxy-transcripts`, `codex-migrate-home`, `app-retired`, … */
    caller: string;
    source: string;
    target: string;
    sourceBytes: number;
    targetBytes: number;
    /** `sourceBytes / targetBytes` for a compression, the reverse for a decompression. */
    ratio: number;
    preset?: string;
    level?: number;
    long?: boolean;
    frameBytes?: number;
    threads?: number;
    /** Always null today: no dictionary is used. Kept so a later dictionary run is searchable. */
    dictionary: string | null;
    inputSha256?: string;
    outputSha256?: string;
    removedOriginal: boolean;
    startedAt: string;
    endedAt: string;
    host: string;
    format: string;
    bunVersion: string;
    zstdVersion: string;
    error?: string;
}

export type LedgerEntry = Omit<LedgerRecord, "id" | "host" | "format" | "bunVersion" | "zstdVersion" | "dictionary"> & {
    dictionary?: string | null;
};

export function ledgerPath(): string {
    return genesisToolsDir("compress", "ledger.jsonl");
}

/**
 * Appends one operation to the ledger (`~/.genesis-tools/compress/ledger.jsonl`). Never throws: a ledger that cannot
 * be written must not fail the compression it describes, so the failure goes to the day log instead.
 */
export function recordCompression(entry: LedgerEntry): LedgerRecord {
    const record: LedgerRecord = {
        id: crypto.randomUUID(),
        host: hostname(),
        format: FORMAT_VERSION,
        bunVersion: Bun.version,
        zstdVersion: process.versions.zstd ?? "unknown",
        dictionary: null,
        ...entry,
    };

    try {
        const path = ledgerPath();
        const dir = dirname(path);

        if (!existsSync(dir)) {
            mkdirSync(dir, { recursive: true });
        }

        // One line per append, under PIPE_BUF-sized writes, so concurrent writers do not interleave lines.
        appendFileSync(path, `${SafeJSON.stringify(record)}\n`);
    } catch (err) {
        logger.warn({ err, source: entry.source }, "[compress] could not append to the compression ledger");
    }

    return record;
}

export interface LedgerFilter {
    /** Substring of the source or target path. */
    path?: string;
    since?: Date;
    until?: Date;
    preset?: string;
    op?: LedgerOp;
    caller?: string;
    /** Source size at least this many bytes. */
    minBytes?: number;
}

function isLedgerRecord(value: unknown): value is LedgerRecord {
    return (
        typeof value === "object" &&
        value !== null &&
        "id" in value &&
        "op" in value &&
        "source" in value &&
        "startedAt" in value
    );
}

/** Ledger records that match every given filter, oldest first. Reads the ledger line by line. */
export function searchLedger(filter: LedgerFilter = {}, path = ledgerPath()): LedgerRecord[] {
    if (!existsSync(path)) {
        return [];
    }

    const matches: LedgerRecord[] = [];

    for (const line of readLinesSync(path)) {
        if (line.trim() === "") {
            continue;
        }

        let value: unknown;

        try {
            value = SafeJSON.parse(line, { strict: true });
        } catch (err) {
            logger.debug({ err, path }, "[compress] skipped a ledger line that does not parse");
            continue;
        }

        if (!isLedgerRecord(value)) {
            continue;
        }

        const started = Date.parse(value.startedAt);
        const keep =
            (!filter.path || value.source.includes(filter.path) || value.target.includes(filter.path)) &&
            (!filter.since || started >= filter.since.getTime()) &&
            (!filter.until || started <= filter.until.getTime()) &&
            (!filter.preset || value.preset === filter.preset) &&
            (!filter.op || value.op === filter.op) &&
            (!filter.caller || value.caller === filter.caller) &&
            (filter.minBytes === undefined || value.sourceBytes >= filter.minBytes);

        if (keep) {
            matches.push(value);
        }
    }

    return matches;
}
