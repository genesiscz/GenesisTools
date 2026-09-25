/**
 * Case-insensitive search over the whole transcript of one session, for a find-in-transcript that
 * reaches past the window a reader has loaded.
 *
 * A match is on what a reader sees in a turn: its text, its reasoning, and each tool's name, input
 * preview and (clipped) result. A large Claude session is scanned as raw bytes first and only the
 * turns whose lines contain the query are parsed and checked, so a hit on a JSON key never counts.
 */
import { logger } from "@genesiscz/utils/logger";
import { allTranscriptTurns } from "./load";
import type { ResolvedTranscript } from "./resolve";
import {
    indexedTurnAt,
    MAX_RESULT_REACH,
    readRange,
    type TurnIndex,
    type TurnIndexOptions,
    turnIndexOfTranscript,
} from "./turn-index";
import type { TranscriptTurn } from "./types";

export const DEFAULT_SEARCH_LIMIT = 500;
const SCAN_CHUNK_BYTES = 16 * 1024 * 1024;

export interface TranscriptSearchOptions {
    query: string;
    /** Most turn indices returned; `total` still counts every match. */
    limit?: number;
}

export interface TranscriptSearchResult {
    sessionId: string;
    /** Every matching turn of the transcript. */
    total: number;
    /** 0-based global turn indices, ascending, at most `limit` of them. */
    turns: number[];
    truncated: boolean;
}

/** Whether a reader would find `lowerQuery` (already lower-cased) in the turn. */
export function turnMatches(turn: TranscriptTurn, lowerQuery: string): boolean {
    const fields: (string | null | undefined)[] = [turn.text, turn.reasoning];
    for (const tool of turn.tools) {
        fields.push(tool.name, tool.inputPreview, tool.result);
    }
    return fields.some((field) => typeof field === "string" && field.toLowerCase().includes(lowerQuery));
}

/**
 * The lower-cased byte needle that every matching turn must contain somewhere in its raw JSON lines,
 * or null when none can be derived. Visible text collapses whitespace, case-folds non-ASCII letters
 * differently from bytes, and JSON escapes quotes, backslashes and control characters, so the needle
 * is the longest run of the query that none of those can touch.
 */
export function rawNeedleOf(query: string): string | null {
    let longest = "";
    // Printable ASCII except `"` and `\`: a stringified tool input shows its JSON quotes unescaped
    // while a text shows them escaped, so neither form of a quote is safe in the needle.
    for (const piece of query.split(/[^!#-[\]-~]+/)) {
        if (piece.length > longest.length) {
            longest = piece;
        }
    }

    return longest ? longest.toLowerCase() : null;
}

/** The last turn whose first line starts at or before `offset`, or -1 before the first turn. */
function turnOfOffset(offsets: readonly number[], offset: number): number {
    let low = 0;
    let high = offsets.length - 1;
    let found = -1;
    while (low <= high) {
        const mid = (low + high) >> 1;
        if (offsets[mid] <= offset) {
            found = mid;
            low = mid + 1;
        } else {
            high = mid - 1;
        }
    }
    return found;
}

/**
 * The turns whose byte range contains `needle`, ascending. The file is read in chunks that overlap by
 * the needle's length; after a hit the scan jumps to the next turn's first line.
 */
function candidateTurns(path: string, index: TurnIndex, needle: string): number[] {
    const offsets = index.turnOffsets;
    const end = index.indexedBytes;
    const candidates: number[] = [];
    let position = offsets[0] ?? end;
    while (position < end) {
        const chunkStart = position;
        const chunkEnd = Math.min(end, chunkStart + SCAN_CHUNK_BYTES);
        // latin1 maps each byte to one character, so a string index is a byte offset; the needle is ASCII.
        const haystack = readRange(path, chunkStart, chunkEnd).toString("latin1").toLowerCase();
        let at = 0;
        let jump: number | null = null;
        for (;;) {
            const hit = haystack.indexOf(needle, at);
            if (hit === -1) {
                break;
            }

            const turn = turnOfOffset(offsets, chunkStart + hit);
            if (turn !== candidates.at(-1)) {
                candidates.push(turn);
            }

            const next = turn + 1 < offsets.length ? offsets[turn + 1] : end;
            if (next >= chunkStart + haystack.length) {
                jump = next;
                break;
            }

            at = next - chunkStart;
        }

        if (jump !== null) {
            position = jump;
        } else if (chunkStart + haystack.length >= end) {
            break;
        } else {
            position = Math.max(chunkStart + 1, chunkStart + haystack.length - needle.length + 1);
        }
    }
    return candidates;
}

function resultOf(input: { sessionId: string; matches: number[]; limit: number }): TranscriptSearchResult {
    const { sessionId, matches, limit } = input;
    return {
        sessionId,
        total: matches.length,
        turns: matches.slice(0, limit),
        truncated: matches.length > limit,
    };
}

/** The matching turn indices through the byte scan and the turn index, or null to fall back to a full parse. */
function indexedMatches(input: {
    resolved: ResolvedTranscript;
    lowerQuery: string;
    options: TurnIndexOptions;
}): number[] | null {
    const { resolved, lowerQuery, options } = input;
    const needle = rawNeedleOf(lowerQuery);
    if (!needle) {
        return null;
    }

    const index = turnIndexOfTranscript(resolved, options);
    if (!index) {
        return null;
    }

    const candidates = candidateTurns(resolved.filePath, index, needle);
    const built = new Map<number, TranscriptTurn | null>();
    const turnAt = (position: number): TranscriptTurn | null => {
        if (!built.has(position)) {
            built.set(position, indexedTurnAt(resolved.filePath, index, position));
        }

        return built.get(position) ?? null;
    };
    const matched = new Set<number>();
    for (const position of candidates) {
        const turn = turnAt(position);
        if (!turn) {
            return null;
        }

        if (turnMatches(turn, lowerQuery)) {
            matched.add(position);
        }

        if (turn.role === "user") {
            // A prompt's lines can carry the tool results of the assistant turn before it: the full
            // parse keeps waiting for them across prompts, so that earlier turn may be the one shown.
            for (let back = position - 1; back >= 0 && position - back <= MAX_RESULT_REACH; back--) {
                const earlier = turnAt(back);
                if (!earlier) {
                    return null;
                }

                if (earlier.role === "user") {
                    continue;
                }

                if (turnMatches(earlier, lowerQuery)) {
                    matched.add(back);
                }
                break;
            }
        }

        // Candidates ascend, so only the last few built turns can be asked for again.
        for (const key of built.keys()) {
            if (key < position - MAX_RESULT_REACH) {
                built.delete(key);
            }
        }
    }
    const matches = [...matched].sort((a, b) => a - b);
    logger.debug(
        {
            path: resolved.filePath,
            turns: index.turnOffsets.length,
            candidates: candidates.length,
            matches: matches.length,
        },
        "transcript search via turn index"
    );
    return matches;
}

/** Every turn of the session that shows `query`, case-insensitively; see the file header for what counts. */
export async function searchTranscript(
    resolved: ResolvedTranscript,
    opts: TranscriptSearchOptions,
    indexOptions: TurnIndexOptions = {}
): Promise<TranscriptSearchResult> {
    const limit = opts.limit ?? DEFAULT_SEARCH_LIMIT;
    const lowerQuery = opts.query.toLowerCase();
    if (!lowerQuery) {
        return resultOf({ sessionId: resolved.sessionId, matches: [], limit });
    }

    const indexed = indexedMatches({ resolved, lowerQuery, options: indexOptions });
    if (indexed) {
        return resultOf({ sessionId: resolved.sessionId, matches: indexed, limit });
    }

    const matches: number[] = [];
    for (const [position, turn] of (await allTranscriptTurns(resolved)).entries()) {
        if (turnMatches(turn, lowerQuery)) {
            matches.push(position);
        }
    }
    logger.debug({ path: resolved.filePath, matches: matches.length }, "transcript search via full parse");
    return resultOf({ sessionId: resolved.sessionId, matches, limit });
}
