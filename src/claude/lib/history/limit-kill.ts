import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { PROJECTS_DIR } from "@genesiscz/utils/claude/projects";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";

/**
 * Find the session in this directory that DIED on a rate limit, so a relaunch
 * under another account can carry on instead of starting cold.
 */

/** Only the tail of a transcript is read — they run to megabytes. */
const TAIL_BYTES = 128 * 1024;

/** Enough of the head to see the marker that brands a transcript an agent's. */
const HEAD_BYTES = 8 * 1024;

/** Sessions older than this are never offered — you've moved on. */
const DEFAULT_MAX_AGE_MS = 12 * 60 * 60 * 1000;

export interface SessionSummary {
    /** Full session id (the `claude --resume` argument). */
    id: string;
    mtimeMs: number;
    /** Last user prompt, when the transcript recorded one. */
    lastPrompt: string | null;
    /** The rate-limit message the session died on, when it died on one. */
    limitStop: string | null;
    /** Set when the session was working in a subdirectory (a worktree, a package). */
    subdir: string | null;
}

/**
 * Claude Code's project-directory name: every non-alphanumeric character in
 * the absolute cwd becomes a dash (`/Users/me/Work/app` →
 * `-Users-me-Work-app`). The mapping is lossy — `/a/b-c` and `/a/b/c` collide
 * — so every transcript's own `cwd` field is verified before it is offered.
 *
 * `encodedProjectDir` in utils/claude/projects only rewrites path separators,
 * which is not the same transform: a cwd holding a dot or an underscore would
 * resolve to a directory that does not exist.
 */
export function projectSlug(cwd: string): string {
    return cwd.replace(/[^a-zA-Z0-9]/g, "-");
}

interface TranscriptRecord {
    type?: string;
    cwd?: string;
    sessionId?: string;
    isSidechain?: boolean;
    lastPrompt?: string;
    isApiErrorMessage?: boolean;
    error?: string;
    apiErrorStatus?: number;
    message?: { role?: string; model?: string; content?: unknown };
}

/** Parse a JSONL slice into records, dropping a leading partial line. */
function parseRecords(text: string, partialFirstLine: boolean): TranscriptRecord[] {
    const lines = text.split("\n");

    // A mid-file offset almost certainly lands inside a record.
    if (partialFirstLine) {
        lines.shift();
    }

    const records: TranscriptRecord[] = [];

    for (const line of lines) {
        if (!line.trim()) {
            continue;
        }

        try {
            records.push(SafeJSON.parse(line, { strict: true }) as TranscriptRecord);
        } catch {
            // Torn last write or a non-JSON line — the rest of the tail still counts.
        }
    }

    return records;
}

/** The last TAIL_BYTES of a transcript as whole records, oldest first. */
async function readTailRecords(path: string, size: number): Promise<TranscriptRecord[]> {
    const start = Math.max(0, size - TAIL_BYTES);
    return parseRecords(await Bun.file(path).slice(start).text(), start > 0);
}

/**
 * Subagent sessions (Task/Agent tool) get their own transcript in the SAME
 * project directory, branded `agent-setting` in their opening records — and a
 * background agent keeps writing long after the session that spawned it died,
 * so without this they both crowd the picker and steal the "newest" slot the
 * prompt is gated on. The marker only appears at the head, hence the extra read.
 */
async function isAgentTranscript(path: string): Promise<boolean> {
    const head = parseRecords(await Bun.file(path).slice(0, HEAD_BYTES).text(), false);
    return head.some((record) => record.type === "agent-setting" || record.isSidechain === true);
}

/** A genuine model turn — not a synthetic notice, not an API error. */
function isModelTurn(record: TranscriptRecord): boolean {
    return record.type === "assistant" && !record.isApiErrorMessage && record.message?.model !== "<synthetic>";
}

/** First text block of an assistant/user message record, if any. */
function messageText(record: TranscriptRecord): string | null {
    const content = record.message?.content;

    if (typeof content === "string") {
        return content;
    }

    if (!Array.isArray(content)) {
        return null;
    }

    for (const block of content) {
        if (block && typeof block === "object" && (block as { type?: string }).type === "text") {
            const text = (block as { text?: unknown }).text;

            if (typeof text === "string") {
                return text;
            }
        }
    }

    return null;
}

/**
 * True when this record is the API telling the session it ran out of limit —
 * a 429 / `rate_limit` error message ("You've reached your Fable 5 limit.").
 */
function isLimitRecord(record: TranscriptRecord): boolean {
    if (!record.isApiErrorMessage) {
        return false;
    }

    return (
        record.error === "rate_limit" || record.apiErrorStatus === 429 || /\blimit\b/i.test(messageText(record) ?? "")
    );
}

/**
 * The rate-limit record the session ENDED on, if it did. Walking back from the
 * end and stopping at the first real model turn is what makes this robust: a
 * session that hits its limit keeps logging afterwards (agents stopping, the
 * exit interrupt, task notifications), so "within the last N records" misses
 * it — but nothing that follows a 429 is a model turn unless work resumed.
 */
function endedOnLimit(records: TranscriptRecord[]): TranscriptRecord | null {
    for (let i = records.length - 1; i >= 0; i--) {
        if (isLimitRecord(records[i])) {
            return records[i];
        }

        if (isModelTurn(records[i])) {
            return null;
        }
    }

    return null;
}

function summarize(id: string, mtimeMs: number, records: TranscriptRecord[], cwd: string): SessionSummary | null {
    // Slug collisions are possible (the mapping is lossy) — trust the
    // transcript's own cwd. A session that moved into a subdirectory (a
    // worktree, a package) still belongs to this project and stays eligible;
    // a colliding sibling path like `/me/Work-app` vs `/me/Work/app` does not.
    const own = records.filter((r) => typeof r.cwd === "string").map((r) => r.cwd as string);
    const inside = own.filter((c) => c === cwd || c.startsWith(`${cwd}/`));

    if (own.length > 0 && inside.length === 0) {
        return null;
    }

    const last = inside.at(-1);

    let lastPrompt: string | null = null;

    for (const record of records) {
        if (record.type === "last-prompt" && typeof record.lastPrompt === "string") {
            lastPrompt = record.lastPrompt;
        } else if (record.type === "user" && !record.isApiErrorMessage) {
            const text = messageText(record);

            if (text) {
                lastPrompt = text;
            }
        }
    }

    const limit = endedOnLimit(records);

    return {
        id,
        mtimeMs,
        lastPrompt: lastPrompt?.replace(/\s+/g, " ").trim() || null,
        limitStop: limit ? (messageText(limit) ?? "Rate limit reached") : null,
        subdir: last && last !== cwd ? last.slice(cwd.length + 1) : null,
    };
}

export interface FindOptions {
    maxAgeMs?: number;
    /** How many recent sessions to summarize. */
    limit?: number;
    /** Override the transcript root (tests). */
    root?: string;
}

/**
 * Recent resumable sessions for `cwd`, newest first. Reads only each
 * transcript's tail, so it stays instant even on megabyte-sized histories;
 * any unreadable transcript is skipped rather than failing the launch.
 */
export async function findRecentSessions(cwd: string, opts: FindOptions = {}): Promise<SessionSummary[]> {
    const maxAgeMs = opts.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
    const limit = opts.limit ?? 3;
    const dir = join(opts.root ?? PROJECTS_DIR, projectSlug(cwd));

    let entries: string[];

    try {
        entries = await readdir(dir);
    } catch (err) {
        // No transcripts for this directory yet — the common case, not an error.
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
            logger.debug({ err, dir }, "[limit-kill] session scan failed");
        }

        return [];
    }

    const cutoff = Date.now() - maxAgeMs;
    const candidates: { path: string; id: string; mtimeMs: number; size: number }[] = [];

    for (const entry of entries) {
        if (!entry.endsWith(".jsonl")) {
            continue;
        }

        const path = join(dir, entry);

        try {
            const info = await stat(path);

            if (info.isFile() && info.mtimeMs >= cutoff && info.size > 0) {
                candidates.push({ path, id: entry.slice(0, -".jsonl".length), mtimeMs: info.mtimeMs, size: info.size });
            }
        } catch (err) {
            logger.debug({ err, path }, "[limit-kill] stat failed");
        }
    }

    candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);

    const summaries: SessionSummary[] = [];

    for (const candidate of candidates) {
        if (summaries.length >= limit) {
            break;
        }

        try {
            // Cheap head read first: most of the noise in a busy project
            // directory is subagent transcripts, and they need no tail read.
            if (await isAgentTranscript(candidate.path)) {
                continue;
            }

            const records = await readTailRecords(candidate.path, candidate.size);
            const summary = summarize(candidate.id, candidate.mtimeMs, records, cwd);

            if (summary) {
                summaries.push(summary);
            }
        } catch (err) {
            logger.debug({ err, path: candidate.path }, "[limit-kill] reading transcript failed");
        }
    }

    return summaries;
}
