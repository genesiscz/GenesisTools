import { open, readFile, stat } from "node:fs/promises";
import { basename, dirname, join, sep } from "node:path";
import { bytesEqualStreaming } from "@genesiscz/utils/fs/disk-usage";
import { SafeJSON } from "@genesiscz/utils/json";
import { profiler } from "@genesiscz/utils/profile";
import { historyProjectMatches } from "../project-scope";
import { type HistoryDiscoveryOptions, walkSourceRoots } from "../source-discovery";
import { asRecord, date, type JsonRecord, type JsonValue, text } from "../source-scan";
import type { AgentSession, NativeSessionSource, NativeSourceIssue } from "../types";
import { isClaudeSubagentPath } from "./claude-paths";

function sourceHome(root: string): string {
    return basename(root) === "projects" ? dirname(root) : root;
}

const isSubagentPath = isClaudeSubagentPath;

/** Record types that make a file a transcript rather than a sidecar of one. */
const CONVERSATION_TYPES = new Set(["user", "assistant", "summary", "system"]);
const STUB_MAX_BYTES = 64 * 1024;

/**
 * True when the file holds only sidecar records (titles, agent name, modes) and no turn. Bounded
 * by size so a real transcript is never read whole to answer this. The read itself is capped
 * too: a turn appended between the stat and the read grows the file past the stub limit, and
 * one byte over it is answered from the bound, not from a whole transcript (PR #383 review).
 */
async function isMetadataStub(path: string, size: number): Promise<boolean> {
    if (size > STUB_MAX_BYTES) {
        return false;
    }

    const content = await readBounded(path, STUB_MAX_BYTES);

    if (content === null) {
        return false;
    }

    for (const line of content.split("\n")) {
        if (!line.trim()) {
            continue;
        }

        let record: JsonValue;
        try {
            record = SafeJSON.parse(line, { strict: true });
        } catch {
            return false;
        }

        const type = asRecord(record).type;

        if (typeof type !== "string" || CONVERSATION_TYPES.has(type)) {
            return false;
        }
    }

    return true;
}

/** The first `maxBytes` of a file, or null when it holds more than that. */
export async function readBounded(path: string, maxBytes: number): Promise<string | null> {
    const handle = await open(path, "r");

    try {
        const buffer = Buffer.alloc(maxBytes + 1);
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);

        return bytesRead > maxBytes ? null : buffer.toString("utf8", 0, bytesRead);
    } finally {
        await handle.close();
    }
}

function indexMetadata(entry: JsonRecord): Partial<AgentSession<"claude">> {
    return {
        ...(text(entry.sessionId) ? { sessionId: text(entry.sessionId) } : {}),
        ...(text(entry.customTitle) ? { title: text(entry.customTitle) } : {}),
        ...(text(entry.summary) ? { summary: text(entry.summary) } : {}),
        ...(text(entry.projectPath) ? { cwd: text(entry.projectPath) } : {}),
        ...(date(entry.modified) ? { mtime: date(entry.modified) } : {}),
        ...(date(entry.created) ? { createdAt: date(entry.created) } : {}),
    };
}

async function readProjectIndex(options: {
    path: string;
    root: string;
    issues: NativeSourceIssue[];
    incompleteRoots: Set<string>;
}): Promise<Map<string, { entry: JsonRecord; fingerprint: string }>> {
    let raw: string;
    try {
        raw = await readFile(options.path, "utf8");
    } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") {
            return new Map();
        }
        options.issues.push({ path: options.path, message: "Claude session index read failed" });
        options.incompleteRoots.add(options.root);
        return new Map();
    }
    let parsed: JsonRecord;
    try {
        parsed = asRecord(SafeJSON.parse(raw, { strict: true }) as JsonValue);
    } catch {
        options.issues.push({ path: options.path, message: "Claude session index malformed" });
        options.incompleteRoots.add(options.root);
        return new Map();
    }
    const entries = Array.isArray(parsed.entries) ? parsed.entries : [];
    const result = new Map<string, { entry: JsonRecord; fingerprint: string }>();
    for (const value of entries) {
        const entry = asRecord(value);
        const sessionId = text(entry.sessionId);
        if (!sessionId) {
            continue;
        }
        result.set(sessionId, {
            entry,
            fingerprint: SafeJSON.stringify(entry, { strict: true }),
        });
    }
    return result;
}

export async function discoverClaudeHistorySources(
    roots: string[],
    options: HistoryDiscoveryOptions = {}
): Promise<{
    sources: Array<NativeSessionSource<"claude">>;
    issues: NativeSourceIssue[];
    completeRoots: string[];
    displaced: string[];
}> {
    const filtered = options.excludeAgents === true || options.agentsOnly === true || options.project !== undefined;
    const shallowMainOnly = options.excludeAgents === true && options.agentsOnly !== true;
    const walked = await walkSourceRoots({
        roots,
        filtered,
        signal: options.signal,
        ...(shallowMainOnly ? { maxDepth: 1 } : {}),
        includeFile: ({ path, relativePath }) =>
            path.endsWith(".jsonl") &&
            basename(path) !== "sessions-index.jsonl" &&
            !(basename(path) === "journal.jsonl" && relativePath.split(sep).includes("workflows")),
    });

    let files = walked.files;
    if (options.project) {
        const requested = options.project;
        files = files.filter((file) =>
            historyProjectMatches({
                providerId: "anthropic-sub",
                projectDirectory: file.relativePath.split(sep)[0],
                requested,
            })
        );
    }
    files = files.filter((file) => {
        const subagent = isSubagentPath(file.path);
        if (options.agentsOnly) {
            return subagent;
        }
        if (options.excludeAgents) {
            return !subagent;
        }
        return true;
    });

    const issues = [...walked.issues];
    const displaced: string[] = [];
    const incompleteRoots = new Set<string>();
    const mainGroups = new Map<string, (typeof files)[number][]>();

    for (const file of files.filter((candidate) => !isSubagentPath(candidate.path))) {
        const key = `${sourceHome(file.root)}\0${basename(file.path)}`;
        const group = mainGroups.get(key) ?? [];
        group.push(file);
        mainGroups.set(key, group);
    }
    const retainedMains = new Set<string>();

    for (const group of mainGroups.values()) {
        const first = group[0];

        if (group.length === 1 && first) {
            retainedMains.add(first.path);
            continue;
        }

        // Each candidate is stat'ed and read up to the stub bound, and a size tie below costs a
        // full byte-for-byte compare. Gated: it fires per duplicate group, not per corpus.
        const rank = () =>
            Promise.all(
                group.map(async (file) => {
                    const stats = await stat(file.path);
                    return { file, stats, stub: await isMetadataStub(file.path, stats.size) };
                })
            );
        const ranked =
            profiler.detail === "all"
                ? await profiler.scope("agent-sessions").measureAsync("discover.claude-dedup-group", rank)
                : await rank();
        // A copy that holds conversation outranks a sidecar stub whatever their sizes: a stub
        // with a long title used to beat a short real transcript on bytes alone.
        ranked.sort(
            (left, right) =>
                Number(left.stub) - Number(right.stub) ||
                right.stats.size - left.stats.size ||
                right.stats.mtimeMs - left.stats.mtimeMs ||
                left.file.path.localeCompare(right.file.path)
        );
        const selected = ranked[0];

        if (selected) {
            // `slice(1)`: the winner compared against itself read the whole transcript twice to
            // prove a tautology, on the duplicate path that already pays for byte comparisons.
            const copiesAgree = ranked
                .slice(1)
                .every(
                    (candidate) =>
                        candidate.stats.size === selected.stats.size &&
                        bytesEqualStreaming(candidate.file.path, selected.file.path, { signal: options.signal })
                );

            for (const candidate of ranked.slice(1)) {
                displaced.push(candidate.file.path);
            }

            if (!copiesAgree) {
                // Claude Code writes the same session id under a second encoded project directory
                // whenever the cwd moves (a worktree, a renamed checkout), usually leaving a stub
                // beside the real transcript. Refusing every copy hid the whole conversation from
                // search and resume, so keep the ranked winner (largest, then newest) and report
                // the copies it displaced.
                // The root stays complete: a winner was chosen, so nothing about this scan is
                // unresolved. Marking it incomplete emptied completeRoots forever, which stopped
                // pruning, froze statistics at partial coverage and made every read open a write
                // transaction.
                for (const candidate of ranked.slice(1)) {
                    // A sidecar stub (agent-name, custom-title, ai-title, mode lines, no turn at all)
                    // is what the cwd move leaves behind every time; it is not a divergent
                    // transcript and warned on every search for months (7 of 7 on the live corpus,
                    // 2026-09-10). Only a copy that carries conversation of its own is reported.
                    if (candidate.stub) {
                        continue;
                    }

                    issues.push({
                        path: candidate.file.path,
                        message: `Divergent live file claims the same Claude session identity; indexing ${selected.file.path} instead`,
                    });
                }
            }

            retainedMains.add(selected.file.path);
        }
    }

    files = files.filter((file) => isSubagentPath(file.path) || retainedMains.has(file.path));

    const indexCache = new Map<string, Map<string, { entry: JsonRecord; fingerprint: string }>>();
    const existingIndexes = new Set<string>();
    const sources: Array<NativeSessionSource<"claude">> = [];
    for (const file of files) {
        const parts = file.relativePath.split(sep);
        const projectDirectory = parts.length > 1 ? parts[0] : "";
        const indexPath = join(file.root, projectDirectory, "sessions-index.json");
        let index = indexCache.get(indexPath);
        if (!index) {
            index = await readProjectIndex({
                path: indexPath,
                root: file.root,
                issues,
                incompleteRoots,
            });
            indexCache.set(indexPath, index);
            try {
                await stat(indexPath);
                existingIndexes.add(indexPath);
            } catch {
                // readProjectIndex already reports inaccessible or malformed indexes.
            }
        }
        const nativeId = basename(file.path, ".jsonl");
        const indexed = isSubagentPath(file.path) ? undefined : index.get(nativeId);
        sources.push({
            kind: "claude",
            root: file.root,
            sourceHome: sourceHome(file.root),
            filePath: file.path,
            dataPaths: [file.path],
            metadataPaths: existingIndexes.has(indexPath) ? [indexPath] : [],
            searchPaths: [file.path],
            ...(indexed ? { metadataFingerprint: indexed.fingerprint } : {}),
            metadata: { ...(indexed ? indexMetadata(indexed.entry) : {}), isSubagent: isSubagentPath(file.path) },
        });
    }

    return {
        sources,
        issues,
        completeRoots: walked.completeRoots.filter((root) => !incompleteRoots.has(root)),
        displaced,
    };
}
