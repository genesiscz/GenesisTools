import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { basename, dirname } from "node:path";
import { POLLED_LISTING_REUSE_MS } from "@app/ai/lib/sessions/agent-session-rows";
import { catalogHistory } from "@genesiscz/utils/agent-sessions/open-service";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { toolDataDir } from "@genesiscz/utils/storage/root";
import { atomicWriteFileSync } from "@genesiscz/utils/storage/storage";
import { hasRunning, LIVE_PARENT_MS, type ParentRow, sortNodes } from "./tree";
import type { AgentNode, AgentParent, AgentStatus } from "./types";

/**
 * Codex's own sub-agents (the multi-agent mode of the Desktop app and the CLI). Each one is a
 * rollout of its own whose first line names the thread that spawned it, so the Agents tab can hang
 * it under that thread the way it hangs a Claude sub-agent under its lead session. They are not
 * `tools codex` workers (`workers.ts`): nothing reports to a rendezvous, the rollout is all there is.
 *
 * No spawn prompt: Codex writes the task message encrypted, in the parent's `spawn_agent` call and
 * in the child's first `agent_message` alike, so the tab shows the agent's task name instead.
 */

/** The link fields all sit in the first kilobyte of a rollout whose first line is 20 KB of instructions. */
const HEAD_BYTES = 4096;
/** A turn marker is in the last records; a long tool output between them can push it back. */
const TAIL_BYTES = 256 * 1024;
/** The `turn_context` that names the model follows ~300 KB of instructions and world state. */
const MODEL_SCAN_BYTES = 640 * 1024;
const SCAN_CHUNK_BYTES = 16 * 1024 * 1024;
/** A turn with no end record is `running` until its file is this quiet, then `killed`. */
const TURN_STALE_MS = 15 * 60 * 1000;
/** A rollout with no turn marker in its tail: fresh means running. */
const NO_MARKER_FRESH_MS = 2 * 60 * 1000;
const CACHE_KEEP_MS = 7 * 24 * 3_600_000;

/** One Codex sub-agent rollout from the session index. */
export interface CodexAgentRecord {
    /** The sub-agent's own thread id. */
    id: string;
    /** The conversation it belongs to (`session_id`): the topmost thread. */
    rootId: string;
    filePath: string;
    mtime: number;
    cwd: string;
}

export interface CodexAgentHead {
    /** The thread that spawned it: a root thread, or another sub-agent. */
    parentId: string;
    depth: number;
    nickname: string | null;
    role: string | null;
    agentPath: string | null;
    startedAt: string | null;
}

export interface CodexAgentsContext {
    now: number;
    /** The model shown when a rollout does not say; the parent's. */
    model: string | null;
    /** Tests point this at a temp file; production uses the tool's data dir. */
    cachePath?: string;
}

/** Sub-agent rollouts the session index saw written at or after `since`. */
export async function recentCodexAgentRecords(since: number): Promise<CodexAgentRecord[]> {
    const catalog = await catalogHistory({
        provider: "codex",
        filters: { agentsOnly: true, mtimeFrom: since },
        maxDiscoveryAgeMs: POLLED_LISTING_REUSE_MS,
    });

    return catalog.metadata.flatMap((record) =>
        record.isSubagent && record.nativeId && record.mtime >= since
            ? [
                  {
                      id: record.nativeId,
                      rootId: record.parentNativeId ?? record.nativeId,
                      filePath: record.filePath,
                      mtime: record.mtime,
                      cwd: record.cwd ?? "",
                  },
              ]
            : []
    );
}

function readBytes(path: string, position: number, length: number): Buffer {
    const fd = openSync(path, "r");

    try {
        const buffer = Buffer.alloc(length);
        const read = readSync(fd, buffer, 0, length, position);

        return buffer.subarray(0, read);
    } finally {
        closeSync(fd);
    }
}

function field(head: string, key: string): string | null {
    return new RegExp(`"${key}":"([^"]*)"`).exec(head)?.[1] ?? null;
}

/**
 * The spawn link of a sub-agent rollout, read from its first kilobyte with no JSON parse (the line
 * is 20 KB). Null for a rollout that is not a sub-agent or cannot be read.
 */
export function codexAgentHeadOf(path: string): CodexAgentHead | null {
    let head: string;

    try {
        head = readBytes(path, 0, HEAD_BYTES).toString("utf8");
    } catch (error) {
        logger.debug({ error, path }, "[hub agents] unreadable codex agent head");
        return null;
    }

    const parentId = field(head, "parent_thread_id");

    // Native rollouts mark a sub-agent with `source.subagent` (the shape the shared Codex reader
    // checks); some also carry `thread_source`. Either one counts.
    const isSubagent = /"subagent":\{/.test(head) || head.includes('"thread_source":"subagent"');

    if (!parentId || !isSubagent) {
        return null;
    }

    return {
        parentId,
        depth: Number(/"depth":(\d+)/.exec(head)?.[1] ?? 1),
        nickname: field(head, "agent_nickname"),
        role: field(head, "agent_role"),
        agentPath: field(head, "agent_path"),
        startedAt: field(head, "timestamp"),
    };
}

/**
 * Where the agent's last turn stands, from the last turn marker in the tail:
 * - `task_complete`: finished.
 * - `turn_aborted`: interrupted.
 * - `task_started` with nothing after it: mid-turn, running while the file is fresh and killed once
 *   it went quiet.
 */
export function codexTurnState(options: { filePath: string; mtime: number; now: number }): AgentStatus {
    const { filePath, mtime, now } = options;
    let tail: string;

    try {
        const size = statSync(filePath).size;

        tail = readBytes(filePath, Math.max(0, size - TAIL_BYTES), TAIL_BYTES).toString("utf8");
    } catch (error) {
        logger.debug({ error, filePath }, "[hub agents] unreadable codex agent tail");
        return "completed";
    }

    let last: string | null = null;

    for (const match of tail.matchAll(/"type":"(task_started|task_complete|turn_aborted)"/g)) {
        last = match[1] ?? null;
    }

    if (last === "task_complete") {
        return "completed";
    }

    if (last === "turn_aborted") {
        return "killed";
    }

    if (last === "task_started") {
        return now - mtime < TURN_STALE_MS ? "running" : "killed";
    }

    return now - mtime < NO_MARKER_FRESH_MS ? "running" : "completed";
}

/**
 * The model the agent runs, from its first `turn_context`. A sub-agent often runs another model than
 * the session that spawned it, so the parent's would be wrong. Null until that record is written.
 */
export function codexAgentModel(path: string): string | null {
    let text: string;

    try {
        text = readBytes(path, 0, MODEL_SCAN_BYTES).toString("utf8");
    } catch (error) {
        logger.debug({ error, path }, "[hub agents] unreadable codex agent model");
        return null;
    }

    const at = text.indexOf('"type":"turn_context"');

    if (at === -1) {
        return null;
    }

    const end = text.indexOf("\n", at);
    const row = text.slice(text.lastIndexOf("\n", at) + 1, end === -1 ? undefined : end);

    return field(row, "model");
}

interface ScanEntry {
    /** File size when last read; a smaller file starts over. */
    size: number;
    /** Bytes already counted: the end of the last complete line read. */
    offset: number;
    calls: number;
    model: string | null;
    /** Looked for in a file past the scan window, so a missing model is final. */
    modelFinal: boolean;
    seen: number;
}

type ScanCache = Record<string, ScanEntry>;

const CALL_MARKERS = [Buffer.from('"type":"custom_tool_call"'), Buffer.from('"type":"function_call"')];

function countCalls(buffer: Buffer): number {
    let count = 0;

    for (const marker of CALL_MARKERS) {
        let at = buffer.indexOf(marker);

        while (at !== -1) {
            count += 1;
            at = buffer.indexOf(marker, at + marker.length);
        }
    }

    return count;
}

/** Tool calls of an append-only rollout, counting only what was appended since the last read. */
function scanCalls(path: string, size: number, entry: ScanEntry | undefined): { calls: number; offset: number } {
    let calls = entry && entry.size <= size ? entry.calls : 0;
    let offset = entry && entry.size <= size ? entry.offset : 0;

    while (offset < size) {
        const chunk = readBytes(path, offset, Math.min(SCAN_CHUNK_BYTES, size - offset));
        const lastNewline = chunk.lastIndexOf(10);

        if (chunk.length === 0 || (lastNewline === -1 && offset + chunk.length >= size)) {
            // A line still being written: counted on the next read, once it is whole.
            break;
        }

        const whole = lastNewline === -1 ? chunk : chunk.subarray(0, lastNewline + 1);

        calls += countCalls(whole);
        offset += whole.length;
    }

    return { calls, offset };
}

function defaultCachePath(): string {
    return `${toolDataDir("hub-agents")}/codex-agents.json`;
}

function loadCache(path: string): ScanCache {
    try {
        const raw: unknown = SafeJSON.parse(readFileSync(path, "utf8"), { strict: true });

        return typeof raw === "object" && raw !== null ? (raw as ScanCache) : {};
    } catch (error) {
        if (existsSync(path)) {
            logger.debug({ error, path }, "[hub agents] codex agent cache unreadable; rebuilding");
        }

        return {};
    }
}

function saveCache(path: string, cache: ScanCache, now: number): void {
    for (const [file, entry] of Object.entries(cache)) {
        if (now - entry.seen > CACHE_KEEP_MS) {
            delete cache[file];
        }
    }

    try {
        mkdirSync(dirname(path), { recursive: true });
        atomicWriteFileSync(path, SafeJSON.stringify(cache, { strict: true }));
    } catch (error) {
        logger.warn({ error, path }, "[hub agents] could not save the codex agent cache");
    }
}

function iso(ms: number): string {
    return new Date(ms).toISOString();
}

function nodeOf(
    record: CodexAgentRecord,
    head: CodexAgentHead,
    context: CodexAgentsContext,
    cache: ScanCache
): { node: AgentNode; changed: boolean } {
    let size = 0;

    try {
        size = statSync(record.filePath).size;
    } catch (error) {
        logger.debug({ error, path: record.filePath }, "[hub agents] codex agent file vanished");
    }

    const known =
        cache[record.filePath]?.size !== undefined && cache[record.filePath]!.size <= size
            ? cache[record.filePath]
            : undefined;
    const scanned = scanCalls(record.filePath, size, known);
    let model = known?.model ?? null;
    let modelFinal = known?.modelFinal ?? false;

    if (model === null && !modelFinal) {
        model = codexAgentModel(record.filePath);
        modelFinal = model !== null || size > MODEL_SCAN_BYTES;
    }

    const next: ScanEntry = {
        size,
        offset: scanned.offset,
        calls: scanned.calls,
        model,
        modelFinal,
        seen: context.now,
    };
    const previous = cache[record.filePath];
    const changed =
        !previous || previous.size !== size || previous.model !== model || previous.modelFinal !== modelFinal;

    cache[record.filePath] = next;

    return {
        changed,
        node: {
            id: record.id,
            harness: "codex",
            kind: "worker",
            name: head.nickname,
            description: head.agentPath ? basename(head.agentPath) : null,
            agentType: head.role,
            model: model ?? context.model,
            account: null,
            status: codexTurnState({ filePath: record.filePath, mtime: record.mtime, now: context.now }),
            startedAt: head.startedAt,
            lastAt: iso(record.mtime),
            toolCalls: scanned.calls,
            unreadMail: 0,
            team: null,
            backendType: null,
            filePath: record.filePath,
            spawnPrompt: null,
            spawnPromptPreview: null,
            toolUseId: null,
            spawnDepth: head.depth,
            children: [],
        },
    };
}

/**
 * Every sub-agent grouped under the thread that spawned it. A sub-agent that spawned others holds
 * them in its `children`; the map's keys are the threads at the top, normally the lead sessions.
 * An agent whose rollout cannot be read is left out, never an error for the whole list.
 */
export function attachCodexAgents(records: CodexAgentRecord[], context: CodexAgentsContext): Map<string, AgentNode[]> {
    const cachePath = context.cachePath ?? defaultCachePath();
    const cache = loadCache(cachePath);
    const byId = new Map<string, AgentNode>();
    const parents = new Map<string, string>();
    const roots = new Map<string, string>();
    let changed = false;

    for (const record of records) {
        const head = codexAgentHeadOf(record.filePath);

        if (!head) {
            continue;
        }

        let built: { node: AgentNode; changed: boolean };

        // The head read above is not the only one: the tool-call scan reads the rest of the file,
        // and a rollout removed or truncated in between must not take the whole list down.
        try {
            built = nodeOf(record, head, context, cache);
        } catch (error) {
            logger.debug({ error, path: record.filePath }, "[hub agents] unreadable codex agent rollout");
            continue;
        }

        changed = changed || built.changed;
        byId.set(record.id, built.node);
        parents.set(record.id, head.parentId);
        roots.set(record.id, record.rootId);
    }

    const tops = new Map<string, AgentNode[]>();

    for (const [id, node] of byId) {
        const parentId = parents.get(id) ?? "";
        const owner = parentId === id ? undefined : byId.get(parentId);

        if (owner) {
            owner.children.push(node);
            continue;
        }

        // A spawner outside the listed records (older than the window) leaves its sub-agent under
        // the conversation's lead rather than under an id no list row carries.
        const top = parentId !== id && !byId.has(parentId) ? (roots.get(id) ?? parentId) : parentId;
        tops.set(top, [...(tops.get(top) ?? []), node]);
    }

    for (const nodes of tops.values()) {
        sortNodes(nodes);
    }

    if (changed) {
        saveCache(cachePath, cache, context.now);
    }

    return tops;
}

function withDefaults(nodes: AgentNode[], row: ParentRow): AgentNode[] {
    return nodes.map((node) => ({
        ...node,
        model: node.model ?? row.model,
        account: node.account ?? row.account,
        children: withDefaults(node.children, row),
    }));
}

/** A Codex session as a parent: its sub-agents are the children, the row is its own transcript. */
export function buildCodexParent(
    row: ParentRow,
    children: AgentNode[],
    now: number,
    startedAt: string | null
): AgentParent {
    const nodes = withDefaults(children, row);

    return {
        sessionId: row.sessionId,
        provider: "codex",
        title: row.title,
        project: row.project,
        cwd: row.cwd,
        filePath: row.filePath,
        model: row.model,
        account: row.account,
        startedAt,
        lastAt: iso(row.mtime),
        live: now - row.mtime < LIVE_PARENT_MS || hasRunning(nodes),
        children: nodes,
    };
}
