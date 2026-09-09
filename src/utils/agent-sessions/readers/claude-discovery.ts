import { readFile, stat } from "node:fs/promises";
import { basename, dirname, join, sep } from "node:path";
import { bytesEqualStreaming } from "@genesiscz/utils/fs/disk-usage";
import { SafeJSON } from "@genesiscz/utils/json";
import { historyProjectMatches } from "../project-scope";
import { type HistoryDiscoveryOptions, walkSourceRoots } from "../source-discovery";
import { asRecord, date, type JsonRecord, type JsonValue, text } from "../source-scan";
import type { AgentSession, NativeSessionSource, NativeSourceIssue } from "../types";
import { isClaudeSubagentPath } from "./claude-paths";

function sourceHome(root: string): string {
    return basename(root) === "projects" ? dirname(root) : root;
}

const isSubagentPath = isClaudeSubagentPath;

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

        const ranked = await Promise.all(group.map(async (file) => ({ file, stats: await stat(file.path) })));
        ranked.sort(
            (left, right) =>
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
    };
}
