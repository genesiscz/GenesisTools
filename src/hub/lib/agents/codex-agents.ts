import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { basename, dirname } from "node:path";
import { POLLED_LISTING_REUSE_MS } from "@app/ai/lib/sessions/agent-session-rows";
import { catalogHistory } from "@genesiscz/utils/agent-sessions/open-service";
import { resolveHistoryProvider } from "@genesiscz/utils/agent-sessions/provider";
import { CODEX_MODEL_HEAD_BYTES } from "@genesiscz/utils/agent-sessions/readers/codex-model";
import { countCodexToolCalls } from "@genesiscz/utils/agent-sessions/readers/codex-turn-state";
import type { NativeSessionSource, SpawnLink } from "@genesiscz/utils/agent-sessions/types";
import { readTurnState } from "@genesiscz/utils/ai/transcripts/turn-state";
import { concurrentMap } from "@genesiscz/utils/async";
import { isZstdPath } from "@genesiscz/utils/compress/zstd";
import { readLinesSync } from "@genesiscz/utils/fs/read-lines";
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

const SCAN_CHUNK_BYTES = 16 * 1024 * 1024;
/** A turn with no end record is `running` until its file is this quiet, then `killed`. */
const TURN_STALE_MS = 15 * 60 * 1000;
/** A rollout with no turn marker in its tail: fresh means running. */
const NO_MARKER_FRESH_MS = 2 * 60 * 1000;
const CACHE_KEEP_MS = 7 * 24 * 3_600_000;
/** Rollout headers read at once when the scan cache misses: each read opens and may decompress a file. */
const SPAWN_LINK_READS = 8;

/** One Codex sub-agent rollout from the session index. */
export interface CodexAgentRecord {
    /** The sub-agent's own thread id. */
    id: string;
    /** The conversation it belongs to (`session_id`): the topmost thread. */
    rootId: string;
    filePath: string;
    mtime: number;
    cwd: string;
    /** When the rollout began (its header's timestamp), as the session index recorded it. */
    startedAt: string | null;
}

export interface CodexAgentsContext {
    readOnly?: boolean;
    now: number;
    /** The model shown when a rollout does not say; the parent's. */
    model: string | null;
    /** Tests point this at a temp file; production uses the tool's data dir. */
    cachePath?: string;
}

/** Sub-agent rollouts the session index saw written at or after `since`. */
export async function recentCodexAgentRecords({
    since,
    refresh,
}: {
    since: number;
    refresh?: boolean;
}): Promise<CodexAgentRecord[]> {
    const catalog = await catalogHistory({
        provider: "codex",
        refresh,
        filters: { agentsOnly: true, mtimeFrom: since },
        maxDiscoveryAgeMs: POLLED_LISTING_REUSE_MS,
    });

    return catalog.metadata.flatMap((record) =>
        record.nativeId && record.mtime >= since
            ? [
                  {
                      id: record.nativeId,
                      rootId: record.parentNativeId ?? record.nativeId,
                      filePath: record.filePath,
                      mtime: record.mtime,
                      cwd: record.cwd ?? "",
                      startedAt: record.firstTimestamp,
                  },
              ]
            : []
    );
}

/** A plain rollout's bytes. A `.jsonl.zst` one is read through `readHead` / `readTailWindow` and never by offset. */
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

/**
 * The spawn link of a sub-agent rollout, from the Codex reader (`readSpawnLink` reads its header). Null for a rollout
 * that is not a sub-agent or cannot be read.
 */
async function spawnLinkOf(record: CodexAgentRecord): Promise<SpawnLink | null> {
    // The Codex spawn link is read from the rollout alone, so its folder stands in for the session root and home.
    const folder = dirname(record.filePath);
    const source: NativeSessionSource<"codex"> = {
        kind: "codex",
        root: folder,
        sourceHome: folder,
        filePath: record.filePath,
        dataPaths: [record.filePath],
        metadataPaths: [],
    };

    try {
        return await resolveHistoryProvider("codex").reader.readSpawnLink(source);
    } catch (error) {
        logger.debug({ error, path: record.filePath }, "[hub agents] unreadable codex agent header");
        return null;
    }
}

/** A link a cache file holds, checked, because the file is read back from disk. */
function isSpawnLink(value: unknown): value is SpawnLink {
    return (
        typeof value === "object" &&
        value !== null &&
        "parentSessionId" in value &&
        typeof value.parentSessionId === "string"
    );
}

/** The size and inode of a file, or null when it cannot be read. */
function fileState(path: string): { size: number; ino: number } | null {
    try {
        const status = statSync(path);
        return { size: status.size, ino: status.ino };
    } catch (error) {
        logger.debug({ error, path }, "[hub agents] codex agent file vanished");
        return null;
    }
}

/**
 * The spawn link from the scan cache when the entry was written for this file (same inode, not smaller), else read
 * from the rollout. Only a found link is kept: a file whose header is not written yet is read again on the next poll.
 */
async function cachedSpawnLink(record: CodexAgentRecord, cache: ScanCache): Promise<SpawnLink | null> {
    const saved = cache[record.filePath];
    const state = fileState(record.filePath);

    if (saved && state && saved.ino === state.ino && saved.size <= state.size && isSpawnLink(saved.link)) {
        return saved.link;
    }

    return spawnLinkOf(record);
}

/**
 * Where the agent's last turn stands, from the shared turn-state read of its rollout (`readTurnState`):
 * - a turn that ended: completed;
 * - a turn the user stopped (`turn_aborted`): killed;
 * - a question waiting for the user (`request_user_input`, open or the turn's last call): idle, the status the hub
 *   gives an agent parked on its user, unless Codex closed the rollout;
 * - a turn that began and has not ended: running while the file is fresh, killed once it went quiet for
 *   `TURN_STALE_MS` or once Codex closed it (a `.jsonl.zst` rollout);
 * - no turn record in the tail: running while the file is fresh, else completed.
 */
export function codexAgentStatus(options: { filePath: string; now: number }): AgentStatus {
    const { filePath, now } = options;
    const snapshot = readTurnState("codex", filePath, { now, stallTimeoutMs: TURN_STALE_MS });

    if (!snapshot) {
        return "completed";
    }

    if (snapshot.interrupted) {
        return "killed";
    }

    // A question the turn waits on also counts as its end, so it is checked first.
    if (snapshot.asksQuestion && snapshot.state !== "FINISHED") {
        return "idle";
    }

    if (snapshot.turnEnded) {
        return "completed";
    }

    if (snapshot.turnStartedAt !== null) {
        return snapshot.state === "RUNNING" ? "running" : "killed";
    }

    return snapshot.state !== "FINISHED" && snapshot.silenceMs < NO_MARKER_FRESH_MS ? "running" : "completed";
}

interface ScanEntry {
    /** File size when last read; a smaller file starts over. */
    size: number;
    /**
     * Inode when last read; another inode starts over. A rollout replaced by a larger file (written aside, renamed
     * over) would otherwise keep the old file's count, since only a smaller file was treated as new.
     */
    ino?: number;
    /** Bytes already counted: the end of the last complete line read. */
    offset: number;
    calls: number;
    model: string | null;
    /** Looked for in a file past the scan window, so a missing model is final. */
    modelFinal: boolean;
    seen: number;
    /**
     * The rollout's spawn link, read once per file state: a header never changes once written, so a poll of the same
     * (or a grown) file answers from here and does not read the head again. Absent in an entry written before it.
     */
    link?: SpawnLink;
}

type ScanCache = Record<string, ScanEntry>;

/**
 * Tool calls of an append-only rollout, counting only what was appended since the last read. A `.jsonl.zst` rollout
 * never grows: its decompressed lines are counted once, and the entry (offset = its size on disk) answers after that.
 */
function scanCalls(path: string, size: number, entry: ScanEntry | undefined): { calls: number; offset: number } {
    if (isZstdPath(path)) {
        if (entry && entry.size === size && entry.offset === size) {
            return { calls: entry.calls, offset: size };
        }

        let counted = 0;

        for (const line of readLinesSync(path)) {
            counted += countCodexToolCalls(line);
        }

        return { calls: counted, offset: size };
    }

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

        calls += countCodexToolCalls(whole);
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
    link: SpawnLink,
    context: CodexAgentsContext,
    cache: ScanCache
): { node: AgentNode; changed: boolean } {
    const state = fileState(record.filePath);
    const size = state?.size ?? 0;
    const ino = state?.ino;
    const saved = cache[record.filePath];
    const known = saved && saved.ino === ino && saved.size <= size ? saved : undefined;
    const scanned = scanCalls(record.filePath, size, known);
    let model = known?.model ?? null;
    let modelFinal = known?.modelFinal ?? false;

    // A rollout that grew may have started a turn on another model, so its model is read again; an unchanged one
    // keeps the cached answer.
    const grew = known !== undefined && size > known.size;

    if ((model === null && !modelFinal) || grew) {
        // A sub-agent often runs another model than the session that spawned it, so the parent's would be wrong.
        model = resolveHistoryProvider("codex").reader.currentModel(record.filePath) ?? model;
        // A compressed rollout is closed: a model it does not name never comes. Past the head window, a rollout whose
        // head and tail name none is not read again on every poll.
        modelFinal = model !== null || size > CODEX_MODEL_HEAD_BYTES || isZstdPath(record.filePath);
    }

    const next: ScanEntry = {
        size,
        ino,
        offset: scanned.offset,
        calls: scanned.calls,
        model,
        modelFinal,
        seen: context.now,
        link,
    };
    const previous = cache[record.filePath];
    const changed =
        !previous ||
        previous.size !== size ||
        previous.ino !== ino ||
        previous.model !== model ||
        previous.modelFinal !== modelFinal ||
        !isSpawnLink(previous.link);

    cache[record.filePath] = next;

    return {
        changed,
        node: {
            id: record.id,
            harness: "codex",
            kind: "worker",
            name: link.nickname ?? null,
            description: link.agentPath ? basename(link.agentPath) : null,
            agentType: link.role ?? null,
            model: model ?? context.model,
            account: null,
            status: codexAgentStatus({ filePath: record.filePath, now: context.now }),
            startedAt: record.startedAt,
            lastAt: iso(record.mtime),
            toolCalls: scanned.calls,
            unreadMail: 0,
            team: null,
            backendType: null,
            filePath: record.filePath,
            spawnPrompt: null,
            spawnPromptPreview: null,
            toolUseId: null,
            spawnDepth: link.depth ?? 1,
            children: [],
        },
    };
}

/**
 * Every sub-agent grouped under the thread that spawned it. A sub-agent that spawned others holds
 * them in its `children`; the map's keys are the threads at the top, normally the lead sessions.
 * An agent whose rollout cannot be read is left out, never an error for the whole list.
 */
export async function attachCodexAgents(
    records: CodexAgentRecord[],
    context: CodexAgentsContext
): Promise<Map<string, AgentNode[]>> {
    const cachePath = context.cachePath ?? defaultCachePath();
    const cache = loadCache(cachePath);
    // A cold cache (or a read-only roster with none) reads every header: a bounded pool keeps the open files flat.
    const linked = await concurrentMap({
        items: records,
        fn: (record) => cachedSpawnLink(record, cache),
        concurrency: SPAWN_LINK_READS,
        onError: (record, error) =>
            logger.debug({ error, path: record.filePath }, "[hub agents] codex agent header read failed"),
    });
    const links = records.map((record) => linked.get(record) ?? null);
    const byId = new Map<string, AgentNode>();
    const parents = new Map<string, string>();
    const roots = new Map<string, string>();
    let changed = false;

    for (const [index, record] of records.entries()) {
        const link = links[index];

        if (!link) {
            continue;
        }

        let built: { node: AgentNode; changed: boolean };

        // The header read above is not the only one: the tool-call scan reads the rest of the file,
        // and a rollout removed or truncated in between must not take the whole list down.
        try {
            built = nodeOf(record, link, context, cache);
        } catch (error) {
            logger.debug({ error, path: record.filePath }, "[hub agents] unreadable codex agent rollout");
            continue;
        }

        changed = changed || built.changed;
        byId.set(record.id, built.node);
        parents.set(record.id, link.parentSessionId);
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

    if (changed && !context.readOnly) {
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
