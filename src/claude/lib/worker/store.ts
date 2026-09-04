import { logger } from "@genesiscz/utils/logger";
import { WorkerMetaStore } from "@genesiscz/utils/worker/meta-store";
import { workerMetaPath, workersDir } from "./paths";

const log = logger.child({ component: "claude:worker:store" });

export interface ClaudeWorkerTurnRecord {
    turn: number;
    exitCode: number | null;
    at: string;
}

export interface ClaudeWorkerMeta {
    name: string;
    /** The uuid WE chose and passed as --session-id on turn 1; every resume names it. */
    sessionId: string;
    /** The account every turn is pinned to. Required — never auto-picked. */
    account: string;
    cwd: string;
    model?: string;
    /** Turn 1 ran with --safe-mode. Every resume repeats it, or the worker's instruction and tool boundary widens silently. */
    safeMode?: boolean;
    turns: number;
    createdAt: string;
    lastTurn?: ClaudeWorkerTurnRecord;
}

function isNonEmpty(value: unknown): value is string {
    return typeof value === "string" && value.trim().length > 0;
}

/** The first field that would make a resume unsafe or impossible, or null. */
function firstInvalidField(meta: Partial<ClaudeWorkerMeta> | null | undefined): string | null {
    if (!isNonEmpty(meta?.sessionId)) {
        return "sessionId";
    }

    // A blank account would fall through to the exec autopick and bill an
    // account nobody chose, so an unreadable one refuses to resume instead.
    if (!isNonEmpty(meta?.account)) {
        return "account";
    }

    if (!isNonEmpty(meta?.cwd)) {
        return "cwd";
    }

    if (!Number.isInteger(meta?.turns) || (meta?.turns ?? -1) < 0) {
        return "turns";
    }

    return null;
}

export class ClaudeWorkerStore extends WorkerMetaStore<ClaudeWorkerMeta> {
    constructor() {
        super({
            dir: workersDir,
            metaPath: workerMetaPath,
            firstInvalidField,
            label: "claude worker",
            title: "Claude worker",
            existsMessage: (name) =>
                `Claude worker '${name}' already exists. Use 'tools claude worker steer --name ${name}' or pick a new name.`,
            log,
            // Worker metadata names the account and cwd, and the transcripts next
            // to it carry prompts and tool output. Nothing here is for other users.
            dirMode: 0o700,
            fileMode: 0o600,
        });
    }
}
