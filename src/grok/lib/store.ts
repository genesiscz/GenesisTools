import { logger } from "@genesiscz/utils/logger";
import { WorkerMetaStore } from "@genesiscz/utils/worker/meta-store";
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
    /** Credential the worker runs under; absent means "subscription when ~/.grok/auth.json exists". */
    auth?: "subscription" | "api-key";
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

export class GrokSessionStore extends WorkerMetaStore<GrokSessionMeta> {
    constructor() {
        super({
            dir: sessionsDir,
            metaPath: sessionMetaPath,
            // Every field a resume depends on is checked, not just the two that
            // are obviously identifying. Blank counts as absent: `sessionId: ""`
            // passes a typeof check and then produces `--resume ""`, which the
            // CLI accepts by starting a NEW conversation under the old name
            // (review t16).
            //
            // `readOnly` and `workerHome` are SAFETY fields, which is why a
            // missing one is fatal rather than defaulted. An absent `readOnly`
            // reaches `options.readOnly ?? meta.readOnly` as undefined, which is
            // falsy, so `--tools` is omitted and a session the user started
            // read-only resumes with WRITE tools. A blank `workerHome` leaves
            // GROK_HOME unpinned and the worker loads the user's own config
            // (review t17).
            firstInvalidField,
            label: "grok session",
            title: "Grok session",
            existsMessage: (name) =>
                `Grok session '${name}' already exists. Use 'tools grok steer --name ${name}' or pick a new name.`,
            log,
        });
    }

    /** Kept for callers that predate the shared store. */
    ensureSessionsDir(): string {
        return this.ensureDir();
    }
}
