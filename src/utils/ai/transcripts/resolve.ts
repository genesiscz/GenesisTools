import { existsSync, readFileSync, realpathSync } from "node:fs";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";
import { ACCOUNT_PROVIDER_ALIASES, byHarnessWhere } from "@genesiscz/utils/ai/providers/alias-list";
import { harnessDriver } from "@genesiscz/utils/ai/providers/harness-index";
import { isDir, listDir, mtimeOf } from "@genesiscz/utils/ai/transcripts/resolve-core";
import { transcriptStem } from "@genesiscz/utils/providers/session-paths";
import type { TranscriptProvider } from "./types";

export type TranscriptSource = "native" | "worker";

/** The folders one harness keeps its transcripts in, as its locator reads them (`TranscriptLocator.defaultRoots`). */
export interface HarnessRoots {
    /** Where its native sessions sit: Claude's `projects` folders, the Codex homes, the Grok homes. */
    native: string[];
    /** The folder of its `tools <agent>` worker logs (Claude: `<name>.meta.json` + `<name>.turn<N>.jsonl`). */
    worker: string;
}

/**
 * The roots a caller injects, keyed by harness. A harness or a field it leaves out reads its locator's defaults, so a
 * test that fixes one harness's folders leaves the others at theirs.
 */
export type TranscriptRoots = { readonly [Provider in TranscriptProvider]?: Partial<HarnessRoots> };

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

/** One harness's roots for one lookup: what the caller injected, over its locator's defaults. */
export function harnessRootsOf(provider: TranscriptProvider, roots: TranscriptRoots = {}): HarnessRoots {
    return { ...harnessDriver(provider).parts.locate.defaultRoots(), ...roots[provider] };
}

/** Roots that read one harness's transcripts from one of its homes (a session's own source home) only. */
export function rootsOfHome(provider: TranscriptProvider, home: string): TranscriptRoots {
    return byHarnessWhere((id) => (id === provider ? harnessDriver(id).parts.locate.rootsOfHome(home) : undefined));
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
function resolvePath(path: string, roots: TranscriptRoots, provider?: TranscriptProvider): ResolvedTranscript | null {
    const filePath = resolve(path);
    const stem = transcriptStem(basename(filePath));
    const located = ACCOUNT_PROVIDER_ALIASES.flatMap((id) =>
        harnessDriver(id)
            .parts.locate.pathRoots(harnessRootsOf(id, roots))
            .map((entry) => ({ ...entry, provider: id }))
    );
    const hit = located.find((entry) => isInside(entry.root, filePath));

    if (!hit && !provider) {
        return null;
    }

    const resolvedProvider = provider ?? hit?.provider ?? "claude";
    const source = hit?.source ?? "native";

    return harnessDriver(resolvedProvider).parts.locate.sessionOfPath({ source, stem, filePath });
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
    const best = harnessDriver("codex")
        .parts.locate.find(threadId, harnessRootsOf("codex", roots), directReads)
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
    // An existing absolute path (a sub-agent's agent-<id>.jsonl, a worker turn file) is the answer
    // as it is: its provider comes from the root it lives under.
    if (isAbsolute(query) && existsSync(query)) {
        const byPath = resolvePath(query, roots, provider);
        if (!byPath) {
            throw new Error(`"${query}" is under no known transcript root; pass --provider to read it`);
        }

        return byPath;
    }

    // The search order of the providers when none is given (the canonical harness order); ties in `mtime` keep it.
    const searched: readonly TranscriptProvider[] = provider ? [provider] : ACCOUNT_PROVIDER_ALIASES;
    const hits: RankedHit[] = searched.flatMap((name) =>
        harnessDriver(name).parts.locate.find(query, harnessRootsOf(name, roots), fs)
    );
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
