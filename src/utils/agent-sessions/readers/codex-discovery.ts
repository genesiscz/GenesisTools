import { Database } from "bun:sqlite";
import { readdir, readFile, realpath } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { FileIdentityCache, fileIdentity } from "@genesiscz/utils/fs/identity-cache";
import { type EdgeLines, readFirstLines } from "@genesiscz/utils/fs/read-lines";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { isObject } from "@genesiscz/utils/object";
import { profiler } from "@genesiscz/utils/profile";
import { toolDataDir } from "@genesiscz/utils/storage/root";
import { type HistoryDiscoveryOptions, walkSourceRoots } from "../source-discovery";
import { asRecord, type JsonRecord, type JsonValue, scanJsonlRecords, text } from "../source-scan";
import type { AgentSession, NativeSessionSource, NativeSourceIssue } from "../types";
import {
    type CodexProjectionIndex,
    parseCodexHeaderRow,
    readCodexProjectionFingerprint,
    readCodexProjectionIndex,
} from "./codex";

interface CodexDiscoveryHeader {
    nativeId: string;
    parentNativeId?: string;
    cwd?: string;
    historyMode: string;
    isSubagent: boolean;
    gitBranch?: string;
}

interface IndexedMetadata {
    metadata: Partial<AgentSession<"codex">>;
    fingerprint: string;
}

function nativeDate(value: JsonValue | undefined): Date | undefined {
    const parsed =
        typeof value === "number" ? new Date(value < 10_000_000_000 ? value * 1000 : value) : new Date(text(value));
    return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

function sourceHome(root: string): string {
    return ["sessions", "archived_sessions"].includes(basename(root)) ? dirname(root) : root;
}

function columns(database: Database, table: string): string[] {
    return (database.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(
        (column) => column.name
    );
}

function isDiscoveryHeader(value: unknown): value is CodexDiscoveryHeader {
    return (
        isObject(value) &&
        typeof value.nativeId === "string" &&
        typeof value.historyMode === "string" &&
        typeof value.isSubagent === "boolean" &&
        (value.parentNativeId === undefined || typeof value.parentNativeId === "string") &&
        (value.cwd === undefined || typeof value.cwd === "string") &&
        (value.gitBranch === undefined || typeof value.gitBranch === "string")
    );
}

/**
 * Found headers by rollout path, reused only while the file's identity (inode, size, mtime, ctime) is unchanged. Any
 * write moves the ctime, so an append re-reads the header too: a rewrite beyond the header can look like an append.
 * A missing or broken header is never cached: it is read again, and its issue reported again, on every discovery.
 * Kept on disk too: a new process (the usage daemon's tick, a CLI call) opened all 308 rollouts to read headers no
 * one had changed, 77 ms of a 321 ms row build (`tools ts profile`, 2026-10-12). Bump the version when
 * `CodexDiscoveryHeader` or `parseCodexHeaderRow` changes what a header means.
 */
const headerCache = new FileIdentityCache<CodexDiscoveryHeader>({
    limit: 10_000,
    persist: {
        path: () => toolDataDir("agent-sessions", "cache", "codex-headers.json"),
        version: 1,
        isValue: isDiscoveryHeader,
    },
});

/** Forgets the header cache, as a new process with no saved file would. For tests. */
export function __forgetCodexHeaderCacheForTests(): void {
    headerCache.forget();
}

async function readHeader(options: {
    path: string;
    root: string;
    issues: NativeSourceIssue[];
    incompleteRoots: Set<string>;
}): Promise<CodexDiscoveryHeader | undefined> {
    const identity = fileIdentity(options.path);
    const cached = headerCache.get(options.path, identity);
    if (cached) {
        return cached;
    }

    const header = await readHeaderUncached(options);
    if (header && identity) {
        headerCache.set(options.path, identity, header);
    }

    return header;
}

/**
 * The rollout's first lines, or null when the file cannot be opened (the stream scan then reads it and reports why).
 * A cold listing opened a stream per rollout to find its first line: 308 streams were about a third of a fresh
 * `ai usage sessions` in a CPU profile (2026-10-12). `readFirstLines` is one synchronous read of 64 KB.
 */
function headerLines(path: string): EdgeLines | null {
    try {
        return readFirstLines(path);
    } catch (err) {
        logger.debug({ err, path }, "[codex-discovery] rollout start unreadable; scanning the rollout");
        return null;
    }
}

/** What one row says about the header: found, a `session_meta` row without an id, or nothing (read on). */
function headerVerdict(row: JsonRecord): { header: CodexDiscoveryHeader } | "missing id" | undefined {
    const header = parseCodexHeaderRow(row);

    if (!header) {
        return row.type === "session_meta" ? "missing id" : undefined;
    }

    return {
        header: {
            nativeId: header.nativeId,
            ...(header.parentNativeId ? { parentNativeId: header.parentNativeId } : {}),
            ...(header.cwd ? { cwd: header.cwd } : {}),
            historyMode: header.historyMode,
            isSubagent: header.isSubagent,
            ...(header.gitBranch ? { gitBranch: header.gitBranch } : {}),
        },
    };
}

async function readHeaderUncached(options: {
    path: string;
    root: string;
    issues: NativeSourceIssue[];
    incompleteRoots: Set<string>;
}): Promise<CodexDiscoveryHeader | undefined> {
    const issue = (message: string) => {
        options.issues.push({ path: options.path, message });
        options.incompleteRoots.add(options.root);
    };
    const settle = (verdict: { header: CodexDiscoveryHeader } | "missing id") => {
        if (verdict === "missing id") {
            issue("Native session header missing id");
            return undefined;
        }

        return verdict.header;
    };
    const prefix = headerLines(options.path);
    let prefixParsed = prefix !== null;

    for (const line of prefix?.lines ?? []) {
        let row: JsonRecord;

        try {
            const value: JsonValue = SafeJSON.parse(line, { strict: true });
            row = asRecord(value);
        } catch {
            // The stream scan reads the file again and reports this line the way it always has.
            prefixParsed = false;
            break;
        }

        const verdict = headerVerdict(row);

        if (verdict) {
            return settle(verdict);
        }
    }

    if (prefixParsed && prefix?.wholeFile) {
        issue("Native session header missing");
        return undefined;
    }

    for await (const scanned of scanJsonlRecords({
        path: options.path,
        onIssue: (found) => {
            options.issues.push(found);
            options.incompleteRoots.add(options.root);
        },
    })) {
        const verdict = headerVerdict(asRecord(scanned.value));
        if (verdict) {
            return settle(verdict);
        }
    }
    issue("Native session header missing");
}

async function metadataPathsForHome(options: {
    home: string;
    root: string;
    issues: NativeSourceIssue[];
    incompleteRoots: Set<string>;
}): Promise<string[]> {
    try {
        const names = await readdir(options.home);
        const paths: string[] = [];
        for (const name of names.sort()) {
            if (!/^(?:state|thread_history)(?:_\d+)?\.sqlite(?:-wal)?$/.test(name) && name !== "session_index.jsonl") {
                continue;
            }
            const unresolved = join(options.home, name);
            try {
                paths.push(await realpath(unresolved));
            } catch {
                options.issues.push({ path: unresolved, message: "Codex metadata sidecar read failed" });
                options.incompleteRoots.add(options.root);
            }
        }
        return paths;
    } catch {
        options.issues.push({ path: options.home, message: "Codex metadata home read failed" });
        options.incompleteRoots.add(options.root);
        return [];
    }
}

async function readSessionIndex(options: {
    path: string | undefined;
    root: string;
    issues: NativeSourceIssue[];
    incompleteRoots: Set<string>;
}): Promise<Map<string, IndexedMetadata>> {
    const values = new Map<string, IndexedMetadata>();
    if (!options.path) {
        return values;
    }
    let raw: string;
    try {
        raw = await readFile(options.path, "utf8");
    } catch {
        options.issues.push({ path: options.path, message: "Codex session index read failed" });
        options.incompleteRoots.add(options.root);
        return values;
    }
    for (const [index, original] of raw.split("\n").entries()) {
        if (!original.trim()) {
            continue;
        }
        let row: JsonRecord;
        try {
            row = asRecord(SafeJSON.parse(original, { strict: true }) as JsonValue);
        } catch {
            options.issues.push({
                path: options.path,
                message: `Malformed Codex session index record at line ${index + 1}`,
            });
            options.incompleteRoots.add(options.root);
            continue;
        }
        const nativeId = text(row.id ?? row.session_id);
        if (!nativeId) {
            continue;
        }
        const title = text(row.thread_name ?? row.title);
        const updated = nativeDate(row.updated_at);
        const previous = values.get(nativeId);
        if (previous?.metadata.mtime && updated && updated < previous.metadata.mtime) {
            continue;
        }
        values.set(nativeId, {
            metadata: {
                sessionId: nativeId,
                ...(title ? { title } : {}),
                ...(updated ? { mtime: updated } : {}),
            },
            fingerprint: original,
        });
    }
    return values;
}

/**
 * Every thread's state row from a home's `state*.sqlite` files, one read per database. The
 * per-rollout form opened each database and ran a PRAGMA plus a lookup per file: 364 opens on
 * this machine for every listing. The metadata and the fingerprint a thread gets are the same.
 */
function readStateIndex(options: {
    paths: string[];
    root: string;
    issues: NativeSourceIssue[];
    incompleteRoots: Set<string>;
}): Map<string, IndexedMetadata> {
    const index = new Map<string, IndexedMetadata>();
    for (const path of options.paths.filter(
        (candidate) => /state(?:_\d+)?\.sqlite$/.test(candidate) && !candidate.endsWith("-wal")
    )) {
        let database: Database | undefined;
        try {
            database = new Database(path, { readonly: true });
            const available = columns(database, "threads");
            if (!available.includes("id")) {
                continue;
            }
            const selected = ["title", "cwd", "updated_at", "created_at", "archived"].filter((name) =>
                available.includes(name)
            );
            if (selected.length === 0) {
                continue;
            }
            const rows = database.query(`SELECT id, ${selected.join(", ")} FROM threads`).all() as JsonRecord[];
            for (const row of rows) {
                const nativeId = text(row.id);
                if (!nativeId) {
                    continue;
                }
                // The selected columns only, in SELECT order: the fingerprint must equal the one
                // the per-thread `SELECT ${selected} ... WHERE id = ?` produced.
                const picked: JsonRecord = {};
                for (const name of selected) {
                    picked[name] = row[name];
                }
                index.set(nativeId, {
                    metadata: {
                        sessionId: nativeId,
                        ...(text(picked.title) ? { title: text(picked.title) } : {}),
                        ...(text(picked.cwd) ? { cwd: text(picked.cwd) } : {}),
                        ...(nativeDate(picked.updated_at) ? { mtime: nativeDate(picked.updated_at) } : {}),
                        ...(nativeDate(picked.created_at) ? { createdAt: nativeDate(picked.created_at) } : {}),
                        ...(picked.archived === undefined ? {} : { archived: Boolean(picked.archived) }),
                    },
                    fingerprint: SafeJSON.stringify(picked, { strict: true }),
                });
            }
        } catch {
            options.issues.push({ path, message: "Codex state metadata read failed" });
            options.incompleteRoots.add(options.root);
        } finally {
            database?.close();
        }
    }
    return index;
}

function mergeMetadata(
    header: CodexDiscoveryHeader,
    state: IndexedMetadata | undefined,
    indexed: IndexedMetadata | undefined,
    archived: boolean
): Partial<AgentSession<"codex">> {
    return {
        sessionId: header.nativeId,
        ...(indexed?.metadata.title ? { title: indexed.metadata.title } : {}),
        ...(state?.metadata.title ? { title: state.metadata.title } : {}),
        ...(state?.metadata.cwd ? { cwd: state.metadata.cwd } : {}),
        ...(header.cwd ? { cwd: header.cwd } : {}),
        ...(state?.metadata.mtime ? { mtime: state.metadata.mtime } : {}),
        ...(indexed?.metadata.mtime ? { mtime: indexed.metadata.mtime } : {}),
        ...(state?.metadata.createdAt ? { createdAt: state.metadata.createdAt } : {}),
        archived: archived || state?.metadata.archived === true,
        isSubagent: header.isSubagent,
        ...(header.gitBranch ? { gitBranch: header.gitBranch } : {}),
    };
}

export async function discoverCodexHistorySources(
    roots: string[],
    options: HistoryDiscoveryOptions = {}
): Promise<{
    sources: Array<NativeSessionSource<"codex">>;
    issues: NativeSourceIssue[];
    completeRoots: string[];
}> {
    const filtered = options.excludeAgents === true || options.agentsOnly === true || options.project !== undefined;
    await headerCache.load();
    const walked = await walkSourceRoots({
        roots,
        filtered,
        signal: options.signal,
        includeFile: ({ path }) => basename(path).startsWith("rollout-") && path.endsWith(".jsonl"),
    });
    const issues = [...walked.issues];
    const incompleteRoots = new Set<string>();
    const pathsByHome = new Map<string, string[]>();
    const indexByHome = new Map<string, Map<string, IndexedMetadata>>();
    const stateByHome = new Map<string, Map<string, IndexedMetadata>>();
    const projectionByHome = new Map<string, CodexProjectionIndex>();
    const sources: Array<NativeSessionSource<"codex">> = [];

    for (const file of walked.files) {
        const home = sourceHome(file.root);
        let metadataPaths = pathsByHome.get(home);
        if (!metadataPaths) {
            metadataPaths = await metadataPathsForHome({
                home,
                root: file.root,
                issues,
                incompleteRoots,
            });
            pathsByHome.set(home, metadataPaths);
        }
        let sessionIndex = indexByHome.get(home);
        if (!sessionIndex) {
            sessionIndex = await readSessionIndex({
                path: metadataPaths.find((path) => basename(path) === "session_index.jsonl"),
                root: file.root,
                issues,
                incompleteRoots,
            });
            indexByHome.set(home, sessionIndex);
        }
        const header = await readHeader({
            path: file.path,
            root: file.root,
            issues,
            incompleteRoots,
        });
        if (!header) {
            continue;
        }
        if (options.agentsOnly && !header.isSubagent) {
            continue;
        }
        if (options.excludeAgents && header.isSubagent) {
            continue;
        }
        if (options.project && header.cwd) {
            const project = header.cwd.split(/[\\/]/).filter(Boolean).pop();
            if (project !== options.project && header.cwd !== options.project) {
                continue;
            }
        }

        let stateIndex = stateByHome.get(home);
        if (!stateIndex) {
            const paths = metadataPaths;
            const readState = () => readStateIndex({ paths, root: file.root, issues, incompleteRoots });
            stateIndex = profiler.scope("agent-sessions").measure("discover.codex-state-sqlite", readState);
            stateByHome.set(home, stateIndex);
        }
        const state = stateIndex.get(header.nativeId);
        const indexed = sessionIndex.get(header.nativeId);
        const metadata = mergeMetadata(header, state, indexed, basename(file.root) === "archived_sessions");
        const source: NativeSessionSource<"codex"> = {
            kind: "codex",
            root: file.root,
            sourceHome: home,
            filePath: file.path,
            dataPaths: [file.path],
            metadataPaths,
            ...(header.historyMode === "paginated" ? {} : { searchPaths: [file.path] }),
            metadata,
        };
        let projection: string | undefined;
        if (header.historyMode === "paginated") {
            let projectionIndex = projectionByHome.get(home);
            if (!projectionIndex) {
                const paths = metadataPaths;
                const readProjection = () =>
                    readCodexProjectionIndex(paths, (path) => {
                        issues.push({ path, message: "Projection fingerprint read failed" });
                        incompleteRoots.add(file.root);
                    });
                projectionIndex = await profiler
                    .scope("agent-sessions")
                    .measureAsync("discover.codex-projection-sqlite", readProjection);
                projectionByHome.set(home, projectionIndex);
            }
            projection = await readCodexProjectionFingerprint(source, {
                nativeId: header.nativeId,
                projection: projectionIndex,
                onIssue: (issue) => {
                    issues.push(issue);
                    incompleteRoots.add(file.root);
                },
            });
        }
        source.metadataFingerprint = SafeJSON.stringify(
            {
                nativeId: header.nativeId,
                parentNativeId: header.parentNativeId,
                historyMode: header.historyMode,
                state: state?.fingerprint,
                sessionIndex: indexed?.fingerprint,
                projection,
            },
            { strict: true }
        );
        sources.push(source);
    }

    await headerCache.save();
    return {
        sources,
        issues,
        completeRoots: walked.completeRoots.filter((root) => !incompleteRoots.has(root)),
    };
}
