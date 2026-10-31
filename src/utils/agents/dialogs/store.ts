import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { isMissingFileError } from "@genesiscz/utils/storage/atomic-file";
import { type JsonDocument, jsonDocument } from "@genesiscz/utils/storage/locked-document";
import { genesisToolsDir } from "@genesiscz/utils/storage/root";
import { sessionIdProblem } from "../session-id";
import {
    type DialogProvider,
    type OpenQuestion,
    type OpenQuestionKind,
    type OpenQuestionSource,
    openQuestionKey,
} from "./types";

const log = logger.child({ component: "agents:dialogs" });

/**
 * One JSON file per session under `~/.genesis-tools/agents/dialogs/<provider>/<sessionId>.json`, holding every
 * question the hooks or the watcher recorded for it, open and closed. Small (a session asks tens of questions),
 * rewritten whole and atomically under `<file>.lock`, read by the hub inbox, the widget and the delivery guard.
 * Three processes write it: the hook, the hub watcher and `claude cmux send --option`.
 */
export function dialogsPath(provider: DialogProvider, sessionId: string, root?: string): string {
    const problem = sessionIdProblem(sessionId);

    if (problem !== null) {
        throw new Error(
            `a session id is one path segment of 1 to 128 characters (${problem}), got ${SafeJSON.stringify(sessionId)}`
        );
    }

    return root === undefined
        ? genesisToolsDir("agents", "dialogs", provider, `${sessionId}.json`)
        : join(root, provider, `${sessionId}.json`);
}

/** A damaged record refuses every update: rewriting the file would drop it, and it may be the open question. */
function recordsDocument(provider: DialogProvider, sessionId: string, root?: string): JsonDocument<OpenQuestion[]> {
    const path = dialogsPath(provider, sessionId, root);
    return jsonDocument<OpenQuestion[]>({
        path,
        empty: () => [],
        decode: (raw) => {
            if (!Array.isArray(raw) || !raw.every(isOpenQuestion)) {
                throw new Error(`Cannot update malformed dialog records at ${path}`);
            }

            return raw;
        },
        strictJson: true,
        onUnreadable: "refuse",
        writes: "always",
        unreadableError: (problem) => (problem.cause instanceof Error ? problem.cause : problem),
        afterWrite: (records) => syncOpenMarker(path, records),
    });
}

/**
 * `<session>.open` beside the record file while the session has an open record. The question hook runs on every
 * PostToolUse; it stats this marker before it loads the store, so a session whose questions are all answered pays one
 * `stat`, not the store, the logger and a parse. The record file alone could not say that: it keeps closed records.
 */
export function openMarkerPath(recordsPath: string): string {
    return `${recordsPath.replace(/\.json$/, "")}.open`;
}

function syncOpenMarker(recordsPath: string, records: readonly OpenQuestion[]): void {
    const marker = openMarkerPath(recordsPath);

    if (records.some((record) => record.closedAt === undefined)) {
        if (!existsSync(marker)) {
            writeFileSync(marker, "");
        }

        return;
    }

    try {
        unlinkSync(marker);
    } catch (error) {
        if (!isMissingFileError(error)) {
            throw error;
        }
    }
}

/** Written once the pass below has indexed every record file; the question hook skips the pass after that. */
export const OPEN_MARKERS_INDEXED = ".open-markers-indexed";

export function dialogsRoot(root?: string): string {
    return root ?? genesisToolsDir("agents", "dialogs");
}

/**
 * The one-time pass for record files written before the open markers existed: each file that holds an open record gets
 * its marker, so the question hook reaches it again and its close lands. Without it such a record would stay open for
 * good and keep refusing typed answers for its session. Safe to run twice (two hooks at once): it only adds markers.
 */
export function indexOpenDialogMarkers(root?: string): { indexed: number } {
    const base = dialogsRoot(root);
    let indexed = 0;

    for (const provider of listNames(base)) {
        for (const name of listNames(join(base, provider))) {
            if (!name.endsWith(".json")) {
                continue;
            }

            const path = join(base, provider, name);
            if (!existsSync(openMarkerPath(path)) && holdsOpenRecord(path)) {
                writeFileSync(openMarkerPath(path), "");
                indexed += 1;
            }
        }
    }

    mkdirSync(base, { recursive: true });
    writeFileSync(join(base, OPEN_MARKERS_INDEXED), `${new Date().toISOString()}\n`);
    log.info({ root: base, indexed }, "dialog records: indexed the open markers of files written before them");
    return { indexed };
}

function listNames(dir: string): string[] {
    try {
        return readdirSync(dir);
    } catch (error) {
        if (isMissingFileError(error) || (error instanceof Error && "code" in error && error.code === "ENOTDIR")) {
            return [];
        }

        throw error;
    }
}

/** Whether the file holds an open record. An unreadable file counts as open: the hook must keep reaching it. */
function holdsOpenRecord(path: string): boolean {
    try {
        const parsed: unknown = SafeJSON.parse(readFileSync(path, "utf8"), { strict: true });
        return (
            Array.isArray(parsed) && parsed.some((record) => isOpenQuestion(record) && record.closedAt === undefined)
        );
    } catch (error) {
        log.warn(
            { path, error },
            "dialog records: a file is unreadable; marking it open so its session stays reachable"
        );
        return true;
    }
}

/** Every well-formed record of the session; an unreadable file reads as none, and a malformed row is dropped. */
export function readSessionQuestions(provider: DialogProvider, sessionId: string, root?: string): OpenQuestion[] {
    const document = recordsDocument(provider, sessionId, root);

    try {
        return document.read({ decode: (raw) => (Array.isArray(raw) ? raw.filter(isOpenQuestion) : []) });
    } catch (error) {
        log.warn({ path: document.path, error }, "a dialog record file is unreadable; treating it as empty");
        return [];
    }
}

/** Every record of the session, or a throw when the file cannot be read or holds a malformed record. */
export function readSessionQuestionsStrict(provider: DialogProvider, sessionId: string, root?: string): OpenQuestion[] {
    return recordsDocument(provider, sessionId, root).read();
}

/** The questions of a session that nobody answered yet, newest first. */
export function openQuestions(provider: DialogProvider, sessionId: string, root?: string): OpenQuestion[] {
    return readSessionQuestions(provider, sessionId, root)
        .filter((question) => question.closedAt === undefined)
        .sort((a, b) => b.askedAt.localeCompare(a.askedAt));
}

/** Record a question. The same key again updates the record in place, so a hook and a watcher never double-post. */
export async function upsertQuestion(question: OpenQuestion, root?: string): Promise<OpenQuestion[]> {
    return recordsDocument(question.provider, question.sessionId, root).update<OpenQuestion[]>((current) => {
        const key = openQuestionKey(question);
        const previous = current.find((item) => openQuestionKey(item) === key);

        if (previous?.source === "hook" && question.source === "watcher") {
            return { keep: current };
        }

        const next = current.filter((item) => openQuestionKey(item) !== key);
        next.push(previous ? { ...previous, ...question, closedAt: question.closedAt ?? previous.closedAt } : question);
        return { write: next, result: next };
    });
}

/** Mark a question answered or withdrawn. Unknown keys are ignored: the close may arrive before the hook that asked. */
export async function closeQuestion(
    target: Pick<OpenQuestion, "provider" | "sessionId" | "toolCallId">,
    closedAt: string = new Date().toISOString(),
    root?: string,
    source?: OpenQuestion["source"]
): Promise<OpenQuestion | null> {
    const key = openQuestionKey(target);
    const closed = await closeQuestions({
        provider: target.provider,
        sessionId: target.sessionId,
        closedAt,
        root,
        which: (record) => openQuestionKey(record) === key && (source === undefined || record.source === source),
    });
    return closed[0] ?? null;
}

/**
 * Close every record of the session that `which` picks, in one locked read and one write, and return them. `which`
 * sees the records as they are under the lock, so a record another process closed or added meanwhile is judged right.
 */
export async function closeQuestions({
    provider,
    sessionId,
    closedAt = new Date().toISOString(),
    root,
    which,
}: {
    provider: DialogProvider;
    sessionId: string;
    closedAt?: string;
    root?: string;
    which: (record: OpenQuestion) => boolean;
}): Promise<OpenQuestion[]> {
    return recordsDocument(provider, sessionId, root).update<OpenQuestion[]>((current) => {
        const closed: OpenQuestion[] = [];
        const next = current.map((record) => {
            if (!which(record)) {
                return record;
            }

            const done = { ...record, closedAt };
            closed.push(done);
            return done;
        });
        return closed.length === 0 ? { keep: closed } : { write: next, result: closed };
    });
}

const QUESTION_KINDS: ReadonlySet<string> = new Set<OpenQuestionKind>(["decision", "permission", "plan"]);
const QUESTION_SOURCES: ReadonlySet<string> = new Set<OpenQuestionSource>([
    "hook",
    "watcher",
    "turn-state",
    "registry",
]);

/**
 * A stored record of the right shape, optional fields included: a `closedAt: null` would read as open-or-closed by
 * accident and an `options: "yes"` would throw in the inbox, so the strict reader refuses both as damaged.
 */
function isOpenQuestion(value: unknown): value is OpenQuestion {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return false;
    }

    const record = value as Record<string, unknown>;
    return (
        typeof record.provider === "string" &&
        typeof record.sessionId === "string" &&
        typeof record.toolCallId === "string" &&
        typeof record.kind === "string" &&
        QUESTION_KINDS.has(record.kind) &&
        typeof record.question === "string" &&
        typeof record.askedAt === "string" &&
        typeof record.source === "string" &&
        QUESTION_SOURCES.has(record.source) &&
        (record.closedAt === undefined || typeof record.closedAt === "string") &&
        (record.options === undefined ||
            (Array.isArray(record.options) && record.options.every((option) => typeof option === "string"))) &&
        (record.questionCount === undefined || typeof record.questionCount === "number")
    );
}
