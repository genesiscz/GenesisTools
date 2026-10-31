import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { withFileLock } from "@genesiscz/utils/storage/file-lock";
import { genesisToolsDir } from "@genesiscz/utils/storage/root";
import { type DialogProvider, type OpenQuestion, openQuestionKey } from "./types";

const log = logger.child({ component: "agents:dialogs" });

const SAFE_SESSION_ID = /^[A-Za-z0-9._-]{1,128}$/;

/**
 * One JSON file per session under `~/.genesis-tools/agents/dialogs/<provider>/<sessionId>.json`, holding every
 * question the hooks or the watcher recorded for it, open and closed. Small (a session asks tens of questions),
 * rewritten whole and atomically, read by the hub inbox, the widget and the delivery guard.
 */
export function dialogsPath(provider: DialogProvider, sessionId: string, root?: string): string {
    if (!SAFE_SESSION_ID.test(sessionId)) {
        throw new Error(`a session id is 1 to 128 characters of [A-Za-z0-9._-], got ${SafeJSON.stringify(sessionId)}`);
    }

    return root === undefined
        ? genesisToolsDir("agents", "dialogs", provider, `${sessionId}.json`)
        : join(root, provider, `${sessionId}.json`);
}

export function readSessionQuestions(provider: DialogProvider, sessionId: string, root?: string): OpenQuestion[] {
    const path = dialogsPath(provider, sessionId, root);

    if (!existsSync(path)) {
        return [];
    }

    try {
        const parsed: unknown = SafeJSON.parse(readFileSync(path, "utf8"), { strict: true });
        return Array.isArray(parsed) ? parsed.filter(isOpenQuestion) : [];
    } catch (error) {
        log.warn({ path, error }, "a dialog record file is unreadable; treating it as empty");
        return [];
    }
}

export function readSessionQuestionsStrict(provider: DialogProvider, sessionId: string, root?: string): OpenQuestion[] {
    const path = dialogsPath(provider, sessionId, root);
    let text: string;
    try {
        text = readFileSync(path, "utf8");
    } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") {
            return [];
        }
        throw error;
    }
    const parsed: unknown = SafeJSON.parse(text, { strict: true });
    if (!Array.isArray(parsed) || !parsed.every(isOpenQuestion)) {
        throw new Error(`Cannot update malformed dialog records at ${path}`);
    }
    return parsed;
}

/** The questions of a session that nobody answered yet, newest first. */
export function openQuestions(provider: DialogProvider, sessionId: string, root?: string): OpenQuestion[] {
    return readSessionQuestions(provider, sessionId, root)
        .filter((question) => question.closedAt === undefined)
        .sort((a, b) => b.askedAt.localeCompare(a.askedAt));
}

/** Record a question. The same key again updates the record in place, so a hook and a watcher never double-post. */
export async function upsertQuestion(question: OpenQuestion, root?: string): Promise<OpenQuestion[]> {
    return withFileLock(`${dialogsPath(question.provider, question.sessionId, root)}.lock`, async () => {
        const key = openQuestionKey(question);
        const current = readSessionQuestionsStrict(question.provider, question.sessionId, root);
        const next = current.filter((item) => openQuestionKey(item) !== key);
        const previous = current.find((item) => openQuestionKey(item) === key);
        if (previous?.source === "hook" && question.source === "watcher") {
            return current;
        }

        next.push(previous ? { ...previous, ...question, closedAt: question.closedAt ?? previous.closedAt } : question);
        writeSessionQuestions(question.provider, question.sessionId, next, root);
        return next;
    });
}

/** Mark a question answered or withdrawn. Unknown keys are ignored: the close may arrive before the hook that asked. */
export async function closeQuestion(
    target: Pick<OpenQuestion, "provider" | "sessionId" | "toolCallId">,
    closedAt: string = new Date().toISOString(),
    root?: string,
    source?: OpenQuestion["source"]
): Promise<OpenQuestion | null> {
    return withFileLock(`${dialogsPath(target.provider, target.sessionId, root)}.lock`, async () => {
        const key = openQuestionKey(target);
        const current = readSessionQuestionsStrict(target.provider, target.sessionId, root);
        const found = current.find((item) => openQuestionKey(item) === key);

        if (!found || (source !== undefined && found.source !== source)) {
            return null;
        }

        const closed = { ...found, closedAt };
        writeSessionQuestions(
            target.provider,
            target.sessionId,
            current.map((item) => (openQuestionKey(item) === key ? closed : item)),
            root
        );
        return closed;
    });
}

function writeSessionQuestions(
    provider: DialogProvider,
    sessionId: string,
    questions: OpenQuestion[],
    root?: string
): void {
    const path = dialogsPath(provider, sessionId, root);
    mkdirSync(dirname(path), { recursive: true });
    const temp = `${path}.tmp.${process.pid}`;
    writeFileSync(temp, SafeJSON.stringify(questions));
    renameSync(temp, path);
}

function isOpenQuestion(value: unknown): value is OpenQuestion {
    if (typeof value !== "object" || value === null) {
        return false;
    }

    const record = value as Record<string, unknown>;
    return (
        typeof record.provider === "string" &&
        typeof record.sessionId === "string" &&
        typeof record.toolCallId === "string" &&
        typeof record.kind === "string" &&
        typeof record.question === "string" &&
        typeof record.askedAt === "string" &&
        typeof record.source === "string"
    );
}
