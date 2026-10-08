import { Database } from "bun:sqlite";
import { open, readdir, readFile, realpath } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { profiler } from "@genesiscz/utils/profile";
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

/**
 * Found headers by rollout path. A rollout is append-only and its header is one of its first lines, so a file with
 * the same inode that has not shrunk and still begins with the same bytes (the session id is in them) still starts
 * with it. Every listing read ~700 headers through a stream, about a sixth of a warm `ai usage sessions`
 * (2026-10-08). A missing or broken header is never cached: it is read again, and its issue reported again, on every
 * discovery.
 */
const HEADER_CACHE_LIMIT = 10_000;
const HEADER_MARK_BYTES = 256;
const headerCache = new Map<string, { ino: number; size: number; mark: string; header: CodexDiscoveryHeader }>();

/** The file's inode, size and first bytes, or null when it cannot be read (the full read then reports why). */
async function headerIdentity(path: string): Promise<{ ino: number; size: number; mark: string } | null> {
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
        handle = await open(path, "r");
        const status = await handle.stat();
        const buffer = Buffer.alloc(Math.min(HEADER_MARK_BYTES, status.size));
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
        return { ino: status.ino, size: status.size, mark: buffer.subarray(0, bytesRead).toString("latin1") };
    } catch (err) {
        logger.debug({ err, path }, "[codex-discovery] header identity unreadable; reading the header in full");
        return null;
    } finally {
        await handle?.close().catch(() => undefined);
    }
}

async function readHeader(options: {
    path: string;
    root: string;
    issues: NativeSourceIssue[];
    incompleteRoots: Set<string>;
}): Promise<CodexDiscoveryHeader | undefined> {
    const identity = await headerIdentity(options.path);
    const cached = headerCache.get(options.path);
    if (
        identity &&
        cached &&
        cached.ino === identity.ino &&
        identity.size >= cached.size &&
        identity.mark.startsWith(cached.mark)
    ) {
        return cached.header;
    }

    const header = await readHeaderUncached(options);
    if (header && identity) {
        headerCache.delete(options.path);
        headerCache.set(options.path, { ...identity, header });
        if (headerCache.size > HEADER_CACHE_LIMIT) {
            const oldest = headerCache.keys().next().value;
            if (oldest !== undefined) {
                headerCache.delete(oldest);
            }
        }
    }

    return header;
}

async function readHeaderUncached(options: {
    path: string;
    root: string;
    issues: NativeSourceIssue[];
    incompleteRoots: Set<string>;
}): Promise<CodexDiscoveryHeader | undefined> {
    for await (const scanned of scanJsonlRecords({
        path: options.path,
        onIssue: (issue) => {
            options.issues.push(issue);
            options.incompleteRoots.add(options.root);
        },
    })) {
        const row = asRecord(scanned.value);
        const header = parseCodexHeaderRow(row);

        if (!header) {
            if (row.type === "session_meta") {
                options.issues.push({ path: options.path, message: "Native session header missing id" });
                options.incompleteRoots.add(options.root);
                return;
            }

            continue;
        }

        return {
            nativeId: header.nativeId,
            ...(header.parentNativeId ? { parentNativeId: header.parentNativeId } : {}),
            ...(header.cwd ? { cwd: header.cwd } : {}),
            historyMode: header.historyMode,
            isSubagent: header.isSubagent,
            ...(header.gitBranch ? { gitBranch: header.gitBranch } : {}),
        };
    }
    options.issues.push({ path: options.path, message: "Native session header missing" });
    options.incompleteRoots.add(options.root);
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

    return {
        sources,
        issues,
        completeRoots: walked.completeRoots.filter((root) => !incompleteRoots.has(root)),
    };
}
