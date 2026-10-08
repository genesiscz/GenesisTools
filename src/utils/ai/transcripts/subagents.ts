/**
 * The sub-agents of one Claude session, read from its `<session>/subagents/` directory: one
 * `agent-<id>.jsonl` transcript per agent, most with an `agent-<id>.meta.json` beside it.
 *
 * A session's Agent tool calls only name the agents its loaded turns started, and a tool call's
 * return says nothing about a background agent or a teammate that still works. The directory has
 * every agent, and each transcript's last record says whether that agent is still working.
 */
import { closeSync, existsSync, fstatSync, openSync, readdirSync, readFileSync, readSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { scanClaudeToolCalls } from "./file-scan";
import type { ResolvedTranscript } from "./resolve";

/**
 * - `running`: the last record is a prompt, a tool result or a tool call, and the file was written
 *   in the last `staleAfterMs`.
 * - `done`: the last record is a finished reply (an idle teammate waiting for a message is `done`).
 * - `stopped`: it was mid-work, but nothing was written for longer than `staleAfterMs`.
 */
export type SubagentState = "running" | "done" | "stopped";

export interface SessionSubagent {
    /** The agent id from the file name (`agent-<id>.jsonl`). */
    id: string;
    /** A teammate's name; null for a plain sub-agent. */
    name: string | null;
    description: string | null;
    agentType: string | null;
    model: string | null;
    /** The model its last reply names (`meta.model` is often `inherit`). */
    transcriptModel: string | null;
    /** The Agent tool call that started it, when the meta file records one. */
    toolUseId: string | null;
    /** 0 for a teammate, 1 for an agent the session started, 2+ for one an agent started. Null when unrecorded. */
    spawnDepth: number | null;
    /** `background` | `foreground`, as the meta records it. */
    requestShape: string | null;
    isFork: boolean;
    /** A teammate's team (`session-<first 8 of the lead's id>`). */
    teamName: string | null;
    /** `in_process_teammate` for an in-process teammate. */
    taskKind: string | null;
    /** The first prompt it received, at most `SPAWN_PROMPT_CHARS`, with a teammate envelope removed. */
    spawnPrompt: string | null;
    /** With `scan: true`: tool calls in its whole transcript (a byte count, see `file-scan.ts`). */
    toolCalls?: number;
    /** With `scan: true`: the `tool_use` ids of the Agent calls it made, for nesting its own agents. */
    agentCalls?: string[];
    /** The first record's timestamp. */
    startedAt: string | null;
    /** When its transcript was last written. */
    lastAt: string;
    state: SubagentState;
    bytes: number;
    filePath: string;
}

export interface SessionSubagents {
    sessionId: string;
    subagents: SessionSubagent[];
}

export interface ListSubagentsOptions {
    now?: number;
    /** A working agent silent for longer than this is `stopped`. Default 15 minutes. */
    staleAfterMs?: number;
    /** Also count tool calls and Agent calls over each whole transcript (`scanClaudeToolCalls`). */
    scan?: boolean;
    /** How much of each spawn prompt to keep. Default `SPAWN_PROMPT_CHARS`; a one-agent view passes `Infinity`. */
    promptChars?: number;
    /** Read only these agent ids (`agent-<id>.jsonl`); the other transcripts are not opened. */
    ids?: string[];
}

export const SPAWN_PROMPT_CHARS = 4000;
const HEAD_BYTES = 16 * 1024;
/** How far the first record is followed when it is longer than the head (a long spawn prompt). */
const FIRST_RECORD_MAX_BYTES = 512 * 1024;
const TAIL_BYTES = 64 * 1024;
const DEFAULT_STALE_MS = 15 * 60 * 1000;

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): string | null {
    return typeof value === "string" && value.length > 0 ? value : null;
}

function readSlice(fd: number, position: number, length: number): string {
    const buffer = Buffer.alloc(length);
    const read = readSync(fd, buffer, 0, length, position);
    return buffer.subarray(0, read).toString("utf8");
}

function parseLine(line: string): JsonRecord | null {
    try {
        const value: unknown = SafeJSON.parse(line, { strict: true });
        return isRecord(value) ? value : null;
    } catch {
        return null;
    }
}

/** The first complete record of the head, and the last complete record of the tail. */
function firstAndLast(head: string, tail: string): { first: JsonRecord | null; last: JsonRecord | null } {
    const first = head
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .map(parseLine)
        .find((record) => record !== null);
    const lines = tail.split("\n");
    for (let index = lines.length - 1; index >= 0; index--) {
        const line = lines[index].trim();
        if (!line) {
            continue;
        }

        const record = parseLine(line);
        // Only a conversation record says where the agent is; progress and attachment rows do not.
        if (record && (record.type === "assistant" || record.type === "user")) {
            return { first: first ?? null, last: record };
        }
    }

    return { first: first ?? null, last: null };
}

/** Whether the agent was still working when it last wrote. */
function midWork(last: JsonRecord | null): boolean {
    if (!last) {
        return true;
    }

    if (last.type === "user") {
        return true;
    }

    const message = isRecord(last.message) ? last.message : null;
    const content = Array.isArray(message?.content) ? message.content : [];
    if (content.some(approvesShutdown)) {
        return false;
    }

    if (content.some((part) => isRecord(part) && part.type === "tool_use")) {
        return true;
    }

    return message?.stop_reason === null;
}

/** A teammate's last act before its process exits: `SendMessage` with an approving `shutdown_response`. */
function approvesShutdown(part: unknown): boolean {
    if (!isRecord(part) || part.type !== "tool_use" || part.name !== "SendMessage" || !isRecord(part.input)) {
        return false;
    }

    const reply = part.input.message;
    return isRecord(reply) && reply.type === "shutdown_response" && reply.approve === true;
}

/** The head, grown until it holds the whole first record (a spawn prompt can outgrow `HEAD_BYTES`). */
function readHead(fd: number, size: number): string {
    let length = Math.min(HEAD_BYTES, size);
    let head = readSlice(fd, 0, length);

    while (!head.includes("\n") && length < size && length < FIRST_RECORD_MAX_BYTES) {
        length = Math.min(length * 4, size, FIRST_RECORD_MAX_BYTES);
        head = readSlice(fd, 0, length);
    }

    return head;
}

const TEAMMATE_ENVELOPE = /^\s*<teammate-message\b[^>]*>\n?([\s\S]*?)\n?<\/teammate-message>\s*$/;

/** The text of a prompt record: a string content, or its text parts joined. */
function promptText(record: JsonRecord | null, maxChars: number): string | null {
    if (record?.type !== "user") {
        return null;
    }

    const message = isRecord(record.message) ? record.message : null;
    const content = message?.content;
    const raw =
        typeof content === "string"
            ? content
            : Array.isArray(content)
              ? content
                    .filter((part): part is JsonRecord => isRecord(part) && part.type === "text")
                    .map((part) => (typeof part.text === "string" ? part.text : ""))
                    .join("\n")
              : "";
    const unwrapped = TEAMMATE_ENVELOPE.exec(raw)?.[1] ?? raw;
    return text(unwrapped.slice(0, maxChars));
}

/** The model the last reply in the tail names. */
function lastModel(tail: string): string | null {
    const lines = tail.split("\n");
    for (let index = lines.length - 1; index >= 0; index--) {
        const line = lines[index];
        if (!line.includes('"type":"assistant"') || !line.includes('"model"')) {
            continue;
        }

        const record = parseLine(line.trim());
        const message = record && isRecord(record.message) ? record.message : null;
        const model = text(message?.model);
        if (model && model !== "<synthetic>") {
            return model;
        }
    }

    return null;
}

function readMeta(path: string): JsonRecord {
    if (!existsSync(path)) {
        return {};
    }

    try {
        const value: unknown = SafeJSON.parse(readFileSync(path, "utf8"), { strict: true });
        return isRecord(value) ? value : {};
    } catch (error) {
        logger.debug({ error, path }, "[transcripts] unreadable sub-agent meta");
        return {};
    }
}

interface ReadAgentEntry {
    ino: number;
    size: number;
    mtimeMs: number;
    metaMtimeMs: number;
    metaSize: number;
    working: boolean;
    agent: Omit<SessionSubagent, "state">;
}

/** Most sub-agents kept: every agent of every parent a hub list shows, with room to spare. */
const READ_AGENT_CACHE_LIMIT = 4000;
const readAgentCache = new Map<string, ReadAgentEntry>();

function metaIdentity(path: string): { mtimeMs: number; size: number } {
    try {
        const status = statSync(path);
        return { mtimeMs: status.mtimeMs, size: status.size };
    } catch (error) {
        logger.debug({ error, path }, "[transcripts] sub-agent meta identity unavailable");
        return { mtimeMs: -1, size: -1 };
    }
}

/**
 * A sub-agent's row, from its transcript's head and tail and its meta file. A resident process (the hub
 * server) reads it again only when the transcript or the meta changed: a finished agent's files never
 * do, and parsing every agent's head and tail on each refresh was most of a hub agents call (2026-10-08).
 * `state` depends on the clock, so it is worked out on every call.
 */
function readAgent(
    dir: string,
    entry: string,
    options: { now: number; staleAfterMs: number; scan: boolean; promptChars: number }
): SessionSubagent | null {
    const filePath = join(dir, entry);
    const id = entry.slice("agent-".length, -".jsonl".length);
    const stateOf = (working: boolean, mtimeMs: number): SubagentState =>
        !working ? "done" : options.now - mtimeMs > options.staleAfterMs ? "stopped" : "running";
    const key = `${filePath}\u0000${options.scan}\u0000${options.promptChars}`;
    let stat: { ino: number; size: number; mtimeMs: number };
    try {
        stat = statSync(filePath);
    } catch (error) {
        logger.debug({ error, filePath }, "[transcripts] unreadable sub-agent transcript");
        return null;
    }

    const meta = metaIdentity(join(dir, `agent-${id}.meta.json`));
    const settled = Date.now() - Math.max(stat.mtimeMs, meta.mtimeMs) >= 2000;
    const cached = readAgentCache.get(key);
    if (
        settled &&
        cached &&
        cached.ino === stat.ino &&
        cached.size === stat.size &&
        cached.mtimeMs === stat.mtimeMs &&
        cached.metaMtimeMs === meta.mtimeMs &&
        cached.metaSize === meta.size
    ) {
        return { ...cached.agent, state: stateOf(cached.working, cached.mtimeMs) };
    }

    const read = readAgentFresh(dir, entry, options);
    if (!read) {
        readAgentCache.delete(key);
        return null;
    }

    readAgentCache.delete(key);
    if (!settled) {
        return { ...read.agent, state: stateOf(read.working, read.stat.mtimeMs) };
    }

    readAgentCache.set(key, {
        ino: read.stat.ino,
        size: read.stat.size,
        mtimeMs: read.stat.mtimeMs,
        metaMtimeMs: meta.mtimeMs,
        metaSize: meta.size,
        working: read.working,
        agent: read.agent,
    });
    if (readAgentCache.size > READ_AGENT_CACHE_LIMIT) {
        const oldest = readAgentCache.keys().next().value;
        if (oldest !== undefined) {
            readAgentCache.delete(oldest);
        }
    }

    return { ...read.agent, state: stateOf(read.working, read.stat.mtimeMs) };
}

function readAgentFresh(
    dir: string,
    entry: string,
    { scan, promptChars }: { scan: boolean; promptChars: number }
): {
    agent: Omit<SessionSubagent, "state">;
    working: boolean;
    stat: { ino: number; size: number; mtimeMs: number };
} | null {
    const filePath = join(dir, entry);
    const id = entry.slice("agent-".length, -".jsonl".length);
    let fd: number | null = null;
    try {
        fd = openSync(filePath, "r");
        const stat = fstatSync(fd);
        const head = readHead(fd, stat.size);
        const tailStart = Math.max(0, stat.size - TAIL_BYTES);
        const tail = readSlice(fd, tailStart, stat.size - tailStart);
        const { first, last } = firstAndLast(head, tail);
        const meta = readMeta(join(dir, `agent-${id}.meta.json`));
        const working = midWork(last);
        const scanned = scan ? scanClaudeToolCalls(filePath) : null;
        const agent: Omit<SessionSubagent, "state"> = {
            id,
            name: text(meta.name),
            description: text(meta.description),
            agentType: text(meta.agentType),
            model: text(meta.model),
            transcriptModel: lastModel(tail),
            toolUseId: text(meta.toolUseId),
            spawnDepth: typeof meta.spawnDepth === "number" ? meta.spawnDepth : null,
            requestShape: text(meta.requestShape),
            isFork: meta.isFork === true,
            teamName: text(meta.teamName),
            taskKind: text(meta.taskKind),
            spawnPrompt: promptText(first, promptChars),
            startedAt: text(first?.timestamp),
            lastAt: new Date(stat.mtimeMs).toISOString(),
            bytes: stat.size,
            filePath,
            ...(scanned ? { toolCalls: scanned.toolCalls, agentCalls: scanned.agentCalls } : {}),
        };
        return { agent, working, stat: { ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs } };
    } catch (error) {
        logger.debug({ error, filePath }, "[transcripts] unreadable sub-agent transcript");
        return null;
    } finally {
        if (fd !== null) {
            closeSync(fd);
        }
    }
}

/** Every sub-agent of a Claude session, oldest first. Other providers have none on disk: an empty list. */
export function listSubagents(resolved: ResolvedTranscript, options: ListSubagentsOptions = {}): SessionSubagents {
    const now = options.now ?? Date.now();
    const staleAfterMs = options.staleAfterMs ?? DEFAULT_STALE_MS;
    if (resolved.provider !== "claude") {
        return { sessionId: resolved.sessionId, subagents: [] };
    }

    const dir = join(dirname(resolved.filePath), basename(resolved.filePath, ".jsonl"), "subagents");
    let entries: string[];
    try {
        entries = readdirSync(dir);
    } catch (error) {
        logger.debug({ error, dir }, "[transcripts] no sub-agent directory");
        return { sessionId: resolved.sessionId, subagents: [] };
    }

    const wanted = options.ids ? new Set(options.ids.map((id) => `agent-${id}.jsonl`)) : null;
    const subagents = entries
        .filter((entry) => (wanted ? wanted.has(entry) : entry.startsWith("agent-") && entry.endsWith(".jsonl")))
        .map((entry) =>
            readAgent(dir, entry, {
                now,
                staleAfterMs,
                scan: options.scan === true,
                promptChars: options.promptChars ?? SPAWN_PROMPT_CHARS,
            })
        )
        .filter((agent): agent is SessionSubagent => agent !== null)
        .sort((a, b) => (a.startedAt ?? a.lastAt).localeCompare(b.startedAt ?? b.lastAt));
    logger.debug({ dir, count: subagents.length }, "[transcripts] listed sub-agents");
    return { sessionId: resolved.sessionId, subagents };
}
