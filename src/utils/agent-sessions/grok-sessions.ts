import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { nativeSessionRoots } from "@genesiscz/utils/providers/session-paths";
import { matchSessionText, sortAndLimit } from "./match";
import type { AgentSearchFilters, AgentSearchHit, AgentSession, AgentSessionAdapter } from "./types";

const USER_QUERY_RE = /<user_query>\s*([\s\S]*?)\s*<\/user_query>/i;

interface GrokSummary {
    info?: { id?: string; cwd?: string };
    generated_title?: string;
    session_summary?: string;
    updated_at?: string;
    created_at?: string;
}

export function grokSessionsRoot(home = homedir()): string {
    return nativeSessionRoots("grok", home)[0] ?? join(home, ".grok", "sessions");
}

export function grokSessionsRoots(home = homedir()): string[] {
    return nativeSessionRoots("grok", home);
}

function isUuidDir(name: string): boolean {
    return /^[0-9a-f-]{20,}$/i.test(name);
}

export function extractGrokUserQueries(chatHistoryText: string): string[] {
    const queries: string[] = [];

    for (const line of chatHistoryText.split("\n")) {
        if (!line.includes("user_query") && !line.includes('"type":"user"')) {
            continue;
        }

        let parsed: { type?: string; content?: unknown };
        try {
            parsed = SafeJSON.parse(line, { strict: true }) as { type?: string; content?: unknown };
        } catch {
            continue;
        }

        if (parsed.type !== "user") {
            continue;
        }

        const blobs: string[] = [];
        if (typeof parsed.content === "string") {
            blobs.push(parsed.content);
        } else if (Array.isArray(parsed.content)) {
            for (const part of parsed.content) {
                if (part && typeof part === "object" && "text" in part && typeof part.text === "string") {
                    blobs.push(part.text);
                }
            }
        }

        for (const blob of blobs) {
            const tagged = blob.match(USER_QUERY_RE);
            if (tagged?.[1]?.trim()) {
                queries.push(tagged[1].trim());
                continue;
            }

            const text = blob.trim();
            if (text.length === 0 || text.startsWith("<user_info>") || text.startsWith("<git_status>")) {
                continue;
            }

            queries.push(text);
        }
    }

    return queries;
}

function readSummary(dir: string, encodedCwd: string): AgentSession | undefined {
    const summaryPath = join(dir, "summary.json");
    let raw: string;
    try {
        raw = readFileSync(summaryPath, "utf8");
    } catch {
        return undefined;
    }

    let parsed: GrokSummary;
    try {
        parsed = SafeJSON.parse(raw, { strict: true }) as GrokSummary;
    } catch {
        return undefined;
    }

    const sessionId = parsed.info?.id ?? "";
    if (!sessionId) {
        return undefined;
    }

    const cwd = parsed.info?.cwd || decodeURIComponent(encodedCwd);
    const title = parsed.generated_title || parsed.session_summary || sessionId;
    const stamp = parsed.updated_at || parsed.created_at;
    let mtime = new Date(stamp ?? 0);
    if (Number.isNaN(mtime.getTime())) {
        try {
            mtime = new Date(statSync(summaryPath).mtimeMs);
        } catch {
            mtime = new Date(0);
        }
    }

    return {
        kind: "grok",
        sessionId,
        cwd,
        title,
        summary: parsed.session_summary,
        mtime,
        filePath: summaryPath,
        project: cwd.split("/").pop(),
    };
}

export function listGrokSessionsFromRoot(sessionsRoot: string): AgentSession[] {
    let cwdDirs: string[] = [];
    try {
        cwdDirs = readdirSync(sessionsRoot);
    } catch {
        return [];
    }

    const sessions: AgentSession[] = [];

    for (const encoded of cwdDirs) {
        const cwdDir = join(sessionsRoot, encoded);
        let names: string[] = [];
        try {
            if (!statSync(cwdDir).isDirectory()) {
                continue;
            }
            names = readdirSync(cwdDir);
        } catch {
            continue;
        }

        for (const name of names) {
            if (!isUuidDir(name)) {
                continue;
            }

            const session = readSummary(join(cwdDir, name), encoded);
            if (session) {
                sessions.push(session);
            }
        }
    }

    return sessions;
}

function extraTextsFor(session: AgentSession): string[] {
    const historyPath = join(dirname(session.filePath), "chat_history.jsonl");
    try {
        return extractGrokUserQueries(readFileSync(historyPath, "utf8"));
    } catch {
        return [];
    }
}

export function listGrokSessionsFromRoots(roots: string[]): AgentSession[] {
    const seen = new Set<string>();
    const sessions: AgentSession[] = [];

    for (const root of roots) {
        for (const session of listGrokSessionsFromRoot(root)) {
            if (seen.has(session.sessionId)) {
                continue;
            }
            seen.add(session.sessionId);
            sessions.push(session);
        }
    }

    return sessions;
}

export function searchGrokSessions(sessionsRoot: string, filters: AgentSearchFilters): AgentSearchHit[] {
    return searchGrokSessionsInRoots([sessionsRoot], filters);
}

export function searchGrokSessionsInRoots(roots: string[], filters: AgentSearchFilters): AgentSearchHit[] {
    const hits: AgentSearchHit[] = [];

    for (const session of listGrokSessionsFromRoots(roots)) {
        const extras = filters.query ? extraTextsFor(session) : [];
        if (filters.query && extras[0] && !session.prompt) {
            session.prompt = extras[0];
        }

        const hit = matchSessionText(session, extras, filters);
        if (hit) {
            hits.push(hit);
        }
    }

    return sortAndLimit(hits, filters.limit);
}

export function createGrokAdapter(sessionsRoot?: string): AgentSessionAdapter {
    const roots = sessionsRoot ? [sessionsRoot] : grokSessionsRoots();

    return {
        kind: "grok",
        async list(filters) {
            return searchGrokSessionsInRoots(roots, { ...filters, query: undefined });
        },
        async search(filters) {
            return searchGrokSessionsInRoots(roots, filters);
        },
    };
}
