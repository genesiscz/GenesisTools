import { Database } from "bun:sqlite";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { SafeJSON } from "@app/utils/json";
import { detectTerminalApp } from "@app/utils/terminal";
import { MacOS } from "./MacOS";

// Apple Core Data epoch offset: 2001-01-01 vs 1970-01-01
const APPLE_EPOCH_OFFSET = 978307200;

export interface VoiceMemo {
    id: number;
    title: string;
    date: Date;
    duration: number;
    path: string;
    uuid: string;
    hasTranscript: boolean;
}

export interface TranscriptSegment {
    text: string;
    startTime?: number;
    endTime?: number;
}

export interface TranscriptionResult {
    text: string;
    segments: TranscriptSegment[];
}

interface DbLocation {
    dbPath: string;
    recordingsDir: string;
}

interface DbRow {
    Z_PK: number;
    ZENCRYPTEDTITLE: string | null;
    ZCUSTOMLABEL: string | null;
    ZDATE: number;
    ZDURATION: number;
    ZPATH: string | null;
    ZUNIQUEID: string;
}

const DB_CANDIDATES = [
    "Library/Group Containers/group.com.apple.VoiceMemos.shared/Recordings",
    "Library/Application Support/com.apple.voicememos/Recordings",
    "Library/Containers/com.apple.VoiceMemos/Data/Library/Application Support/Recordings",
];

const DB_NAMES = ["CloudRecordings.db", "Recordings.db"];

export class VoiceMemosError extends Error {
    constructor(
        message: string,
        public readonly code: "NO_DATABASE" | "PERMISSION_DENIED" | "INVALID_DATA"
    ) {
        super(message);
        this.name = "VoiceMemosError";
    }
}

function resolveDbLocation(): DbLocation {
    const home = homedir();

    for (const candidate of DB_CANDIDATES) {
        const dir = join(home, candidate);

        for (const dbName of DB_NAMES) {
            const dbPath = join(dir, dbName);

            if (existsSync(dbPath)) {
                return { dbPath, recordingsDir: dir };
            }
        }
    }

    throw new VoiceMemosError(
        [
            "No Voice Memos database found.",
            "",
            "Voice Memos may not have been used on this Mac, or iCloud sync may be disabled.",
            "Open the Voice Memos app and record something to create the database.",
        ].join("\n"),
        "NO_DATABASE"
    );
}

function openDb(dbPath: string): Database {
    try {
        return new Database(dbPath, { readonly: true });
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);

        if (
            message.includes("unable to open") ||
            message.includes("permission") ||
            message.includes("not authorized") ||
            message.includes("authorization denied")
        ) {
            const termApp = detectTerminalApp();

            MacOS.settings.openFullDiskAccess();

            throw new VoiceMemosError(
                [
                    "Full Disk Access required for Voice Memos.",
                    "",
                    "Opening System Settings → Privacy & Security → Full Disk Access...",
                    `Add "${termApp}" to the list, then restart your terminal.`,
                ].join("\n"),
                "PERMISSION_DENIED"
            );
        }

        throw err;
    }
}

function rowToMemo(row: DbRow, recordingsDir: string): VoiceMemo {
    // ZENCRYPTEDTITLE has the human-readable name ("New Recording 64"),
    // ZCUSTOMLABEL has the ISO timestamp used as a fallback identifier
    const title = row.ZENCRYPTEDTITLE || row.ZCUSTOMLABEL || "Untitled";
    const date = new Date((row.ZDATE + APPLE_EPOCH_OFFSET) * 1000);
    const duration = row.ZDURATION;

    let filePath = "";

    if (row.ZPATH) {
        if (row.ZPATH.startsWith("/")) {
            filePath = row.ZPATH;
        } else {
            filePath = resolve(recordingsDir, row.ZPATH);
        }
    }

    return {
        id: row.Z_PK,
        title,
        date,
        duration,
        path: filePath,
        uuid: row.ZUNIQUEID,
        hasTranscript: filePath ? hasTranscript(filePath) : false,
    };
}

// ---------------------------------------------------------------------------
// MPEG-4 atom / box parser for tsrp transcript extraction
// ---------------------------------------------------------------------------

interface AtomHeader {
    size: number;
    type: string;
}

interface AtomLocation {
    offset: number;
    size: number;
}

function readAtomHeader(buffer: Buffer, offset: number): AtomHeader | null {
    if (offset + 8 > buffer.length) {
        return null;
    }

    const size = buffer.readUInt32BE(offset);
    const type = buffer.toString("ascii", offset + 4, offset + 8);

    if (size < 8 && size !== 0) {
        return null;
    }

    return { size: size === 0 ? buffer.length - offset : size, type };
}

function findAtom(buffer: Buffer, start: number, end: number, targetType: string): AtomLocation | null {
    let offset = start;

    while (offset < end) {
        const header = readAtomHeader(buffer, offset);

        if (!header) {
            break;
        }

        if (header.type === targetType) {
            return { offset, size: header.size };
        }

        offset += header.size;
    }

    return null;
}

function findNestedAtom(buffer: Buffer, path: string[]): AtomLocation | null {
    let start = 0;
    let end = buffer.length;

    for (const atomType of path) {
        const found = findAtom(buffer, start, end, atomType);

        if (!found) {
            return null;
        }

        if (atomType === path[path.length - 1]) {
            return found;
        }

        // Container atoms: children start after 8-byte header
        start = found.offset + 8;
        end = found.offset + found.size;
    }

    return null;
}

function parseTsrpPayload(json: string): TranscriptionResult | null {
    try {
        const data = SafeJSON.parse(json);

        if (!data || typeof data !== "object") {
            return null;
        }

        // Format 1: { attributedString: { string: "...", runs: [...], attributeTable: [...] } }
        if (data.attributedString) {
            return parseAttributedString(data.attributedString);
        }

        // Format 2: top-level has string + runs + attributeTable
        if (typeof data.string === "string" && Array.isArray(data.runs)) {
            return parseAttributedString(data);
        }

        return null;
    } catch {
        return null;
    }
}

interface TimeRange {
    location?: number;
    length?: number;
}

interface AttributedStringData {
    string?: string;
    runs?: Array<{ location?: number; length?: number; attributes?: Record<string, unknown> }>;
    attributeTable?: Array<{ timeRange?: TimeRange }>;
}

interface InterleavedItem {
    timeRange?: Required<TimeRange>;
}

function parseAttributedString(attrStr: AttributedStringData): TranscriptionResult | null {
    const fullText = attrStr.string;

    if (typeof fullText !== "string" || fullText.length === 0) {
        return null;
    }

    const segments: TranscriptSegment[] = [];

    // Try separated format: runs + attributeTable
    if (Array.isArray(attrStr.runs) && Array.isArray(attrStr.attributeTable)) {
        for (const run of attrStr.runs) {
            const loc = run.location ?? 0;
            const len = run.length ?? 0;
            const text = fullText.slice(loc, loc + len).trim();

            if (!text) {
                continue;
            }

            const segment: TranscriptSegment = { text };

            // Try to find a matching attributeTable entry for timing
            const attrs = run.attributes;

            if (attrs && typeof attrs === "object") {
                const tableIdx = Object.values(attrs).find((v) => typeof v === "number") as number | undefined;

                if (tableIdx !== undefined && attrStr.attributeTable[tableIdx]) {
                    const tableEntry = attrStr.attributeTable[tableIdx];

                    const tr = tableEntry.timeRange;

                    if (tr && tr.location !== undefined && tr.length !== undefined) {
                        segment.startTime = tr.location;
                        segment.endTime = tr.location + tr.length;
                    }
                }
            }

            segments.push(segment);
        }

        if (segments.length > 0) {
            return { text: fullText, segments };
        }
    }

    // Try interleaved format: alternating text strings and {timeRange} dicts
    if (Array.isArray(attrStr.runs)) {
        let _textOffset = 0;

        for (const item of attrStr.runs as Array<string | InterleavedItem>) {
            if (typeof item === "string") {
                const trimmed = item.trim();

                if (trimmed) {
                    segments.push({ text: trimmed });
                }

                _textOffset += item.length;
            } else if (item && typeof item === "object" && item.timeRange) {
                const lastSegment = segments[segments.length - 1];

                if (lastSegment && lastSegment.startTime === undefined) {
                    lastSegment.startTime = item.timeRange.location;
                    lastSegment.endTime = item.timeRange.location + item.timeRange.length;
                }
            }
        }

        if (segments.length > 0) {
            return { text: fullText, segments };
        }
    }

    // Fallback: no timing info, just the full text as one segment
    return { text: fullText, segments: [{ text: fullText }] };
}

export function hasTranscript(filePath: string): boolean {
    try {
        if (!existsSync(filePath)) {
            return false;
        }

        const buffer = readFileSync(filePath);
        const tsrp = findNestedAtom(buffer, ["moov", "trak", "udta", "tsrp"]);
        return tsrp !== null;
    } catch {
        return false;
    }
}

export function extractTranscript(filePath: string): TranscriptionResult | null {
    if (!existsSync(filePath)) {
        return null;
    }

    const buffer = readFileSync(filePath);
    const tsrp = findNestedAtom(buffer, ["moov", "trak", "udta", "tsrp"]);

    if (!tsrp) {
        return null;
    }

    // tsrp payload starts after the 8-byte atom header
    const payloadStart = tsrp.offset + 8;
    const payloadEnd = tsrp.offset + tsrp.size;

    if (payloadStart >= payloadEnd) {
        return null;
    }

    const rawPayload = buffer.subarray(payloadStart, payloadEnd);

    // Find the start of JSON data (skip any leading non-JSON bytes)
    let jsonStart = 0;

    for (let i = 0; i < rawPayload.length; i++) {
        if (rawPayload[i] === 0x7b) {
            // '{'
            jsonStart = i;
            break;
        }
    }

    const jsonStr = rawPayload.subarray(jsonStart).toString("utf-8").replace(/\0+$/, "");
    return parseTsrpPayload(jsonStr);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function listMemos(): VoiceMemo[] {
    const { dbPath, recordingsDir } = resolveDbLocation();
    const db = openDb(dbPath);

    try {
        const rows = db
            .query<DbRow, []>(
                `SELECT Z_PK, ZENCRYPTEDTITLE, ZCUSTOMLABEL, ZDATE, ZDURATION, ZPATH, ZUNIQUEID
                 FROM ZCLOUDRECORDING
                 WHERE ZEVICTIONDATE IS NULL
                 ORDER BY ZDATE DESC`
            )
            .all();

        return rows.map((row) => rowToMemo(row, recordingsDir));
    } finally {
        db.close();
    }
}

export function getMemo(id: number): VoiceMemo | null {
    const { dbPath, recordingsDir } = resolveDbLocation();
    const db = openDb(dbPath);

    try {
        const row = db
            .query<DbRow, [number]>(
                `SELECT Z_PK, ZENCRYPTEDTITLE, ZCUSTOMLABEL, ZDATE, ZDURATION, ZPATH, ZUNIQUEID
                 FROM ZCLOUDRECORDING
                 WHERE Z_PK = ?`
            )
            .get(id);

        if (!row) {
            return null;
        }

        return rowToMemo(row, recordingsDir);
    } finally {
        db.close();
    }
}

export function searchMemos(query: string): VoiceMemo[] {
    const lowerQuery = query.toLowerCase();
    const memos = listMemos();

    return memos.filter((memo) => {
        if (memo.title.toLowerCase().includes(lowerQuery)) {
            return true;
        }

        // Search transcript text if available
        if (memo.hasTranscript && memo.path) {
            const transcript = extractTranscript(memo.path);

            if (transcript?.text.toLowerCase().includes(lowerQuery)) {
                return true;
            }
        }

        return false;
    });
}
