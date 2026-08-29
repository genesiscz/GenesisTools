import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { PROJECTS_DIR } from "@genesiscz/utils/claude/projects";
import { sessionsDir as codexWorkerDir } from "@genesiscz/utils/codex/worker-paths";
import { env } from "@genesiscz/utils/env";
import { sessionsDir as grokWorkerDir } from "@genesiscz/utils/grok/worker-paths";
import { SafeJSON } from "@genesiscz/utils/json";
import { nativeSessionRoots } from "@genesiscz/utils/providers/session-paths";
import type { TranscriptProvider } from "./types";

export type TranscriptSource = "native" | "worker";

export interface TranscriptRoots {
    claudeProjects?: string;
    /** Every Claude root, so auto-resolution is not limited to the first. */
    claudeProjectsAll?: string[];
    grokHome?: string;
    grokWorker?: string;
    codexHome?: string;
    codexWorker?: string;
}

export interface ResolvedTranscript {
    provider: TranscriptProvider;
    source: TranscriptSource;
    sessionId: string;
    filePath: string;
    extraFiles?: string[];
}

interface RankedHit extends ResolvedTranscript {
    mtime: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function idMatches(query: string, candidate: string): boolean {
    const q = query.toLowerCase();
    const c = candidate.toLowerCase();
    if (c === q) {
        return true;
    }
    if (q.length >= 8 && (c.startsWith(q) || c.includes(q))) {
        return true;
    }
    return false;
}

function mtimeOf(path: string): number {
    try {
        return statSync(path).mtimeMs;
    } catch {
        return 0;
    }
}

function listDir(path: string): string[] {
    try {
        return readdirSync(path);
    } catch {
        return [];
    }
}

function isDir(path: string): boolean {
    try {
        return statSync(path).isDirectory();
    } catch {
        return false;
    }
}

function turnNumber(file: string): number {
    const match = file.match(/\.turn(\d+)\.jsonl$/);
    return match ? Number(match[1]) : 0;
}

/**
 * A worker turn file is EXACTLY `<name>.turn<N>.jsonl`.
 *
 * `startsWith(`${name}.turn`)` was not that test. For a worker named "task" it
 * also accepted "task.turnover.turn2.jsonl", which belongs to a DIFFERENT
 * worker, and `turnNumber()` then read it as turn 2 — so follow mode could
 * switch to another session's transcript (PR #341 review t6). Checking the
 * remainder rather than interpolating `name` into a pattern also means the
 * name never needs regex-escaping.
 */
function isTurnFileFor(name: string, file: string): boolean {
    const prefix = `${name}.turn`;

    return file.startsWith(prefix) && /^\d+\.jsonl$/.test(file.slice(prefix.length));
}

export function defaultTranscriptRoots(): Required<TranscriptRoots> {
    return {
        // nativeSessionRoots owns the root policy for every provider; hard-coding
        // PROJECTS_DIR here missed ~/.config/claude/projects and $CLAUDE_CONFIG_DIR
        // (PR #341 review round 4, t3).
        claudeProjects: nativeSessionRoots("claude")[0] ?? PROJECTS_DIR,
        claudeProjectsAll: nativeSessionRoots("claude"),
        grokHome: env.grok.getHome(),
        grokWorker: grokWorkerDir(),
        codexHome: env.codex.getHomeOverride() ?? join(homedir(), ".codex"),
        codexWorker: codexWorkerDir(),
    };
}

function findClaude(query: string, projectsDir: string): RankedHit[] {
    const hits: RankedHit[] = [];
    for (const project of listDir(projectsDir)) {
        const projectDir = join(projectsDir, project);
        if (!isDir(projectDir)) {
            continue;
        }
        const dirs = [projectDir, join(projectDir, "subagents")];
        for (const dir of dirs) {
            for (const entry of listDir(dir)) {
                if (!entry.endsWith(".jsonl")) {
                    continue;
                }
                const id = entry.slice(0, -".jsonl".length);
                if (!idMatches(query, id)) {
                    continue;
                }
                const filePath = join(dir, entry);
                hits.push({
                    provider: "claude",
                    source: "native",
                    sessionId: id,
                    filePath,
                    mtime: mtimeOf(filePath),
                });
            }
        }
    }
    return hits;
}

function findGrokNative(query: string, grokHome: string): RankedHit[] {
    const hits: RankedHit[] = [];
    const root = join(grokHome, "sessions");
    for (const cwdEnc of listDir(root)) {
        const cwdDir = join(root, cwdEnc);
        if (!isDir(cwdDir)) {
            continue;
        }
        for (const id of listDir(cwdDir)) {
            if (!idMatches(query, id)) {
                continue;
            }
            const filePath = join(cwdDir, id, "updates.jsonl");
            if (!existsSync(filePath)) {
                continue;
            }
            hits.push({
                provider: "grok",
                source: "native",
                sessionId: id,
                filePath,
                mtime: mtimeOf(filePath),
            });
        }
    }
    return hits;
}

function findGrokWorker(query: string, workerDir: string): RankedHit[] {
    const hits: RankedHit[] = [];
    const entries = listDir(workerDir);
    for (const entry of entries) {
        if (!entry.endsWith(".meta.json")) {
            continue;
        }
        const name = entry.slice(0, -".meta.json".length);
        let sessionId = name;
        try {
            const meta = SafeJSON.parse(readFileSync(join(workerDir, entry), "utf8"));
            if (isRecord(meta) && typeof meta.sessionId === "string" && meta.sessionId) {
                sessionId = meta.sessionId;
            }
        } catch {
            // Name-only match still works when meta is unreadable.
        }
        if (!idMatches(query, name) && !idMatches(query, sessionId)) {
            continue;
        }
        const turns = entries
            .filter((file) => isTurnFileFor(name, file))
            .sort((a, b) => turnNumber(a) - turnNumber(b))
            .map((file) => join(workerDir, file));
        if (turns.length === 0) {
            continue;
        }
        const filePath = turns[turns.length - 1];
        const extraFiles = turns.slice(0, -1);
        hits.push({
            provider: "grok",
            source: "worker",
            sessionId,
            filePath,
            extraFiles: extraFiles.length > 0 ? extraFiles : undefined,
            mtime: mtimeOf(filePath),
        });
    }
    return hits;
}

/**
 * Re-read a worker session's turn files, for follow mode.
 *
 * A worker session is a SEQUENCE of `<name>.turn<N>.jsonl`, and the next steer
 * writes a new one. `followTranscript` tails a single path, so without this it
 * silently stopped updating at the turn that existed when it started
 * (PR #341 review round 4, t2).
 */
export function rescanWorkerTurns(resolved: ResolvedTranscript): { filePath: string; extraFiles?: string[] } | null {
    if (resolved.source !== "worker") {
        return null;
    }

    const dir = dirname(resolved.filePath);
    const base = basename(resolved.filePath);
    const match = /^(.*)\.turn\d+\.jsonl$/.exec(base);

    if (!match) {
        return null;
    }

    const name = match[1];
    const turns = listDir(dir)
        .filter((file) => isTurnFileFor(name, file))
        .sort((a, b) => turnNumber(a) - turnNumber(b))
        .map((file) => join(dir, file));

    if (turns.length === 0) {
        return null;
    }

    const filePath = turns[turns.length - 1];
    const extraFiles = turns.slice(0, -1);
    return { filePath, extraFiles: extraFiles.length > 0 ? extraFiles : undefined };
}

function splitCodexHomes(codexHome: string): string[] {
    const override = env.codex.getHomeOverride();
    if (override && codexHome === override) {
        return override
            .split(",")
            .map((part) => part.trim())
            .filter((part) => part.length > 0);
    }
    return [codexHome];
}

function codexNativeSessionId(entry: string): string {
    const stem = basename(entry, ".jsonl").replace(/^rollout-/, "");
    const uuid = stem.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    return uuid?.[0] ?? stem;
}

function findCodexNative(query: string, codexHome: string): RankedHit[] {
    const hits: RankedHit[] = [];
    const homes = splitCodexHomes(codexHome);
    for (const home of homes) {
        for (const bucket of ["sessions", "archived_sessions"]) {
            const root = join(home, bucket);
            for (const year of listDir(root)) {
                const yearDir = join(root, year);
                if (!isDir(yearDir)) {
                    continue;
                }
                for (const month of listDir(yearDir)) {
                    const monthDir = join(yearDir, month);
                    if (!isDir(monthDir)) {
                        continue;
                    }
                    for (const day of listDir(monthDir)) {
                        const dayDir = join(monthDir, day);
                        if (!isDir(dayDir)) {
                            continue;
                        }
                        for (const entry of listDir(dayDir)) {
                            if (!entry.endsWith(".jsonl") || !idMatches(query, entry)) {
                                continue;
                            }
                            const filePath = join(dayDir, entry);
                            const id = codexNativeSessionId(entry);
                            hits.push({
                                provider: "codex",
                                source: "native",
                                sessionId: id,
                                filePath,
                                mtime: mtimeOf(filePath),
                            });
                        }
                    }
                }
            }
        }
    }
    return hits;
}

function findCodexWorker(query: string, workerDir: string): RankedHit[] {
    const hits: RankedHit[] = [];
    for (const entry of listDir(workerDir)) {
        if (!entry.endsWith(".meta.json")) {
            continue;
        }
        const name = entry.slice(0, -".meta.json".length);
        let sessionId = name;
        try {
            const meta = SafeJSON.parse(readFileSync(join(workerDir, entry), "utf8"));
            if (isRecord(meta)) {
                if (typeof meta.threadId === "string" && meta.threadId) {
                    sessionId = meta.threadId;
                } else if (typeof meta.name === "string" && meta.name) {
                    sessionId = meta.name;
                }
            }
        } catch {
            // Name-only match still works when meta is unreadable.
        }
        if (!idMatches(query, name) && !idMatches(query, sessionId)) {
            continue;
        }
        const filePath = join(workerDir, `${name}.jsonl`);
        if (!existsSync(filePath)) {
            continue;
        }
        hits.push({
            provider: "codex",
            source: "worker",
            sessionId,
            filePath,
            mtime: mtimeOf(filePath),
        });
    }
    return hits;
}

export async function resolveTranscript(
    query: string,
    roots: TranscriptRoots = {},
    provider?: TranscriptProvider
): Promise<ResolvedTranscript> {
    const resolved = { ...defaultTranscriptRoots(), ...roots };
    // An explicitly injected root is the whole answer; only the default set
    // fans out across every Claude root that nativeSessionRoots knows.
    const claudeRoots = roots.claudeProjects ? [roots.claudeProjects] : resolved.claudeProjectsAll;
    const hits: RankedHit[] = [];
    if (!provider || provider === "claude") {
        for (const root of claudeRoots) {
            hits.push(...findClaude(query, root));
        }
    }
    if (!provider || provider === "grok") {
        hits.push(...findGrokNative(query, resolved.grokHome));
        hits.push(...findGrokWorker(query, resolved.grokWorker));
    }
    if (!provider || provider === "codex") {
        hits.push(...findCodexNative(query, resolved.codexHome));
        hits.push(...findCodexWorker(query, resolved.codexWorker));
    }
    if (hits.length === 0) {
        throw new Error(`No session file found for "${query}"`);
    }
    hits.sort((a, b) => b.mtime - a.mtime);
    const best = hits[0];
    return {
        provider: best.provider,
        source: best.source,
        sessionId: best.sessionId,
        filePath: best.filePath,
        extraFiles: best.extraFiles,
    };
}
