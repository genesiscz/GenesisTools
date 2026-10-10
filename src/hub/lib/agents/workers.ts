import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { type CodexSessionMeta, CodexSessionStore, codexWorkerHome, deriveSessionStatus } from "@app/codex/lib/store";
import { type GrokSessionMeta, GrokSessionStore } from "@app/grok/lib/store";
import { grokAccountNameLookup } from "@genesiscz/utils/ai/providers/plugins/grok-sub/discover";
import { scanCodexWorkerToolCalls, scanGrokToolCalls } from "@genesiscz/utils/ai/transcripts/file-scan";
import { SPAWN_PROMPT_CHARS } from "@genesiscz/utils/ai/transcripts/subagents";
import { sessionsDir as codexSessionsDir } from "@genesiscz/utils/codex/worker-paths";
import { sessionsDir as grokSessionsDir } from "@genesiscz/utils/grok/worker-paths";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { promptPreview } from "./tree";
import type { AgentNode, AgentStatus } from "./types";

/** A codex or grok worker, with the lead session it reports to (its bus rendezvous). */
export interface WorkerAgent {
    node: AgentNode;
    rendezvousSession: string | null;
}

/** A grok turn with no end record is `running` until its file is this quiet, then `killed`. */
const GROK_STALE_MS = 15 * 60 * 1000;

function mtimeMs(path: string): number | null {
    try {
        return statSync(path).mtimeMs;
    } catch {
        return null;
    }
}

function iso(ms: number): string {
    return new Date(ms).toISOString();
}

function codexStatus(meta: CodexSessionMeta, now: number): AgentStatus {
    const status = deriveSessionStatus(meta, now);
    switch (status) {
        case "starting":
        case "running":
            return "running";
        case "ready":
        case "stalled":
            return "idle";
        case "failed":
            return "failed";
        default:
            return "completed";
    }
}

function codexPrompt(dir: string, name: string, promptChars: number): string | null {
    const path = join(dir, `${name}.launch.json`);
    try {
        const launch: unknown = SafeJSON.parse(readFileSync(path, "utf8"), { strict: true });
        const prompt = typeof launch === "object" && launch !== null && "prompt" in launch ? launch.prompt : undefined;
        return typeof prompt === "string" && prompt.length > 0 ? prompt.slice(0, promptChars) : null;
    } catch (error) {
        logger.debug({ error, path }, "[hub agents] no codex launch prompt");
        return null;
    }
}

/**
 * One `tools codex` worker: its meta, its event log (`<name>.jsonl`) and its launch prompt, cut to
 * `promptChars` (the one-agent door passes `Infinity`).
 */
export function codexWorkerNode(
    meta: CodexSessionMeta,
    dir: string,
    now: number,
    promptChars: number = SPAWN_PROMPT_CHARS
): WorkerAgent {
    const filePath = join(dir, `${meta.name}.jsonl`);
    const fileMtime = mtimeMs(filePath);
    const eventAt = Date.parse(meta.lastEventAt);
    const lastMs = Math.max(fileMtime ?? 0, Number.isFinite(eventAt) ? eventAt : 0);
    const prompt = codexPrompt(dir, meta.name, promptChars);
    return {
        rendezvousSession: meta.rendezvousSession || null,
        node: {
            id: meta.name,
            harness: "codex",
            kind: "worker",
            name: meta.name,
            description: null,
            agentType: null,
            model: meta.model ?? null,
            account: meta.accountName ?? meta.accountId ?? null,
            status: codexStatus(meta, now),
            startedAt: meta.startedAt || null,
            lastAt: iso(lastMs || now),
            toolCalls: fileMtime === null ? 0 : (scanCodexWorkerToolCalls(filePath) ?? 0),
            unreadMail: 0,
            team: null,
            backendType: null,
            filePath: fileMtime === null ? null : filePath,
            nativeSessionId: meta.threadId ?? null,
            sourceHome: codexWorkerHome(meta),
            spawnPrompt: prompt,
            spawnPromptPreview: promptPreview(prompt),
            toolUseId: null,
            spawnDepth: 1,
            children: [],
        },
    };
}

/**
 * The grok meta is written only after a turn's process exits, so `turns` counts finished turns and
 * a running turn exists only as the next turn's log file (`grokDriver.latestTurn` reads it the same way).
 */
function grokTurns(meta: GrokSessionMeta, dir: string): { turns: number; active: boolean; lastFile: string } {
    const finished = Math.max(meta.turns, meta.lastTurn?.turn ?? 0);
    const activeFile = join(dir, `${meta.name}.turn${finished + 1}.jsonl`);
    if (mtimeMs(activeFile) !== null) {
        return { turns: finished + 1, active: true, lastFile: activeFile };
    }

    return { turns: finished, active: false, lastFile: join(dir, `${meta.name}.turn${Math.max(1, finished)}.jsonl`) };
}

function grokStatus({
    meta,
    active,
    lastMs,
    now,
}: {
    meta: GrokSessionMeta;
    active: boolean;
    lastMs: number;
    now: number;
}): AgentStatus {
    const last = meta.lastTurn;
    if (active || (last && !last.ended)) {
        return now - lastMs > GROK_STALE_MS ? "killed" : "running";
    }

    if (last && last.exitCode !== 0 && last.exitCode !== null) {
        return "failed";
    }

    return "completed";
}

/** One `tools grok` worker: its meta and its turn files (`<name>.turn<N>.jsonl`, the last one opens). */
export function grokWorkerNode(
    meta: GrokSessionMeta,
    dir: string,
    now: number,
    accountOf: (home: string) => string | undefined = () => undefined
): WorkerAgent {
    const { turns, active } = grokTurns(meta, dir);
    const turnFiles = Array.from({ length: turns }, (_, index) => join(dir, `${meta.name}.turn${index + 1}.jsonl`));
    const present = turnFiles.filter((path) => mtimeMs(path) !== null);
    const lastFile = present.at(-1) ?? null;
    const turnAt = meta.lastTurn ? Date.parse(meta.lastTurn.at) : Number.NaN;
    const lastMs = Math.max(
        ...present.map((path) => mtimeMs(path) ?? 0),
        Number.isFinite(turnAt) ? turnAt : 0,
        Date.parse(meta.createdAt) || 0
    );
    let account: string | null = null;
    try {
        account = accountOf(meta.workerHome) ?? null;
    } catch (error) {
        logger.debug({ error, home: meta.workerHome }, "[hub agents] grok account unavailable");
    }

    return {
        rendezvousSession: meta.rendezvousSession ?? null,
        node: {
            id: meta.name,
            harness: "grok",
            kind: "worker",
            name: meta.name,
            description: null,
            agentType: null,
            model: meta.model ?? null,
            account,
            status: grokStatus({ meta, active, lastMs, now }),
            startedAt: meta.createdAt || null,
            lastAt: iso(lastMs || now),
            toolCalls: present.reduce((sum, path) => sum + (scanGrokToolCalls(path) ?? 0), 0),
            unreadMail: 0,
            team: null,
            backendType: null,
            filePath: lastFile,
            nativeSessionId: meta.sessionId,
            sourceHome: meta.workerHome,
            spawnPrompt: null,
            spawnPromptPreview: null,
            toolUseId: null,
            spawnDepth: 1,
            children: [],
        },
    };
}

export interface ListWorkersOptions {
    now: number;
    /** Keep workers active at or after this epoch ms; a running one is kept whatever its age. */
    since: number;
    /** Spawn prompt characters kept per codex worker. Default `SPAWN_PROMPT_CHARS`. */
    promptChars?: number;
}

/**
 * Every codex and grok worker active in the window, read through their own session stores. The
 * metas are small; a worker's event log is only scanned once it is known to be in the window.
 */
export async function listWorkers({
    now,
    since,
    promptChars = SPAWN_PROMPT_CHARS,
}: ListWorkersOptions): Promise<WorkerAgent[]> {
    const workers: WorkerAgent[] = [];
    const inWindow = (path: string, lastAt: string | undefined): boolean => {
        const at = Math.max(mtimeMs(path) ?? 0, lastAt ? Date.parse(lastAt) || 0 : 0);
        return at >= since;
    };

    const codex = new CodexSessionStore();
    const codexDir = codexSessionsDir();
    for (const name of codex.listNames()) {
        const meta = codex.readMeta(name);
        if (!meta) {
            continue;
        }

        const running = codexStatus(meta, now) === "running";
        if (running || inWindow(join(codexDir, `${name}.jsonl`), meta.lastEventAt)) {
            workers.push(codexWorkerNode(meta, codexDir, now, promptChars));
        }
    }

    const grok = new GrokSessionStore();
    const grokDir = grokSessionsDir();
    let accountOf: (home: string) => string | undefined = () => undefined;
    try {
        accountOf = await grokAccountNameLookup();
    } catch (error) {
        logger.debug({ error }, "[hub agents] grok account lookup unavailable");
    }

    for (const name of grok.listNames()) {
        const meta = grok.readMeta(name);
        if (!meta) {
            continue;
        }

        const { active, lastFile } = grokTurns(meta, grokDir);
        const unended = active || (meta.lastTurn !== undefined && !meta.lastTurn.ended);
        const running = unended && (mtimeMs(lastFile) ?? 0) >= now - GROK_STALE_MS;
        if (running || inWindow(lastFile, meta.lastTurn?.at ?? meta.createdAt)) {
            workers.push(grokWorkerNode(meta, grokDir, now, accountOf));
        }
    }

    logger.debug({ count: workers.length, since: iso(since) }, "[hub agents] listed workers");
    return workers;
}
