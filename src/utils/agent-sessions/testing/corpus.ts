import { createHash } from "node:crypto";
import { mkdir, utimes, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import type { AgentKind } from "../types";
import { FIXED_HISTORY_NOW } from "./fixture-world";

export const HISTORY_CORPUS_VERSION = 1;
export const BENCHMARK_COMMON_QUERY = "benchmark-common-term";
export const BENCHMARK_ABSENT_QUERY = "benchmark-absent-term";

export interface HistoryCorpusOptions {
    root: string;
    seed: number;
    sessionCount: number;
    recordCount: number;
    distribution: {
        main: number;
        subagent: number;
    };
    now?: Date;
}

export interface HistoryCorpusSourceManifest {
    provider: AgentKind;
    relativePath: string;
    bytes: number;
    sha256: string;
}

export interface HistoryCorpusManifest {
    version: number;
    seed: number;
    logical: {
        sessions: number;
        records: number;
        main: number;
        subagent: number;
    };
    providers: Record<AgentKind, number>;
    queries: {
        common: string;
        rare: string;
        absent: string;
    };
    sessions: Array<{
        sessionId: string;
        parentId: string;
        cwd: string;
        timestamp: string;
        isSubagent: boolean;
    }>;
    totalBytes: number;
    sources: HistoryCorpusSourceManifest[];
}

interface LogicalSession {
    id: string;
    parentId: string;
    cwd: string;
    title: string;
    summary: string;
    isSubagent: boolean;
    timestamp: Date;
    records: Array<{ role: "user" | "assistant"; text: string; timestamp: string }>;
}

function validateOptions(options: HistoryCorpusOptions): string {
    const root = resolve(options.root);
    if (!isAbsolute(options.root)) {
        throw new Error("History corpus root must be absolute");
    }
    if (!Number.isSafeInteger(options.seed)) {
        throw new Error("History corpus seed must be a safe integer");
    }
    for (const [name, value] of Object.entries({
        sessionCount: options.sessionCount,
        recordCount: options.recordCount,
        main: options.distribution.main,
        subagent: options.distribution.subagent,
    })) {
        if (!Number.isSafeInteger(value) || value < 0) {
            throw new Error(`${name} must be a non-negative integer`);
        }
    }
    if (options.distribution.main + options.distribution.subagent !== options.sessionCount) {
        throw new Error("History corpus main/subagent distribution must equal sessionCount");
    }
    if (options.sessionCount > 0 && options.recordCount < options.sessionCount) {
        throw new Error("History corpus recordCount must provide at least one record per session");
    }

    return root;
}

function randomGenerator(seed: number): () => number {
    let state = seed >>> 0;
    return () => {
        state += 0x6d2b79f5;
        let value = state;
        value = Math.imul(value ^ (value >>> 15), value | 1);
        value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
        return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
    };
}

function sessionId(seed: number, index: number): string {
    const material = createHash("sha256").update(`history-corpus:${seed}:${index}`).digest("hex");
    return `${material.slice(0, 8)}-${material.slice(8, 12)}-4${material.slice(13, 16)}-8${material.slice(17, 20)}-${material.slice(20, 32)}`;
}

function buildSessions(options: HistoryCorpusOptions): LogicalSession[] {
    const random = randomGenerator(options.seed);
    const baseRecords = options.sessionCount === 0 ? 0 : Math.floor(options.recordCount / options.sessionCount);
    const extraRecords = options.sessionCount === 0 ? 0 : options.recordCount % options.sessionCount;
    const now = new Date(options.now ?? FIXED_HISTORY_NOW);

    return Array.from({ length: options.sessionCount }, (_, index) => {
        const id = sessionId(options.seed, index);
        const count = baseRecords + (index < extraRecords ? 1 : 0);
        const isSubagent = index >= options.distribution.main;
        const timestamp = new Date(now.getTime() - (options.sessionCount - index) * 60_000);
        const token = Math.floor(random() * 1_000_000).toString(36);
        const cwd = `/fixtures/project-${index % 3}`;
        return {
            id,
            parentId: sessionId(options.seed, index % Math.max(1, options.distribution.main)),
            cwd,
            title: `Invented session ${index} ${token}`,
            summary: `Synthetic summary ${token}`,
            isSubagent,
            timestamp,
            records: Array.from({ length: count }, (_, recordIndex) => ({
                role: recordIndex % 2 === 0 ? "user" : "assistant",
                text: [
                    `seed-${options.seed} session-${index} record-${recordIndex} token-${token}`,
                    recordIndex === 0 ? BENCHMARK_COMMON_QUERY : "",
                    index === 0 && recordIndex === 0 ? `benchmark-rare-${options.seed}` : "",
                ]
                    .filter(Boolean)
                    .join(" "),
                timestamp: new Date(timestamp.getTime() + recordIndex * 1_000).toISOString(),
            })),
        };
    });
}

function jsonLines(records: object[]): string {
    return `${records.map((record) => SafeJSON.stringify(record)).join("\n")}\n`;
}

function claudeContent(session: LogicalSession): string {
    return jsonLines(
        session.records.map((record, index) => ({
            type: record.role,
            sessionId: session.isSubagent ? session.parentId : session.id,
            cwd: session.cwd,
            gitBranch: "fixture-main",
            isSidechain: session.isSubagent,
            timestamp: record.timestamp,
            message: {
                role: record.role,
                content: record.role === "user" ? record.text : [{ type: "text", text: record.text }],
                ...(record.role === "assistant"
                    ? { model: "claude-sonnet-fixture", usage: { input_tokens: index + 1, output_tokens: 1 } }
                    : {}),
            },
        }))
    );
}

function codexContent(session: LogicalSession): string {
    return jsonLines([
        {
            type: "session_meta",
            timestamp: session.timestamp.toISOString(),
            payload: {
                id: session.id,
                cwd: session.cwd,
                source: session.isSubagent
                    ? { subagent: { thread_spawn: { parent_thread_id: session.parentId } } }
                    : {},
                git: { branch: "fixture-main" },
            },
        },
        ...session.records.map((record) => ({
            type: "response_item",
            timestamp: record.timestamp,
            payload: {
                type: "message",
                role: record.role,
                content: [{ type: record.role === "user" ? "input_text" : "output_text", text: record.text }],
            },
        })),
    ]);
}

function grokChatContent(session: LogicalSession): string {
    return jsonLines(
        session.records.map((record) => ({
            type: record.role,
            timestamp: record.timestamp,
            content:
                record.role === "user"
                    ? `<user_query>${record.text}</user_query>`
                    : [{ type: "text", text: record.text }],
        }))
    );
}

async function writeSource(options: {
    root: string;
    provider: AgentKind;
    path: string;
    content: string;
    timestamp: Date;
}): Promise<HistoryCorpusSourceManifest> {
    await mkdir(join(options.path, ".."), { recursive: true });
    await writeFile(options.path, options.content, "utf8");
    await utimes(options.path, options.timestamp, options.timestamp);
    const bytes = Buffer.byteLength(options.content);
    return {
        provider: options.provider,
        relativePath: relative(options.root, options.path),
        bytes,
        sha256: createHash("sha256").update(options.content).digest("hex"),
    };
}

export async function generateHistoryCorpus(options: HistoryCorpusOptions): Promise<HistoryCorpusManifest> {
    const root = validateOptions(options);
    const sessions = buildSessions(options);
    const sources: HistoryCorpusSourceManifest[] = [];

    for (const [index, session] of sessions.entries()) {
        const projectDirectory = `-fixtures-project-${index % 3}`;
        const claudePath = session.isSubagent
            ? join(
                  root,
                  "invented-home",
                  ".claude",
                  "projects",
                  projectDirectory,
                  "subagents",
                  `agent-${session.id}.jsonl`
              )
            : join(root, "invented-home", ".claude", "projects", projectDirectory, `${session.id}.jsonl`);
        const codexPath = join(
            root,
            "invented-home",
            ".codex",
            "sessions",
            "2026",
            "08",
            "15",
            `rollout-${session.id}.jsonl`
        );
        const grokDirectory = join(
            root,
            "invented-home",
            ".grok",
            "sessions",
            encodeURIComponent(session.cwd),
            session.id
        );
        const grokSummary = SafeJSON.stringify({
            info: { id: session.id, cwd: session.cwd },
            generated_title: session.title,
            session_summary: session.summary,
            created_at: session.timestamp.toISOString(),
            updated_at: session.records.at(-1)?.timestamp ?? session.timestamp.toISOString(),
        });

        sources.push(
            await writeSource({
                root,
                provider: "claude",
                path: claudePath,
                content: claudeContent(session),
                timestamp: session.timestamp,
            }),
            await writeSource({
                root,
                provider: "codex",
                path: codexPath,
                content: codexContent(session),
                timestamp: session.timestamp,
            }),
            await writeSource({
                root,
                provider: "grok",
                path: join(grokDirectory, "summary.json"),
                content: grokSummary,
                timestamp: session.timestamp,
            }),
            await writeSource({
                root,
                provider: "grok",
                path: join(grokDirectory, "chat_history.jsonl"),
                content: grokChatContent(session),
                timestamp: session.timestamp,
            })
        );
    }

    sources.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
    return {
        version: HISTORY_CORPUS_VERSION,
        seed: options.seed,
        logical: {
            sessions: options.sessionCount,
            records: options.recordCount,
            main: options.distribution.main,
            subagent: options.distribution.subagent,
        },
        providers: { claude: sessions.length, codex: sessions.length, grok: sessions.length },
        queries: {
            common: BENCHMARK_COMMON_QUERY,
            rare: `benchmark-rare-${options.seed}`,
            absent: BENCHMARK_ABSENT_QUERY,
        },
        sessions: sessions.map((session) => ({
            sessionId: session.id,
            parentId: session.parentId,
            cwd: session.cwd,
            timestamp: session.timestamp.toISOString(),
            isSubagent: session.isSubagent,
        })),
        totalBytes: sources.reduce((total, source) => total + source.bytes, 0),
        sources,
    };
}
