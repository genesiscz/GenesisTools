import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { ParsedReviewThread, ReviewSessionData, ReviewSessionMeta } from "@app/github/types";
import { Storage } from "@app/utils/storage/storage";

const SESSIONS_DIR = "reviews";
const SESSION_TTL = "7 days";

export class ReviewSessionManager {
    private storage: Storage;

    constructor() {
        this.storage = new Storage("github");
    }

    generateSessionId(prNumber: number): string {
        const now = new Date();
        const date = now.toISOString().slice(0, 10).replace(/-/g, "");
        const time = now.toISOString().slice(11, 19).replace(/:/g, "");
        return `pr${prNumber}-${date}-${time}`;
    }

    private validateSessionId(sessionId: string): string {
        if (!/^[A-Za-z0-9_-]+$/.test(sessionId)) {
            throw new Error(`Invalid session ID: "${sessionId}" — only alphanumeric, dash, and underscore allowed`);
        }

        return sessionId;
    }

    async createSession(data: ReviewSessionData): Promise<string> {
        const sessionId = this.validateSessionId(data.meta.sessionId);
        await this.storage.putCacheFile(`${SESSIONS_DIR}/${sessionId}.json`, data, SESSION_TTL);
        await this.storage.putCacheFile(`${SESSIONS_DIR}/${sessionId}.meta.json`, data.meta, SESSION_TTL);
        return sessionId;
    }

    async loadSession(sessionId: string): Promise<ReviewSessionData | null> {
        const safeId = this.validateSessionId(sessionId);
        return this.storage.getCacheFile<ReviewSessionData>(`${SESSIONS_DIR}/${safeId}.json`, SESSION_TTL);
    }

    async loadSessionMeta(sessionId: string): Promise<ReviewSessionMeta | null> {
        const safeId = this.validateSessionId(sessionId);
        return this.storage.getCacheFile<ReviewSessionMeta>(`${SESSIONS_DIR}/${safeId}.meta.json`, SESSION_TTL);
    }

    async listSessions(): Promise<ReviewSessionMeta[]> {
        const dir = join(this.storage.getCacheDir(), SESSIONS_DIR);
        if (!existsSync(dir)) {
            return [];
        }

        const files = readdirSync(dir).filter((f) => f.endsWith(".meta.json"));
        const sessions: ReviewSessionMeta[] = [];

        for (const file of files) {
            const sessionId = file.replace(".meta.json", "");
            const meta = await this.loadSessionMeta(sessionId);
            if (meta) {
                sessions.push(meta);
            }
        }

        return sessions.sort((a, b) => b.createdAt - a.createdAt);
    }

    async findRecentSessionForPR(
        owner: string,
        repo: string,
        prNumber: number,
        maxAgeMs = 60 * 60 * 1000
    ): Promise<ReviewSessionMeta | null> {
        const sessions = await this.listSessions();
        const cutoff = Date.now() - maxAgeMs;

        return (
            sessions.find(
                (s) => s.prNumber === prNumber && s.owner === owner && s.repo === repo && s.createdAt > cutoff
            ) ?? null
        );
    }

    /**
     * Resolve ref IDs (t1, t3) or raw GraphQL IDs (PRRT_xxx) to thread entries.
     * Returns array of { refId, threadId, thread } for each resolved ref.
     */
    resolveRefIds(
        sessionData: ReviewSessionData,
        refIds: string[]
    ): { refId: string; threadId: string; thread: ParsedReviewThread | undefined }[] {
        const results: { refId: string; threadId: string; thread: ParsedReviewThread | undefined }[] = [];

        for (const ref of refIds) {
            const match = ref.match(/^t(\d+)$/i);
            if (match) {
                const threadNumber = parseInt(match[1], 10);
                const thread = sessionData.threads.find((t) => t.threadNumber === threadNumber);
                results.push({ refId: ref, threadId: thread?.threadId ?? ref, thread });
            } else {
                // Treat as raw GraphQL thread ID
                const thread = sessionData.threads.find((t) => t.threadId === ref);
                if (thread) {
                    results.push({ refId: `t${thread.threadNumber}`, threadId: ref, thread });
                } else {
                    results.push({ refId: ref, threadId: ref, thread: undefined });
                }
            }
        }

        return results;
    }
}
