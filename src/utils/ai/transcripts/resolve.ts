import { existsSync, readFileSync, realpathSync } from "node:fs";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";
import { ACCOUNT_PROVIDER_ALIASES } from "@genesiscz/utils/ai/providers/alias-list";
import { harnessLocate } from "@genesiscz/utils/ai/providers/harness-index";
import { isDir, listDir, mtimeOf } from "@genesiscz/utils/ai/transcripts/resolve-core";
import { workersDir as claudeWorkerDir } from "@genesiscz/utils/claude/worker-paths";
import { sessionsDir as codexWorkerDir } from "@genesiscz/utils/codex/worker-paths";
import { env } from "@genesiscz/utils/env";
import { sessionsDir as grokWorkerDir } from "@genesiscz/utils/grok/worker-paths";
import {
    nativeHome,
    nativeHomePath,
    nativeSessionRoots,
    transcriptStem,
} from "@genesiscz/utils/providers/session-paths";
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

export interface RankedHit extends ResolvedTranscript {
    mtime: number;
}

/** The roots one lookup reads: what the caller injected, and the defaults merged under it (`TranscriptLocator`). */
export interface LocateRoots {
    injected: TranscriptRoots;
    resolved: Required<TranscriptRoots>;
}

/**
 * The folder reads one lookup makes. A batch shares one memo, so N ids read each folder once: a single lookup
 * reads every session folder of every provider (10 to 16 ms of CPU measured), and the stuck check asks for every
 * watched session at once. The memo lives for one call, so nothing is served from an earlier read.
 */
export interface FolderReads {
    listDir(path: string): string[];
    isDir(path: string): boolean;
    mtimeOf(path: string): number;
    exists(path: string): boolean;
    /** Throws like `readFileSync`. */
    readText(path: string): string;
}

export const directReads: FolderReads = {
    listDir,
    isDir,
    mtimeOf,
    exists: existsSync,
    readText: (path) => readFileSync(path, "utf8"),
};

function memoized<T>(read: (path: string) => T): (path: string) => T {
    const seen = new Map<string, T>();

    return (path) => {
        const known = seen.get(path);

        if (known !== undefined) {
            return known;
        }

        const value = read(path);
        seen.set(path, value);
        return value;
    };
}

function memoReads(base: FolderReads): FolderReads {
    return {
        listDir: memoized(base.listDir),
        isDir: memoized(base.isDir),
        mtimeOf: memoized(base.mtimeOf),
        exists: memoized(base.exists),
        readText: memoized(base.readText),
    };
}

export function defaultTranscriptRoots(): Required<TranscriptRoots> {
    return {
        // nativeSessionRoots owns the root policy for every provider; hard-coding
        // PROJECTS_DIR here missed ~/.config/claude/projects and $CLAUDE_CONFIG_DIR
        // (PR #341 review round 4, t3).
        claudeProjects: nativeSessionRoots("claude")[0] ?? nativeHomePath("claude", "projects"),
        claudeProjectsAll: nativeSessionRoots("claude"),
        claudeWorker: claudeWorkerDir(),
        grokHome: env.grok.getHome(),
        grokWorker: grokWorkerDir(),
        codexHome: env.codex.getHomeOverride() ?? nativeHome("codex"),
        codexWorker: codexWorkerDir(),
    };
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
function resolvePath(path: string, roots: LocateRoots, provider?: TranscriptProvider): ResolvedTranscript | null {
    const filePath = resolve(path);
    const stem = transcriptStem(basename(filePath));
    const located = ACCOUNT_PROVIDER_ALIASES.flatMap((id) =>
        harnessLocate(id)
            .pathRoots(roots)
            .map((entry) => ({ ...entry, provider: id }))
    );
    const hit = located.find((entry) => isInside(entry.root, filePath));

    if (!hit && !provider) {
        return null;
    }

    const resolvedProvider = provider ?? hit?.provider ?? "claude";
    const source = hit?.source ?? "native";

    return harnessLocate(resolvedProvider).sessionOfPath({ source, stem, filePath });
}

export async function resolveTranscript(
    query: string,
    roots: TranscriptRoots = {},
    provider?: TranscriptProvider
): Promise<ResolvedTranscript> {
    return resolveWith({ query, roots, provider, fs: directReads });
}

/**
 * The native rollout of a Codex thread, or null. A `tools codex spawn` worker's event log carries the same
 * thread id and is usually newer, so `resolveTranscript` answers the worker; a caller that needs the thread's
 * own transcript (waiting for its turn to end) asks here.
 */
export function resolveCodexNative(threadId: string, roots: TranscriptRoots = {}): ResolvedTranscript | null {
    const locate: LocateRoots = { injected: roots, resolved: { ...defaultTranscriptRoots(), ...roots } };
    const best = harnessLocate("codex")
        .find(threadId, locate, directReads)
        .filter((hit) => hit.source === "native")
        .sort((a, b) => b.mtime - a.mtime)[0];

    if (!best) {
        return null;
    }

    return { provider: best.provider, source: best.source, sessionId: best.sessionId, filePath: best.filePath };
}

/**
 * Several ids against one read of the session folders, each answered exactly as `resolveTranscript` would answer
 * it alone (a missing id maps to the same Error). For callers that hold a list of ids, such as the stuck check.
 */
export async function resolveTranscripts(
    queries: string[],
    roots: TranscriptRoots = {},
    provider?: TranscriptProvider
): Promise<Map<string, ResolvedTranscript | Error>> {
    return resolveTranscriptsWith({ queries, roots, provider, reads: directReads });
}

/** `resolveTranscripts` over the given folder reads, each read memoized for this one call (the tests count them). */
export function resolveTranscriptsWith({
    queries,
    roots = {},
    provider,
    reads,
}: {
    queries: string[];
    roots?: TranscriptRoots;
    provider?: TranscriptProvider;
    reads: FolderReads;
}): Map<string, ResolvedTranscript | Error> {
    const fs = memoReads(reads);
    const answers = new Map<string, ResolvedTranscript | Error>();

    for (const query of queries) {
        if (answers.has(query)) {
            continue;
        }

        try {
            answers.set(query, resolveWith({ query, roots, provider, fs }));
        } catch (err) {
            answers.set(query, err instanceof Error ? err : new Error(String(err)));
        }
    }

    return answers;
}

function resolveWith({
    query,
    roots,
    provider,
    fs,
}: {
    query: string;
    roots: TranscriptRoots;
    provider?: TranscriptProvider;
    fs: FolderReads;
}): ResolvedTranscript {
    const locate: LocateRoots = { injected: roots, resolved: { ...defaultTranscriptRoots(), ...roots } };

    // An existing absolute path (a sub-agent's agent-<id>.jsonl, a worker turn file) is the answer
    // as it is: its provider comes from the root it lives under.
    if (isAbsolute(query) && existsSync(query)) {
        const byPath = resolvePath(query, locate, provider);
        if (!byPath) {
            throw new Error(`"${query}" is under no known transcript root; pass --provider to read it`);
        }

        return byPath;
    }

    // The search order of the providers when none is given (the canonical harness order); ties in `mtime` keep it.
    const searched: readonly TranscriptProvider[] = provider ? [provider] : ACCOUNT_PROVIDER_ALIASES;
    const hits: RankedHit[] = searched.flatMap((name) => harnessLocate(name).find(query, locate, fs));
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
