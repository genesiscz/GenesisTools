import type { JsonFilesBackend } from "@genesiscz/utils/ai/session";
import { createJsonFilesBackend } from "@genesiscz/utils/ai/session";
import type { ChatSessionManagerRef } from "./ChatSession";
import { ChatSession } from "./ChatSession";
import type { SessionEntry } from "./types";

/**
 * ask's sessions, stored by the shared session backend.
 *
 * The JSONL format is unchanged — `createJsonFilesBackend` reads and writes the
 * same `<id>.jsonl` files this class used to open itself, so sessions written
 * before this refactor load unchanged. What moved out is the file handling:
 * directory creation, line parsing, the malformed-line skip and the delete.
 * What stayed is everything ask-specific — the `SessionEntry` union, the
 * in-memory `ChatSession` buffer, and the "save writes the whole session" model.
 */
export class ChatSessionManager implements ChatSessionManagerRef {
    private readonly backend: JsonFilesBackend;

    constructor(options: { dir: string }) {
        this.backend = createJsonFilesBackend({ dir: options.dir });
    }

    /** Create a new empty session */
    create(id?: string): ChatSession {
        const sessionId = id ?? crypto.randomUUID();
        this.validateSessionId(sessionId);
        const session = new ChatSession(sessionId);
        session.setManager(this);
        return session;
    }

    /** Load session from JSONL file */
    async load(sessionId: string): Promise<ChatSession> {
        this.validateSessionId(sessionId);

        if (!(await this.backend.byId(sessionId))) {
            throw new Error(`Session not found: ${sessionId}`);
        }

        // The backend hands back what the file held; the union is ask's to narrow.
        const entries = (await this.backend.rawEntries(sessionId)) as SessionEntry[];
        const session = new ChatSession(sessionId, entries);
        session.setManager(this);
        return session;
    }

    /** Save session entries to JSONL file */
    async save(session: ChatSession): Promise<void> {
        this.validateSessionId(session.id);
        await this.backend.writeRawEntries(session.id, session.getAllEntries());
    }

    /** List available sessions */
    async list(): Promise<Array<{ id: string; startedAt: string; messageCount: number; lastActivity: string }>> {
        const sessions: Array<{ id: string; startedAt: string; messageCount: number; lastActivity: string }> = [];

        // The directory is the namespace in this format, so `owner` is inert here.
        for (const record of await this.backend.list("ask")) {
            const entries = await this.backend.messages(record.id);

            if (entries.length === 0) {
                continue;
            }

            sessions.push({
                id: record.id,
                startedAt: new Date(entries[0].at).toISOString(),
                messageCount: entries.length,
                lastActivity: new Date(entries[entries.length - 1].at).toISOString(),
            });
        }

        sessions.sort((a, b) => b.lastActivity.localeCompare(a.lastActivity));
        return sessions;
    }

    /** Delete a session file */
    async delete(sessionId: string): Promise<void> {
        this.validateSessionId(sessionId);
        await this.backend.remove(sessionId);
    }

    /** Check if a session exists */
    async exists(sessionId: string): Promise<boolean> {
        this.validateSessionId(sessionId);
        return (await this.backend.byId(sessionId)) !== undefined;
    }

    private validateSessionId(sessionId: string): void {
        if (!/^[A-Za-z0-9_-]+$/.test(sessionId)) {
            throw new Error(`Invalid session ID "${sessionId}" — only alphanumeric, hyphens, and underscores allowed`);
        }
    }
}
