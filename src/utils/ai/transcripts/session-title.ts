/**
 * Find native sessions by the name a person gave them, without the history index.
 *
 * The index (`~/.genesis-tools/claude-history/index.db`) is shared by every process on the machine. A
 * reader that opens it can sit behind another process's refresh for minutes, which is wrong for a
 * command whose caller waits on its exit. These scans read the agents' own small files instead and stop at a
 * time budget:
 *
 * - Claude: the last `custom-title` record (`/rename`) of each transcript modified within `maxAgeDays`.
 * - Grok:   `summary.json` -> `session_summary` of each session directory.
 * - Codex:  `session_index.jsonl` -> `thread_name`.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { nativeSessionRoots } from "@genesiscz/utils/providers/session-paths";
import { scanFileMatches } from "./file-scan";
import type { TurnProvider } from "./turn-state";

export interface TitledSession {
    sessionId: string;
    title: string;
    /** Epoch ms of the transcript's last write. 0 when unknown. */
    mtime: number;
    /** What `resolveTranscript` should be given: the transcript path when known, else the session id. */
    locator: string;
}

export interface FindByTitleOptions {
    provider: TurnProvider;
    /** Test seams: where the agents keep their files. Default: the real homes. */
    roots?: string[];
    codexIndexPath?: string;
    /** Claude transcripts older than this are not read. Default 14 days. */
    maxAgeDays?: number;
    /** Stop reading Claude transcripts after this long. Default 8 s. */
    budgetMs?: number;
    now?: number;
}

const CUSTOM_TITLE = /"type":"custom-title","customTitle":"((?:[^"\\]|\\.)*)"/g;

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function listDir(path: string): string[] {
    try {
        return readdirSync(path);
    } catch (err) {
        logger.debug({ err, path }, "[session-title] could not list a directory");
        return [];
    }
}

function mtimeOf(path: string): number {
    try {
        return statSync(path).mtimeMs;
    } catch (err) {
        logger.debug({ err, path }, "[session-title] could not stat a transcript");
        return 0;
    }
}

/** The last `/rename` title in a Claude transcript's text, or null. */
export function lastClaudeTitle(text: string): string | null {
    let last: string | null = null;

    for (const match of text.matchAll(CUSTOM_TITLE)) {
        last = match[1];
    }

    if (last === null) {
        return null;
    }

    try {
        const decoded = SafeJSON.parse(`"${last}"`, { strict: true });

        return typeof decoded === "string" ? decoded : last;
    } catch (err) {
        logger.debug({ err }, "[session-title] title escape unreadable; using it raw");
        return last;
    }
}

/** Bytes kept after each `custom-title` match: a title longer than this is not read. */
const TITLE_WINDOW = 4096;

/** The last `/rename` title of a transcript, streamed: a 200 MB transcript is never one string. */
function lastClaudeTitleIn(path: string): string | null {
    const found: { last: Buffer | null } = { last: null };
    scanFileMatches(path, '"type":"custom-title","customTitle":"', TITLE_WINDOW, (slice) => {
        found.last = Buffer.from(slice);
    });

    return found.last === null ? null : lastClaudeTitle(found.last.toString("utf8"));
}

function claudeSessions({
    roots,
    maxAgeDays,
    budgetMs,
    now,
}: Required<Pick<FindByTitleOptions, "roots" | "maxAgeDays" | "budgetMs" | "now">>): TitledSession[] {
    const cutoff = now - maxAgeDays * 86_400_000;
    const files: { path: string; mtime: number }[] = [];

    for (const root of roots) {
        for (const project of listDir(root)) {
            for (const entry of listDir(join(root, project))) {
                if (!entry.endsWith(".jsonl")) {
                    continue;
                }

                const path = join(root, project, entry);
                const mtime = mtimeOf(path);

                if (mtime >= cutoff) {
                    files.push({ path, mtime });
                }
            }
        }
    }

    files.sort((a, b) => b.mtime - a.mtime);
    const found: TitledSession[] = [];
    const deadline = Date.now() + budgetMs;

    for (const file of files) {
        if (Date.now() > deadline) {
            logger.warn(
                { read: found.length, total: files.length },
                "[session-title] time budget spent; the title scan is partial"
            );
            break;
        }

        try {
            const title = lastClaudeTitleIn(file.path);

            if (title) {
                found.push({
                    sessionId:
                        file.path
                            .split("/")
                            .at(-1)
                            ?.replace(/\.jsonl$/, "") ?? file.path,
                    title,
                    mtime: file.mtime,
                    locator: file.path,
                });
            }
        } catch (err) {
            logger.debug({ err, path: file.path }, "[session-title] could not read a transcript");
        }
    }

    return found;
}

function grokSessions(roots: string[]): TitledSession[] {
    const found: TitledSession[] = [];

    for (const root of roots) {
        for (const cwdDir of listDir(root)) {
            for (const id of listDir(join(root, cwdDir))) {
                const dir = join(root, cwdDir, id);
                const summaryPath = join(dir, "summary.json");
                const updates = join(dir, "updates.jsonl");

                if (!existsSync(summaryPath) || !existsSync(updates)) {
                    continue;
                }

                try {
                    const summary: unknown = SafeJSON.parse(readFileSync(summaryPath, "utf8"), { strict: true });
                    const title =
                        isRecord(summary) && typeof summary.session_summary === "string"
                            ? summary.session_summary
                            : null;

                    if (title) {
                        found.push({ sessionId: id, title, mtime: mtimeOf(updates), locator: updates });
                    }
                } catch (err) {
                    logger.debug({ err, summaryPath }, "[session-title] could not read a Grok summary");
                }
            }
        }
    }

    return found;
}

function codexSessions(indexPath: string): TitledSession[] {
    if (!existsSync(indexPath)) {
        return [];
    }

    // Codex appends a line per rename, in write order: the last line of an id is its current title.
    const found = new Map<string, TitledSession>();

    for (const line of readFileSync(indexPath, "utf8").split("\n")) {
        try {
            const record: unknown = line.trim() ? SafeJSON.parse(line, { strict: true }) : null;

            if (isRecord(record) && typeof record.id === "string" && typeof record.thread_name === "string") {
                found.delete(record.id);
                found.set(record.id, {
                    sessionId: record.id,
                    title: record.thread_name,
                    mtime: Date.parse(String(record.updated_at)) || 0,
                    locator: record.id,
                });
            }
        } catch (err) {
            logger.debug({ err }, "[session-title] skipped an unreadable Codex index line");
        }
    }

    return [...found.values()];
}

/**
 * Sessions whose title equals the query (case-insensitive), else contains it. Only the best tier is
 * returned, newest first, so one exact match is never buried by longer titles that merely include it.
 */
export function rankByTitle(query: string, sessions: readonly TitledSession[]): TitledSession[] {
    const needle = query.trim().toLowerCase();

    if (!needle) {
        return [];
    }

    const exact = sessions.filter((session) => session.title.trim().toLowerCase() === needle);
    const tier = exact.length > 0 ? exact : sessions.filter((session) => session.title.toLowerCase().includes(needle));

    return [...tier].sort((a, b) => b.mtime - a.mtime);
}

export function findSessionsByTitle(query: string, options: FindByTitleOptions): TitledSession[] {
    const now = options.now ?? Date.now();
    const roots = options.roots ?? nativeSessionRoots(options.provider);
    let sessions: TitledSession[];

    if (options.provider === "claude") {
        sessions = claudeSessions({
            roots,
            maxAgeDays: options.maxAgeDays ?? 14,
            budgetMs: options.budgetMs ?? 8000,
            now,
        });
    } else if (options.provider === "grok") {
        sessions = grokSessions(roots);
    } else {
        sessions = codexSessions(options.codexIndexPath ?? join(homedir(), ".codex", "session_index.jsonl"));
    }

    return rankByTitle(query, sessions);
}
