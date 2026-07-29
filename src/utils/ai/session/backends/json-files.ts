import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import type { MessageRecord, NewMessage, NewSession, SessionBackend, SessionRecord } from "../types";

/**
 * ask's on-disk chat sessions, adopted rather than converted.
 *
 * One JSONL file per session under `dir`, one `SessionEntry` per line — exactly
 * what `ChatSessionManager` has been writing to ~/.genesis-tools/ai-chat/sessions.
 * Every field of every entry type survives a round-trip through `MessageRecord`
 * (that is what the widened `MessageRole` and the nested `meta` are for), so a
 * session written before this phase reads back byte-identical afterwards.
 *
 * SINGLE NAMESPACE. The format has nowhere to put an owner or a title: the file
 * name IS the id and the title, and `owner` is the directory. `byTitle(owner, …)`
 * therefore ignores `owner` and `create()` cannot persist session-level `meta`.
 * A tool that needs either wants the sqlite backend.
 */

interface EntryBase {
    timestamp: string;
}

interface ConfigEntry extends EntryBase {
    type: "config";
    provider: string;
    model: string;
    systemPrompt?: string;
}

interface UserEntry extends EntryBase {
    type: "user";
    content: string;
    metadata?: Record<string, unknown>;
}

interface AssistantEntry extends EntryBase {
    type: "assistant";
    content: string;
    thinking?: string;
    usage?: unknown;
    cost?: number;
    toolCalls?: unknown[];
}

interface SystemEntry extends EntryBase {
    type: "system";
    content: string;
}

interface ContextEntry extends EntryBase {
    type: "context";
    content: string;
    label?: string;
    metadata?: Record<string, unknown>;
}

/**
 * Structurally identical to `SessionEntry` in src/ask/lib/types.ts, redeclared
 * because src/utils may not import tool code (scripts/ci/check-package-boundaries.ts
 * rule 1). ask keeps its own copy for its UI; this one describes the file format.
 */
type DiskEntry = ConfigEntry | UserEntry | AssistantEntry | SystemEntry | ContextEntry;

export interface JsonFilesBackendOptions {
    /** Directory of `<id>.jsonl` files. Created if missing. */
    dir: string;
}

const VALID_ID = /^[A-Za-z0-9_-]+$/;

export function createJsonFilesBackend(options: JsonFilesBackendOptions): SessionBackend {
    const { log } = logger.scoped("ai-session");
    const dir = resolve(options.dir);

    if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
    }

    function filePath(id: string): string {
        if (!VALID_ID.test(id)) {
            throw new Error(`Invalid session id "${id}" — only alphanumeric, hyphens, and underscores allowed`);
        }

        return resolve(dir, `${id}.jsonl`);
    }

    function readEntries(id: string): DiskEntry[] {
        const path = filePath(id);

        if (!existsSync(path)) {
            return [];
        }

        const entries: DiskEntry[] = [];

        for (const line of readFileSync(path, "utf8").split("\n")) {
            const trimmed = line.trim();

            if (!trimmed) {
                continue;
            }

            try {
                entries.push(SafeJSON.parse(trimmed, { strict: true }) as DiskEntry);
            } catch (error) {
                log.debug({ session: id, err: error }, "session line unreadable — skipped");
            }
        }

        return entries;
    }

    function toRecord(id: string, entry: DiskEntry, index: number): MessageRecord {
        return {
            id: String(index),
            sessionId: id,
            role: entry.type,
            content: "content" in entry ? entry.content : "",
            at: Date.parse(entry.timestamp),
            meta: entryMeta(entry),
        };
    }

    function sessionRecord(id: string, owner: string, entries: DiskEntry[]): SessionRecord {
        const path = filePath(id);
        const mtime = existsSync(path) ? statSync(path).mtimeMs : Date.now();
        const first = entries[0];
        const last = entries[entries.length - 1];

        return {
            id,
            owner,
            title: id,
            createdAt: first ? Date.parse(first.timestamp) : mtime,
            updatedAt: last ? Date.parse(last.timestamp) : mtime,
        };
    }

    return {
        async create(session: NewSession): Promise<SessionRecord> {
            const path = filePath(session.title);

            if (session.meta && Object.keys(session.meta).length > 0) {
                log.warn(
                    { session: session.title, keys: Object.keys(session.meta) },
                    "json-files backend has nowhere to store session meta — dropped"
                );
            }

            if (!existsSync(path)) {
                writeFileSync(path, "");
            }

            return sessionRecord(session.title, session.owner, []);
        },

        async byTitle(owner: string, title: string): Promise<SessionRecord | undefined> {
            if (!VALID_ID.test(title) || !existsSync(filePath(title))) {
                return undefined;
            }

            return sessionRecord(title, owner, readEntries(title));
        },

        async byId(id: string): Promise<SessionRecord | undefined> {
            if (!VALID_ID.test(id) || !existsSync(filePath(id))) {
                return undefined;
            }

            return sessionRecord(id, dir, readEntries(id));
        },

        async list(owner: string): Promise<SessionRecord[]> {
            const ids = readdirSync(dir)
                .filter((name) => name.endsWith(".jsonl"))
                .map((name) => name.slice(0, -".jsonl".length))
                .filter((id) => VALID_ID.test(id));
            const records = ids.map((id) => sessionRecord(id, owner, readEntries(id)));

            return records.sort((a, b) => b.updatedAt - a.updatedAt);
        },

        async append(message: NewMessage): Promise<MessageRecord> {
            const timestamp = new Date().toISOString();
            const entry = toEntry(message, timestamp);
            const path = filePath(message.sessionId);
            const index = readEntries(message.sessionId).length;
            appendFileSync(path, `${SafeJSON.stringify(entry)}\n`);

            return toRecord(message.sessionId, entry, index);
        },

        async appendPair(user: NewMessage, assistant: NewMessage): Promise<MessageRecord> {
            const timestamp = new Date().toISOString();
            const userEntry = toEntry(user, timestamp);
            const assistantEntry = toEntry(assistant, timestamp);
            const path = filePath(assistant.sessionId);
            const index = readEntries(assistant.sessionId).length;
            // One write, so a reader never catches the question without its answer.
            appendFileSync(path, `${SafeJSON.stringify(userEntry)}\n${SafeJSON.stringify(assistantEntry)}\n`);

            return toRecord(assistant.sessionId, assistantEntry, index + 1);
        },

        async messages(id: string): Promise<MessageRecord[]> {
            return readEntries(id).map((entry, index) => toRecord(id, entry, index));
        },

        async touch(id: string): Promise<void> {
            // The last entry's timestamp IS the session's updatedAt in this
            // format; appending already moved it. Nothing to write.
            log.debug({ session: id }, "json-files touch is a no-op (updatedAt derives from the last entry)");
        },
    };
}

function entryMeta(entry: DiskEntry): Record<string, unknown> | undefined {
    switch (entry.type) {
        case "config":
            return compact({ provider: entry.provider, model: entry.model, systemPrompt: entry.systemPrompt });
        case "user":
            return compact({ metadata: entry.metadata });
        case "assistant":
            return compact({
                thinking: entry.thinking,
                usage: entry.usage,
                cost: entry.cost,
                toolCalls: entry.toolCalls,
            });
        case "context":
            return compact({ label: entry.label, metadata: entry.metadata });
        case "system":
            return undefined;
    }
}

/** The inverse of `entryMeta` — `role` picks the entry type, `meta` refills its fields. */
function toEntry(message: NewMessage, timestamp: string): DiskEntry {
    const meta = message.meta ?? {};

    switch (message.role) {
        case "config":
            return {
                type: "config",
                timestamp,
                provider: asString(meta.provider) ?? "",
                model: asString(meta.model) ?? "",
                ...(meta.systemPrompt === undefined ? {} : { systemPrompt: asString(meta.systemPrompt) }),
            };
        case "assistant":
            return {
                type: "assistant",
                content: message.content,
                timestamp,
                ...compact({
                    thinking: meta.thinking,
                    usage: meta.usage,
                    cost: meta.cost,
                    toolCalls: meta.toolCalls,
                }),
            };
        case "context":
            return {
                type: "context",
                content: message.content,
                timestamp,
                ...compact({ label: meta.label, metadata: meta.metadata }),
            };
        case "system":
            return { type: "system", content: message.content, timestamp };
        case "tool":
            // The format has no tool entry; ask records tool activity inside an
            // assistant entry's `toolCalls`. Keep the content rather than drop it.
            return {
                type: "assistant",
                content: message.content,
                timestamp,
                ...compact({ toolCalls: meta.toolCalls }),
            };
        case "user":
            return {
                type: "user",
                content: message.content,
                timestamp,
                ...compact({ metadata: meta.metadata }),
            };
    }
}

function compact<T extends Record<string, unknown>>(value: T): Record<string, unknown> | undefined {
    const entries = Object.entries(value).filter(([, v]) => v !== undefined);

    if (entries.length === 0) {
        return undefined;
    }

    return Object.fromEntries(entries);
}

function asString(value: unknown): string | undefined {
    return typeof value === "string" ? value : undefined;
}
