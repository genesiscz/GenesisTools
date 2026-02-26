import { existsSync, mkdirSync, readdirSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";
import type { ChatSessionManagerRef } from "./ChatSession";
import { ChatSession } from "./ChatSession";
import type { SessionEntry } from "./types";

export class ChatSessionManager implements ChatSessionManagerRef {
    private readonly dir: string;

    constructor(options: { dir: string }) {
        this.dir = resolve(options.dir);

        if (!existsSync(this.dir)) {
            mkdirSync(this.dir, { recursive: true });
        }
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
        const filePath = this.getFilePath(sessionId);
        const file = Bun.file(filePath);

        if (!(await file.exists())) {
            throw new Error(`Session not found: ${sessionId}`);
        }

        const text = await file.text();
        const entries: SessionEntry[] = [];

        for (const line of text.split("\n")) {
            const trimmed = line.trim();

            if (!trimmed) {
                continue;
            }

            try {
                entries.push(JSON.parse(trimmed) as SessionEntry);
            } catch {
                // Skip malformed lines
            }
        }

        const session = new ChatSession(sessionId, entries);
        session.setManager(this);
        return session;
    }

    /** Save session entries to JSONL file */
    async save(session: ChatSession): Promise<void> {
        const filePath = this.getFilePath(session.id);
        const entries = session.getAllEntries();
        const content = `${entries.map((e) => JSON.stringify(e)).join("\n")}\n`;
        await Bun.write(filePath, content);
    }

    /** List available sessions */
    async list(): Promise<Array<{ id: string; startedAt: string; messageCount: number; lastActivity: string }>> {
        const files = readdirSync(this.dir).filter((f) => f.endsWith(".jsonl"));
        const sessions: Array<{ id: string; startedAt: string; messageCount: number; lastActivity: string }> = [];

        for (const file of files) {
            const id = file.replace(".jsonl", "");

            try {
                const session = await this.load(id);
                const entries = session.getAllEntries();

                if (entries.length === 0) {
                    continue;
                }

                sessions.push({
                    id,
                    startedAt: entries[0].timestamp,
                    messageCount: entries.length,
                    lastActivity: entries[entries.length - 1].timestamp,
                });
            } catch {
                // Skip unreadable files
            }
        }

        // Sort by last activity descending
        sessions.sort((a, b) => b.lastActivity.localeCompare(a.lastActivity));
        return sessions;
    }

    /** Delete a session file */
    async delete(sessionId: string): Promise<void> {
        const filePath = this.getFilePath(sessionId);

        if (existsSync(filePath)) {
            unlinkSync(filePath);
        }
    }

    /** Check if a session exists */
    async exists(sessionId: string): Promise<boolean> {
        return existsSync(this.getFilePath(sessionId));
    }

    private validateSessionId(sessionId: string): void {
        if (!/^[A-Za-z0-9_-]+$/.test(sessionId)) {
            throw new Error(`Invalid session ID "${sessionId}" — only alphanumeric, hyphens, and underscores allowed`);
        }
    }

    private getFilePath(sessionId: string): string {
        this.validateSessionId(sessionId);
        return resolve(this.dir, `${sessionId}.jsonl`);
    }
}
