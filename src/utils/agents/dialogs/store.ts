import { join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
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
    });
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
    return recordsDocument(target.provider, target.sessionId, root).update<OpenQuestion | null>((current) => {
        const key = openQuestionKey(target);
        const found = current.find((item) => openQuestionKey(item) === key);

        if (!found || (source !== undefined && found.source !== source)) {
            return { keep: null };
        }

        const closed = { ...found, closedAt };
        return { write: current.map((item) => (openQuestionKey(item) === key ? closed : item)), result: closed };
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
