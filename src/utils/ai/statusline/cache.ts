import {
    existsSync,
    mkdirSync,
    readdirSync,
    readFileSync,
    renameSync,
    statSync,
    unlinkSync,
    writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { aiDataDir } from "@genesiscz/utils/ai/config/paths";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";

/**
 * Small JSON files the statusline reuses between renders, so a render costs a handful of
 * `stat` calls instead of a `git status`, a `ps` walk and a transcript scan every six seconds.
 *
 * One file per session (`session-<id>.json`) and one per working directory
 * (`cwd-<hash>.json`). Every entry carries its own `at` stamp or the mtime of the source it was
 * derived from, so the reader decides freshness; the cache itself is dumb. Sessions older than
 * `SESSION_MAX_AGE_MS` are pruned when a new session file is created, which is the cheap moment
 * to do it: the old shell script kept 2 102 state files (36 MB) because nothing ever pruned.
 */
export interface SessionCacheEntry {
    /** Account name, or "" when the walk found none; `accountAt` says when that was decided. */
    account?: string;
    accountAt?: number;
    /** Token count seen by the previous render, for the delta segment. */
    prevTokens?: number;
    prevAt?: number;
    sessionName?: string | null;
    /** mtime of the sessions index the name was read from. */
    sessionNameIndexMtime?: number;
    columns?: number;
    columnsAt?: number;
}

export interface CwdCacheEntry {
    branch: string | null;
    dirty: number;
    at: number;
    headMtime: number;
    indexMtime: number;
    graftLine?: string;
    graftAt?: number;
}

const SESSION_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export class StatuslineCache {
    constructor(private readonly dir = aiDataDir("statusline", "cache")) {}

    session(sessionId: string): SessionCacheEntry {
        return this.read<SessionCacheEntry>(this.sessionFile(sessionId)) ?? {};
    }

    writeSession(sessionId: string, patch: Partial<SessionCacheEntry>): void {
        const path = this.sessionFile(sessionId);
        const isNew = !existsSync(path);
        this.write(path, { ...this.session(sessionId), ...patch });

        if (isNew) {
            this.pruneSessions();
        }
    }

    cwd(cwd: string): CwdCacheEntry | null {
        return this.read<CwdCacheEntry>(this.cwdFile(cwd));
    }

    writeCwd(cwd: string, entry: CwdCacheEntry): void {
        this.write(this.cwdFile(cwd), entry);
    }

    /** A named scalar cache keyed by a source file's mtime, e.g. the host's autocompact flag. */
    keyed<T>(name: string, sourceMtime: number): T | null {
        const entry = this.read<{ mtime: number; value: T }>(join(this.dir, `${name}.json`));

        return entry && entry.mtime === sourceMtime ? entry.value : null;
    }

    writeKeyed<T>(name: string, sourceMtime: number, value: T): void {
        this.write(join(this.dir, `${name}.json`), { mtime: sourceMtime, value });
    }

    private sessionFile(sessionId: string): string {
        return join(this.dir, `session-${sessionId.replace(/[^\w.-]+/g, "_")}.json`);
    }

    private cwdFile(cwd: string): string {
        return join(this.dir, `cwd-${Bun.hash(cwd).toString(16)}.json`);
    }

    private read<T>(path: string): T | null {
        if (!existsSync(path)) {
            return null;
        }

        try {
            return SafeJSON.parse(readFileSync(path, "utf8"), { strict: true }) as T;
        } catch (error) {
            logger.debug({ err: error, path }, "statusline cache entry unreadable, ignoring");
            return null;
        }
    }

    private write(path: string, data: unknown): void {
        mkdirSync(this.dir, { recursive: true });
        const tmp = `${path}.${process.pid}.tmp`;
        writeFileSync(tmp, SafeJSON.stringify(data, { strict: true }));
        renameSync(tmp, path);
    }

    private pruneSessions(): void {
        const cutoff = Date.now() - SESSION_MAX_AGE_MS;
        let removed = 0;

        try {
            for (const name of readdirSync(this.dir)) {
                if (!name.startsWith("session-")) {
                    continue;
                }

                const path = join(this.dir, name);

                if (statSync(path).mtimeMs < cutoff) {
                    unlinkSync(path);
                    removed++;
                }
            }
        } catch (error) {
            logger.debug({ err: error, dir: this.dir }, "statusline cache prune failed");
        }

        if (removed > 0) {
            logger.debug({ removed, dir: this.dir }, "statusline cache pruned old sessions");
        }
    }
}
