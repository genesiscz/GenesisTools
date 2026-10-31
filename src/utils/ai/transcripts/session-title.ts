/**
 * Find native sessions by the name a person gave them, without the history index.
 *
 * The index (`~/.genesis-tools/claude-history/index.db`) is shared by every process on the machine. A
 * reader that opens it can sit behind another process's refresh for minutes, which is wrong for a
 * command whose caller waits on its exit. These scans read the agents' own small files instead and stop at a
 * time budget:
 *
 * - Claude: the last `custom-title` record (`/rename`) of each transcript modified within `maxAgeDays`.
 * - Grok:   `summary.json` of each session directory: the `/rename` name (`generated_title` with
 *           `title_is_manual: true`), else the generated `session_summary`.
 * - Codex:  `session_index.jsonl` -> `thread_name`, in every home `CODEX_HOME` names (else `~/.codex`).
 */

import { readdirSync, statSync } from "node:fs";
import { harnessDriver } from "@genesiscz/utils/ai/providers/harness-index";
import { logger } from "@genesiscz/utils/logger";
import { nativeSessionRoots } from "@genesiscz/utils/providers/session-paths";
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
    /** Read only this Codex index. Default: `session_index.jsonl` in every configured Codex home. */
    codexIndexPath?: string;
    /** Claude transcripts older than this are not read. Default 14 days. */
    maxAgeDays?: number;
    /** Stop reading Claude transcripts after this long. Default 8 s. */
    budgetMs?: number;
    now?: number;
}

export function listDir(path: string): string[] {
    try {
        return readdirSync(path);
    } catch (err) {
        logger.debug({ err, path }, "[session-title] could not list a directory");
        return [];
    }
}

export function mtimeOf(path: string): number {
    try {
        return statSync(path).mtimeMs;
    } catch (err) {
        logger.debug({ err, path }, "[session-title] could not stat a transcript");
        return 0;
    }
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

/** What a title search hands each harness's locator (`TranscriptLocator.titledSessions`). */
export interface TitleSearch {
    options: FindByTitleOptions;
    roots: string[];
    now: number;
}

export function findSessionsByTitle(query: string, options: FindByTitleOptions): TitledSession[] {
    const now = options.now ?? Date.now();
    const roots = options.roots ?? nativeSessionRoots(options.provider);
    return rankByTitle(query, harnessDriver(options.provider).parts.locate.titledSessions({ options, roots, now }));
}
