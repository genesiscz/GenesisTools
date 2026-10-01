import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { PROJECTS_DIR } from "@genesiscz/utils/claude/projects";
import { workersDir as claudeWorkerDir } from "@genesiscz/utils/claude/worker-paths";
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
    /** `tools claude worker` sessions: `<name>.meta.json` + `<name>.turn<N>.jsonl`. */
    claudeWorker?: string;
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
        claudeWorker: claudeWorkerDir(),
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
    return [...hits, ...findClaudeSubagent(query, projectsDir)];
}

/** `aE-sharedkit-47434100f6deeb1c`, `a0564229bc9945515`, or either with its `agent-` file prefix. */
const SUBAGENT_ID = /^a[A-Za-z0-9][A-Za-z0-9_-]*$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A sub-agent transcript by its exact id: `<project>/<session>/subagents/agent-<id>.jsonl`.
 * Exact only, since every session directory is probed with one `existsSync`.
 */
function findClaudeSubagent(query: string, projectsDir: string): RankedHit[] {
    const agentId = query.replace(/^agent-/, "");
    if (!SUBAGENT_ID.test(agentId) || UUID.test(agentId)) {
        return [];
    }

    const hits: RankedHit[] = [];
    for (const project of listDir(projectsDir)) {
        const projectDir = join(projectsDir, project);
        for (const session of listDir(projectDir)) {
            if (session.endsWith(".jsonl")) {
                continue;
            }

            const filePath = join(projectDir, session, "subagents", `agent-${agentId}.jsonl`);
            if (existsSync(filePath)) {
                hits.push({
                    provider: "claude",
                    source: "native",
                    sessionId: agentId,
                    filePath,
                    mtime: mtimeOf(filePath),
                });
            }
        }
    }

    return hits;
}

/** The real path when it exists, so a symlinked home (or `~/.claude`) still contains its files. */
function realOrResolved(path: string): string {
    return existsSync(path) ? realpathSync(path) : resolve(path);
}

function isInside(root: string, path: string): boolean {
    const rel = relative(realOrResolved(root), realOrResolved(path));
    return rel.length > 0 && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

/**
 * An existing absolute transcript path, with its provider and source read off the root it lives
 * under. Null when the path is under no known root and no provider was named.
 */
function resolvePath(
    path: string,
    roots: Required<TranscriptRoots>,
    claudeRoots: string[],
    provider?: TranscriptProvider
): ResolvedTranscript | null {
    const filePath = resolve(path);
    const stem = basename(filePath).replace(/\.jsonl$/, "");
    const located: Array<{ root: string; provider: TranscriptProvider; source: TranscriptSource }> = [
        ...claudeRoots.map((root) => ({ root, provider: "claude" as const, source: "native" as const })),
        { root: roots.claudeWorker, provider: "claude", source: "worker" },
        { root: roots.grokWorker, provider: "grok", source: "worker" },
        { root: roots.codexWorker, provider: "codex", source: "worker" },
        ...splitCodexHomes(roots.codexHome).map((root) => ({
            root,
            provider: "codex" as const,
            source: "native" as const,
        })),
        { root: roots.grokHome, provider: "grok", source: "native" },
    ];
    const hit = located.find((entry) => isInside(entry.root, filePath));

    if (!hit && !provider) {
        return null;
    }

    const resolvedProvider = provider ?? hit?.provider ?? "claude";
    const source = hit?.source ?? "native";

    if (source === "worker" && resolvedProvider !== "codex") {
        // The turn chain, so a steer's next turn file is followed (`rescanWorkerTurns`).
        const name = stem.replace(/\.turn\d+$/, "");
        const self: ResolvedTranscript = { provider: resolvedProvider, source, sessionId: name, filePath };
        return { ...self, ...(rescanWorkerTurns(self) ?? {}) };
    }

    if (resolvedProvider === "codex") {
        return {
            provider: "codex",
            source,
            sessionId: source === "native" ? codexNativeSessionId(filePath) : stem,
            filePath,
        };
    }

    if (resolvedProvider === "grok") {
        // Native grok is `<cwd>/<sessionId>/updates.jsonl`: the id is the folder.
        return { provider: "grok", source, sessionId: basename(dirname(filePath)), filePath };
    }

    return { provider: "claude", source, sessionId: stem.replace(/^agent-/, ""), filePath };
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

/**
 * A `<name>.meta.json` + `<name>.turn<N>.jsonl` worker directory, the layout
 * `tools grok` and `tools claude worker` share. Matches the worker name or the
 * session uuid in its meta; the latest turn file is the head, earlier ones the chain.
 */
function findTurnFileWorker(query: string, workerDir: string, provider: TranscriptProvider): RankedHit[] {
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
            provider,
            source: "worker",
            sessionId,
            filePath,
            extraFiles: extraFiles.length > 0 ? extraFiles : undefined,
            mtime: mtimeOf(filePath),
        });
    }
    return hits;
}

function findGrokWorker(query: string, workerDir: string): RankedHit[] {
    return findTurnFileWorker(query, workerDir, "grok");
}

function findClaudeWorker(query: string, workerDir: string): RankedHit[] {
    return findTurnFileWorker(query, workerDir, "claude");
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

    // An existing absolute path (a sub-agent's agent-<id>.jsonl, a worker turn file) is the answer
    // as it is: its provider comes from the root it lives under.
    if (isAbsolute(query) && existsSync(query)) {
        const byPath = resolvePath(query, resolved, claudeRoots, provider);
        if (!byPath) {
            throw new Error(`"${query}" is under no known transcript root; pass --provider to read it`);
        }

        return byPath;
    }

    const hits: RankedHit[] = [];
    if (!provider || provider === "claude") {
        for (const root of claudeRoots) {
            hits.push(...findClaude(query, root));
        }
        hits.push(...findClaudeWorker(query, resolved.claudeWorker));
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
