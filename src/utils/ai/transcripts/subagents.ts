/**
 * The sub-agents of one Claude session, read from its `<session>/subagents/` directory: one
 * `agent-<id>.jsonl` transcript per agent, most with an `agent-<id>.meta.json` beside it. The agents of a
 * Workflow tool run sit one level deeper (`subagents/workflows/<runId>/`) and are listed too.
 *
 * A session's Agent tool calls only name the agents its loaded turns started, and a tool call's
 * return says nothing about a background agent or a teammate that still works. The directory has
 * every agent, and each transcript's last record says whether that agent is still working.
 */
import { closeSync, existsSync, fstatSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { resolveHistoryProvider } from "@genesiscz/utils/agent-sessions/provider";
import {
    claudeSubagentFiles,
    claudeSubagentIdOf,
    claudeSubagentTranscripts,
    claudeWorkflowRunOf,
} from "@genesiscz/utils/agent-sessions/readers/claude-paths";
import { harnessDriver } from "@genesiscz/utils/ai/providers/harness-index";
import { isMissingPathError } from "@genesiscz/utils/fs/canonical";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { nonEmptyString as text } from "@genesiscz/utils/string";
import { scanClaudeToolCalls } from "./file-scan";
import type { ResolvedTranscript } from "./resolve";

/**
 * - `running`: the last record is a prompt, a tool result or a tool call, and the file was written
 *   in the last `staleAfterMs`.
 * - `done`: the last record is a finished reply (an idle teammate waiting for a message is `done`).
 * - `stopped`: it was mid-work, but nothing was written for longer than `staleAfterMs`.
 */
export type SubagentState = "running" | "done" | "stopped";

/** What a sub-agent's own files say about the Workflow tool run that started it. */
export interface SubagentWorkflow {
    /** The run folder's name (`wf_…`). `tools ai sessions workflows` reads the run itself. */
    runId: string;
    /** The agent's label in the run (the meta file's description). */
    label: string | null;
    phase: string | null;
}

export interface SessionSubagent {
    /** The agent id from the file name (`agent-<id>.jsonl`). */
    id: string;
    /** The Workflow tool run that started it; null for an agent the session or another agent started. */
    workflow: SubagentWorkflow | null;
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
    /** The size of every file in `files`. */
    bytes: number;
    /** The transcript it wrote last: the one to tail. */
    filePath: string;
    /**
     * Every transcript of this agent id, oldest first. Almost always one. A workflow agent that the lead revives with
     * SendMessage keeps its first transcript in the run folder and writes the revival into a second file directly in
     * the sub-agent folder, with no meta file.
     */
    files: string[];
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

/** The first complete record of the head, and every complete record of the tail, oldest first. */
function headAndTail(head: string, tail: string): { first: JsonRecord | null; records: JsonRecord[] } {
    const first = head
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .map(parseLine)
        .find((record) => record !== null);
    const records = tail
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .map(parseLine)
        .filter((record): record is JsonRecord => record !== null);
    return { first: first ?? null, records };
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
        if (!isMissingPathError(error)) {
            logger.debug({ error, path }, "[transcripts] sub-agent meta identity unavailable");
        }

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
    const id = claudeSubagentIdOf(entry) ?? entry;
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

    const meta = metaIdentity(claudeSubagentFiles(dir, id).meta);
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
    const id = claudeSubagentIdOf(entry) ?? entry;
    let fd: number | null = null;
    try {
        fd = openSync(filePath, "r");
        const stat = fstatSync(fd);
        const head = readHead(fd, stat.size);
        const tailStart = Math.max(0, stat.size - TAIL_BYTES);
        const tail = readSlice(fd, tailStart, stat.size - tailStart);
        const { first, records } = headAndTail(head, tail);
        const meta = readMeta(claudeSubagentFiles(dir, id).meta);
        const working = resolveHistoryProvider("claude").reader.midWork(records);
        const scanned = scan ? scanClaudeToolCalls(filePath) : null;
        const runId = claudeWorkflowRunOf(filePath);
        const agent: Omit<SessionSubagent, "state"> = {
            id,
            workflow: runId ? { runId, label: text(meta.description), phase: text(meta.workflowPhase) } : null,
            name: text(meta.name),
            description: text(meta.description),
            agentType: text(meta.agentType),
            model: text(meta.model),
            // The sub-agent's own transcript: its rows are all side-chain rows, so they name its own model.
            transcriptModel: resolveHistoryProvider("claude").reader.currentModel(filePath),
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
            files: [filePath],
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

/**
 * One agent from the several files that carry its id, oldest first. Who it is comes from the oldest file that says
 * (the run folder's file has the meta; the revival file has none), where it stands comes from the newest.
 */
function mergeAgentFiles(parts: SessionSubagent[]): SessionSubagent {
    const newest = parts.at(-1);
    const [oldest] = parts;

    if (!oldest || !newest || parts.length === 1) {
        return parts[0] as SessionSubagent;
    }

    const firstOf = <K extends keyof SessionSubagent>(key: K): SessionSubagent[K] =>
        (parts.find((part) => part[key] !== null && part[key] !== undefined) ?? oldest)[key];
    const toolCalls = parts.some((part) => part.toolCalls !== undefined)
        ? parts.reduce((sum, part) => sum + (part.toolCalls ?? 0), 0)
        : undefined;
    const agentCalls = parts.some((part) => part.agentCalls !== undefined)
        ? parts.flatMap((part) => part.agentCalls ?? [])
        : undefined;

    return {
        ...oldest,
        workflow: firstOf("workflow"),
        name: firstOf("name"),
        description: firstOf("description"),
        agentType: firstOf("agentType"),
        model: firstOf("model"),
        toolUseId: firstOf("toolUseId"),
        spawnDepth: firstOf("spawnDepth"),
        requestShape: firstOf("requestShape"),
        teamName: firstOf("teamName"),
        taskKind: firstOf("taskKind"),
        spawnPrompt: firstOf("spawnPrompt"),
        startedAt: firstOf("startedAt"),
        isFork: parts.some((part) => part.isFork),
        transcriptModel: newest.transcriptModel ?? firstOf("transcriptModel"),
        lastAt: newest.lastAt,
        state: newest.state,
        bytes: parts.reduce((sum, part) => sum + part.bytes, 0),
        filePath: newest.filePath,
        files: parts.flatMap((part) => part.files),
        ...(toolCalls === undefined ? {} : { toolCalls }),
        ...(agentCalls === undefined ? {} : { agentCalls }),
    };
}

/**
 * Every sub-agent of a Claude session, oldest first, one per agent id: the agents the session and its agents started,
 * and the agents of its Workflow tool runs (each with `workflow.runId`). An id with two files is one agent
 * (`files`): listed per file, session 1d7131fa had 7 ids twice, and a tree of them had two nodes with one id
 * (2026-11-10). Other providers have none on disk: an empty list.
 */
export function listSubagents(resolved: ResolvedTranscript, options: ListSubagentsOptions = {}): SessionSubagents {
    const now = options.now ?? Date.now();
    const staleAfterMs = options.staleAfterMs ?? DEFAULT_STALE_MS;
    if (!harnessDriver(resolved.provider).parts.transcript.subagentsOnDisk) {
        return { sessionId: resolved.sessionId, subagents: [] };
    }

    // Most sessions never spawn a sub-agent: a missing folder lists as nothing and is not logged.
    const wanted = options.ids ? new Set(options.ids) : null;
    const files = claudeSubagentTranscripts(resolved.filePath)
        .filter((file) => (wanted ? wanted.has(file.agentId) : true))
        .map((file) =>
            readAgent(file.dir, basename(file.transcript), {
                now,
                staleAfterMs,
                scan: options.scan === true,
                promptChars: options.promptChars ?? SPAWN_PROMPT_CHARS,
            })
        )
        .filter((agent): agent is SessionSubagent => agent !== null)
        .sort((a, b) => (a.startedAt ?? a.lastAt).localeCompare(b.startedAt ?? b.lastAt));
    const byId = new Map<string, SessionSubagent[]>();

    for (const file of files) {
        byId.set(file.id, [...(byId.get(file.id) ?? []), file]);
    }

    const subagents = [...byId.values()].map(mergeAgentFiles);
    logger.trace(
        { session: resolved.filePath, count: subagents.length, files: files.length },
        "[transcripts] listed sub-agents"
    );
    return { sessionId: resolved.sessionId, subagents };
}
