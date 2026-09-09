import { readFile, realpath } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { type HistoryDiscoveryOptions, walkSourceRoots } from "../source-discovery";
import { asRecord, date, type JsonRecord, type JsonValue, text } from "../source-scan";
import type { AgentSession, NativeSessionSource, NativeSourceIssue } from "../types";

interface GrokSummaryRead {
    path?: string;
    metadata?: Partial<AgentSession<"grok">>;
    fingerprint?: string;
}

function sourceHome(root: string): string {
    return basename(root) === "sessions" ? dirname(root) : root;
}

function layoutCwd(chatPath: string): string | undefined {
    const encoded = basename(dirname(dirname(chatPath)));
    if (!encoded) {
        return;
    }
    try {
        return decodeURIComponent(encoded);
    } catch {
        return encoded;
    }
}

function isWorkerRoot(root: string): boolean {
    return root.split(/[\\/]/).some((part) => part.includes("worker"));
}

async function readSummary(options: {
    directory: string;
    root: string;
    worker: boolean;
    issues: NativeSourceIssue[];
    incompleteRoots: Set<string>;
}): Promise<GrokSummaryRead> {
    const unresolved = join(options.directory, "summary.json");
    let path: string;
    try {
        path = await realpath(unresolved);
    } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") {
            return {};
        }
        options.issues.push({ path: unresolved, message: "Grok summary metadata read failed" });
        options.incompleteRoots.add(options.root);
        return {};
    }
    let raw: string;
    try {
        raw = await readFile(path, "utf8");
    } catch {
        options.issues.push({ path, message: "Grok summary metadata read failed" });
        options.incompleteRoots.add(options.root);
        return { path };
    }
    let summary: JsonRecord;
    try {
        summary = asRecord(SafeJSON.parse(raw, { strict: true }) as JsonValue);
    } catch {
        options.issues.push({ path, message: "Grok summary metadata malformed" });
        options.incompleteRoots.add(options.root);
        return { path };
    }
    const info = asRecord(summary.info);
    const nativeId = text(info.id);
    const cwd = text(info.cwd);
    const title = text(summary.generated_title);
    const summaryText = text(summary.session_summary);
    const updated = date(summary.updated_at ?? summary.created_at);
    const created = date(summary.created_at);
    return {
        path,
        metadata: {
            ...(nativeId ? { sessionId: nativeId } : {}),
            ...(cwd ? { cwd } : {}),
            ...(title ? { title } : {}),
            ...(summaryText ? { summary: summaryText } : {}),
            ...(updated ? { mtime: updated } : {}),
            ...(created ? { createdAt: created } : {}),
            isSubagent: options.worker,
        },
        fingerprint: raw,
    };
}

export async function discoverGrokHistorySources(
    roots: string[],
    options: HistoryDiscoveryOptions = {}
): Promise<{
    sources: Array<NativeSessionSource<"grok">>;
    issues: NativeSourceIssue[];
    completeRoots: string[];
}> {
    const filtered = options.excludeAgents === true || options.agentsOnly === true || options.project !== undefined;
    const walked = await walkSourceRoots({
        roots,
        filtered,
        signal: options.signal,
        includeFile: ({ path }) => ["chat_history.jsonl", "chatHistory.jsonl"].includes(basename(path)),
    });
    const issues = [...walked.issues];
    const incompleteRoots = new Set<string>();
    const byDirectory = new Map<string, { root: string; snake?: string; camel?: string }>();
    for (const file of walked.files) {
        const directory = dirname(file.path);
        const entry = byDirectory.get(directory) ?? { root: file.root };
        if (basename(file.path) === "chat_history.jsonl") {
            entry.snake = file.path;
        } else {
            entry.camel = file.path;
        }
        byDirectory.set(directory, entry);
    }

    const sources: Array<NativeSessionSource<"grok">> = [];
    for (const [directory, chat] of [...byDirectory.entries()].sort(([left], [right]) => left.localeCompare(right))) {
        const worker = isWorkerRoot(chat.root);
        if (options.agentsOnly && !worker) {
            continue;
        }
        if (options.excludeAgents && worker) {
            continue;
        }
        const chatPath = chat.snake ?? chat.camel;
        if (!chatPath) {
            continue;
        }
        const summary = await readSummary({
            directory,
            root: chat.root,
            worker,
            issues,
            incompleteRoots,
        });
        const cwd = summary.metadata?.cwd ?? layoutCwd(chatPath);
        if (options.project && cwd) {
            const project = cwd.split(/[\\/]/).filter(Boolean).pop();
            if (project !== options.project && cwd !== options.project) {
                continue;
            }
        }
        sources.push({
            kind: "grok",
            root: chat.root,
            sourceHome: sourceHome(chat.root),
            filePath: chatPath,
            dataPaths: [chatPath],
            metadataPaths: summary.path ? [summary.path] : [],
            searchPaths: [chatPath],
            statisticsPaths: [join(dirname(chatPath), "updates.jsonl")],
            ...(summary.metadata
                ? {
                      metadata: {
                          ...summary.metadata,
                          ...(cwd ? { cwd } : {}),
                      },
                  }
                : {}),
            ...(summary.fingerprint ? { metadataFingerprint: summary.fingerprint } : {}),
        });
    }

    return {
        sources,
        issues,
        completeRoots: walked.completeRoots.filter((root) => !incompleteRoots.has(root)),
    };
}
