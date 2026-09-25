/**
 * The sub-agents of one Claude session, read from its `<session>/subagents/` directory: one
 * `agent-<id>.jsonl` transcript per agent, most with an `agent-<id>.meta.json` beside it.
 *
 * A session's Agent tool calls only name the agents its loaded turns started, and a tool call's
 * return says nothing about a background agent or a teammate that still works. The directory has
 * every agent, and each transcript's last record says whether that agent is still working.
 */
import { closeSync, existsSync, fstatSync, openSync, readdirSync, readFileSync, readSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
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
    /** The Agent tool call that started it, when the meta file records one. */
    toolUseId: string | null;
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
}

const HEAD_BYTES = 16 * 1024;
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
    if (content.some((part) => isRecord(part) && part.type === "tool_use")) {
        return true;
    }

    return message?.stop_reason === null;
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

function readAgent(dir: string, entry: string, now: number, staleAfterMs: number): SessionSubagent | null {
    const filePath = join(dir, entry);
    const id = entry.slice("agent-".length, -".jsonl".length);
    let fd: number | null = null;
    try {
        fd = openSync(filePath, "r");
        const stat = fstatSync(fd);
        const head = readSlice(fd, 0, Math.min(HEAD_BYTES, stat.size));
        const tailStart = Math.max(0, stat.size - TAIL_BYTES);
        const tail = readSlice(fd, tailStart, stat.size - tailStart);
        const { first, last } = firstAndLast(head, tail);
        const meta = readMeta(join(dir, `agent-${id}.meta.json`));
        const working = midWork(last);
        const state: SubagentState = !working ? "done" : now - stat.mtimeMs > staleAfterMs ? "stopped" : "running";
        return {
            id,
            name: text(meta.name),
            description: text(meta.description),
            agentType: text(meta.agentType),
            model: text(meta.model),
            toolUseId: text(meta.toolUseId),
            startedAt: text(first?.timestamp),
            lastAt: new Date(stat.mtimeMs).toISOString(),
            state,
            bytes: stat.size,
            filePath,
        };
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

    const subagents = entries
        .filter((entry) => entry.startsWith("agent-") && entry.endsWith(".jsonl"))
        .map((entry) => readAgent(dir, entry, now, staleAfterMs))
        .filter((agent): agent is SessionSubagent => agent !== null)
        .sort((a, b) => (a.startedAt ?? a.lastAt).localeCompare(b.startedAt ?? b.lastAt));
    logger.debug({ dir, count: subagents.length }, "[transcripts] listed sub-agents");
    return { sessionId: resolved.sessionId, subagents };
}
