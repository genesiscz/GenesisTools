import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { nativeSessionRoots } from "@genesiscz/utils/providers/session-paths";
import { matchSessionText, sortAndLimit } from "./match";
import type { AgentSearchFilters, AgentSearchHit, AgentSession, AgentSessionAdapter } from "./types";

interface CodexLine {
    type?: string;
    timestamp?: string;
    payload?: {
        session_id?: string;
        id?: string;
        cwd?: string;
        type?: string;
        role?: string;
        content?: Array<{ type?: string; text?: string }>;
    };
}

function walkRollouts(root: string, files: string[]): void {
    let entries: string[] = [];
    try {
        entries = readdirSync(root);
    } catch {
        return;
    }

    for (const name of entries) {
        const path = join(root, name);
        let st: ReturnType<typeof statSync>;
        try {
            st = statSync(path);
        } catch {
            continue;
        }

        if (st.isDirectory()) {
            walkRollouts(path, files);
            continue;
        }

        if (name.startsWith("rollout-") && (name.endsWith(".jsonl") || name.endsWith(".json"))) {
            files.push(path);
        }
    }
}

function firstUserPrompt(payload: CodexLine["payload"]): string | undefined {
    if (payload?.role !== "user") {
        return undefined;
    }

    const texts = (payload.content ?? []).map((part) => part.text ?? "").filter(Boolean);
    const text = texts.join("\n").trim();
    if (!text || text.startsWith("# AGENTS.md")) {
        return undefined;
    }

    return text;
}

export function parseCodexRollout(filePath: string, maxLines = 80): AgentSession | undefined {
    let raw: string;
    try {
        raw = readFileSync(filePath, "utf8");
    } catch {
        return undefined;
    }

    let sessionId = "";
    let cwd = "";
    let prompt: string | undefined;
    let stamp = "";

    const lines = raw.split("\n");
    const scan = Math.min(lines.length, maxLines);

    for (let i = 0; i < scan; i++) {
        const line = lines[i];
        if (!line.trim()) {
            continue;
        }

        let parsed: CodexLine;
        try {
            parsed = SafeJSON.parse(line, { strict: true }) as CodexLine;
        } catch {
            continue;
        }

        if (parsed.type === "session_meta") {
            sessionId = parsed.payload?.session_id || parsed.payload?.id || sessionId;
            cwd = parsed.payload?.cwd || cwd;
            stamp = parsed.timestamp || stamp;
        }

        if (!prompt) {
            prompt = firstUserPrompt(parsed.payload);
        }

        if (sessionId && cwd && prompt) {
            break;
        }
    }

    if (!sessionId) {
        const fromName = basename(filePath).match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
        sessionId = fromName?.[1] ?? "";
    }

    if (!sessionId) {
        return undefined;
    }

    let mtime = stamp ? new Date(stamp) : new Date(NaN);
    if (Number.isNaN(mtime.getTime())) {
        try {
            mtime = new Date(statSync(filePath).mtimeMs);
        } catch {
            mtime = new Date(0);
        }
    }

    const title = prompt ? prompt.split("\n")[0].slice(0, 80) : sessionId;

    return {
        kind: "codex",
        sessionId,
        cwd,
        title,
        prompt,
        mtime,
        filePath,
        project: cwd.split("/").pop(),
    };
}

export function listCodexSessionsFromRoots(roots: string[]): AgentSession[] {
    const files: string[] = [];
    for (const root of roots) {
        walkRollouts(root, files);
    }

    const sessions: AgentSession[] = [];
    const seen = new Set<string>();

    for (const file of files) {
        const session = parseCodexRollout(file);
        if (!session || seen.has(session.sessionId)) {
            continue;
        }

        seen.add(session.sessionId);
        sessions.push(session);
    }

    return sessions;
}

export function searchCodexSessions(roots: string[], filters: AgentSearchFilters): AgentSearchHit[] {
    const hits: AgentSearchHit[] = [];

    for (const session of listCodexSessionsFromRoots(roots)) {
        const extras = session.prompt ? [session.prompt] : [];
        const hit = matchSessionText(session, extras, filters);
        if (hit) {
            hits.push(hit);
        }
    }

    return sortAndLimit(hits, filters.limit);
}

export function createCodexAdapter(roots?: string[]): AgentSessionAdapter {
    const resolved = roots ?? nativeSessionRoots("codex", homedir());

    return {
        kind: "codex",
        async list(filters) {
            return searchCodexSessions(resolved, { ...filters, query: undefined });
        },
        async search(filters) {
            return searchCodexSessions(resolved, filters);
        },
    };
}
