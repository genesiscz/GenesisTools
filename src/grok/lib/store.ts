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
    /** The agents-bus swarm of the session that started this worker, if any. */
    rendezvousSession?: string;
    lastTurn?: GrokTurnRecord;
}

function isNonEmpty(value: unknown): value is string {
    return typeof value === "string" && value.trim().length > 0;
}

/** The first field that would make a resume unsafe or impossible, or null. */
function firstInvalidField(meta: Partial<GrokSessionMeta> | null | undefined): string | null {
    if (!isNonEmpty(meta?.sessionId)) {
        return "sessionId";
    }

    if (!isNonEmpty(meta?.cwd)) {
        return "cwd";
    }

    if (!isNonEmpty(meta?.workerHome)) {
        return "workerHome";
    }

    if (typeof meta?.readOnly !== "boolean") {
        return "readOnly";
    }

    if (!Number.isInteger(meta?.turns) || (meta?.turns ?? -1) < 0) {
        return "turns";
    }

    return null;
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
            // Every field a resume depends on is checked, not just the two that
            // are obviously identifying.
            //
            // Blank counts as absent: `sessionId: ""` passes a typeof check and
            // then produces `--resume ""`, which the CLI accepts by starting a
            // NEW conversation under the old name (review t16).
            //
            // `readOnly` and `workerHome` are SAFETY fields, which is why a
            // missing one is fatal rather than defaulted. An absent `readOnly`
            // reaches `options.readOnly ?? meta.readOnly` as undefined, which is
            // falsy, so `--tools` is omitted and a session the user started
            // read-only resumes with WRITE tools. A blank `workerHome` leaves
            // GROK_HOME unpinned and the worker loads the user's own config
            // (review t17). Defaulting either one would guess at a safety
            // posture; refusing to resume makes the damage visible instead.
            const invalid = firstInvalidField(parsed);
            if (invalid) {
                log.warn({ path, name, field: invalid }, "grok session metadata cannot be safely resumed; ignoring it");
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
        // Reads, never creates. `sessions` is a diagnostic, and this used to
        // mkdir the store just because someone looked at it (PR #330 review).
        const dir = sessionsDir();

        if (!existsSync(dir)) {
            return [];
        }

        return readdirSync(dir)
            .filter((file) => file.endsWith(".meta.json"))
            .map((file) => file.slice(0, -".meta.json".length))
            .sort();
    }
}
