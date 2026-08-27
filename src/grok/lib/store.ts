import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, writeSync } from "node:fs";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { atomicWriteFileSync } from "@genesiscz/utils/storage/storage";
import { sessionMetaPath, sessionsDir } from "./paths";

const log = logger.child({ component: "grok:store" });

export interface GrokTurnRecord {
    turn: number;
    ended: boolean;
    exitCode: number | null;
    at: string;
}

export interface GrokSessionMeta {
    name: string;
    sessionId: string;
    cwd: string;
    workerHome: string;
    model?: string;
    readOnly: boolean;
    turns: number;
    createdAt: string;
    lastTurn?: GrokTurnRecord;
}

function isNonEmpty(value: unknown): value is string {
    return typeof value === "string" && value.trim().length > 0;
}

export class GrokSessionStore {
    ensureSessionsDir(): string {
        const path = sessionsDir();
        mkdirSync(path, { recursive: true });
        return path;
    }

    readMeta(name: string): GrokSessionMeta | null {
        const path = sessionMetaPath(name);
        if (!existsSync(path)) {
            return null;
        }

        try {
            const parsed = SafeJSON.parse(readFileSync(path, "utf8"), { strict: true }) as Partial<GrokSessionMeta>;

            // The cast used to be unchecked, so a record written by an older
            // build (or a half-written file) reached the sessions table with an
            // absent id and rendered a blank cell. A record with no sessionId
            // also cannot be resumed, so treating it as unreadable is honest.
            // Blank counts as absent. A `sessionId: ""` passes a typeof check
            // and then produces `--resume ""`, which the CLI accepts and starts
            // a NEW conversation under the old name — the session looks resumed
            // and has silently lost its history (PR #330 review t16).
            if (!isNonEmpty(parsed?.sessionId) || !isNonEmpty(parsed?.cwd)) {
                log.warn({ path, name }, "grok session metadata has a blank sessionId or cwd; ignoring it");
                return null;
            }

            return parsed as GrokSessionMeta;
        } catch (err) {
            log.warn({ err, path, name }, "failed to read grok session metadata");
            return null;
        }
    }

    writeMeta(meta: GrokSessionMeta): void {
        this.ensureSessionsDir();
        atomicWriteFileSync(sessionMetaPath(meta.name), SafeJSON.stringify(meta, null, 2));
    }

    /**
     * Claim a session name, or fail. O_EXCL makes the check and the write one
     * syscall: a read-then-write pair lets two concurrent `run` calls both see
     * "free", both start turn 1, and the second overwrite the first's record.
     */
    createMeta(meta: GrokSessionMeta): void {
        this.ensureSessionsDir();
        let fd: number;

        try {
            fd = openSync(sessionMetaPath(meta.name), "wx");
        } catch (err) {
            if ((err as NodeJS.ErrnoException).code === "EEXIST") {
                throw new Error(
                    `Grok session '${meta.name}' already exists. Use 'tools grok steer --name ${meta.name}' or pick a new name.`
                );
            }

            throw err;
        }

        try {
            writeSync(fd, SafeJSON.stringify(meta, null, 2));
        } catch (err) {
            // The O_EXCL open already claimed the name. Leaving a zero-byte file
            // behind makes that claim permanent: every later `run` gets EEXIST
            // and every `readMeta` gets unparseable JSON, so the name is dead
            // until someone deletes it by hand (PR #330 review t13).
            closeSync(fd);
            rmSync(sessionMetaPath(meta.name), { force: true });
            throw err;
        }

        closeSync(fd);
    }

    updateMeta(name: string, update: Partial<GrokSessionMeta>): GrokSessionMeta {
        const current = this.readMeta(name);
        if (!current) {
            throw new Error(`Grok session not found: ${name}`);
        }

        const next = { ...current, ...update };
        this.writeMeta(next);
        return next;
    }

    listNames(): string[] {
        const dir = this.ensureSessionsDir();
        return readdirSync(dir)
            .filter((file) => file.endsWith(".meta.json"))
            .map((file) => file.slice(0, -".meta.json".length))
            .sort();
    }
}
