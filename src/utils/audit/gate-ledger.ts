import { existsSync } from "node:fs";
import { readLastLines } from "@genesiscz/utils/fs/read-lines";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { isProcessAliveSince } from "@genesiscz/utils/process-identity";
import { listRmRequests, RM_REQUEST_TTL_MS, type RmRequest } from "@genesiscz/utils/rm/requests";
import { gatesAuditPath } from "./gates";

/**
 * The gate ledger (mobile plan M14): one pending list of every request that waits on the Mac's Touch ID, read from the
 * gate audit trail (`gates.jsonl`) and the rm request files. Read only: the decision stays on the Mac.
 *
 * Each live approval window is one app `--rpc` process, and every line it writes carries `writer.pid` and
 * `writer.app`. The trail is folded per gate and writer pid: a `prompted` line opens a window, any later line of the
 * same gate and pid closes it. A window waits while its writer runs (started before its `prompted` line, so a reused
 * pid does not count) and its deadline has not passed. A line without `writer.app` comes from TypeScript; the AI
 * account gate writes each decision there a second time (`appendAudit` in `src/utils/ai/gate/grants.ts`), so those
 * lines are skipped. Old lines are history.
 */

/** The gates whose window waits on a person at the Mac. */
export type WaitingGateKind = "vault" | "ai-account" | "rm";

/** An open approval window: the app process that shows it and when it gives up. */
export interface GateWindow {
    pid: number;
    openedAt: string;
    deadline: string;
}

/** One rm request file that waits for an answer. */
export interface GateRmRequest {
    id: string;
    reason: string | null;
    paths: Array<{ path: string; bytes?: number; reason: string }>;
    /** When the request file expires unanswered. */
    expiresAt: string;
}

export interface GateWait {
    /** `<gate>:<pid>` for a window, `rm:<request id>` for an rm request. */
    id: string;
    gate: WaitingGateKind;
    /** What the window says, or a summary of the request. */
    title: string;
    /** Who asked: the client, the agent or the session. */
    who: string | null;
    askedAt: string;
    /** The window, while one is open. An rm request without a window has none. */
    window: GateWindow | null;
    /** The rm request behind it (rm only). */
    request: GateRmRequest | null;
    /** The AI account and provider (ai-account only). */
    account?: string;
    provider?: string;
}

/** A window a person answered, or that gave up, newest first. */
export interface GateDecision {
    gate: WaitingGateKind;
    event: string;
    at: string;
    who: string | null;
    title: string;
}

export interface GateLedger {
    pending: GateWait[];
    recent: GateDecision[];
}

interface TrailLine {
    gate: WaitingGateKind;
    event: string;
    at: string;
    atMs: number;
    pid: number;
    fields: Record<string, unknown>;
}

interface WaitingGate {
    label: string;
    /** Seconds from `prompted` until the window answers deny by itself (`gateDeadlineSeconds` and friends in Swift). */
    deadlineSeconds: number;
    title(fields: Record<string, unknown>): string;
    who(fields: Record<string, unknown>): string | null;
}

function record(value: unknown): Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : {};
}

function str(value: unknown): string | null {
    return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function shownTitle(fields: Record<string, unknown>): string | null {
    return str(record(fields.shown).title);
}

/**
 * Every waiting gate's facts. The deadlines match the Swift windows: `gateDeadlineSeconds` (Gate.swift),
 * `windowSeconds` (VaultUnlock.swift; a window that waited on the lock gets less) and `rmDeadlineSeconds`
 * (RmApprove.swift).
 */
export const WAITING_GATES = {
    vault: {
        label: "Vault key",
        deadlineSeconds: 170,
        title: (fields) => shownTitle(fields) ?? str(fields.detail) ?? "Vault unlock",
        who: (fields) => str(record(fields.client).name) ?? str(record(fields.client).command),
    },
    "ai-account": {
        label: "AI account",
        deadlineSeconds: 170,
        title: (fields) =>
            shownTitle(fields) ?? `${str(fields.provider) ?? "AI"} account ${str(fields.account) ?? ""}`.trim(),
        who: (fields) => str(record(fields.client).name),
    },
    rm: {
        label: "Delete request",
        deadlineSeconds: 170,
        title: (fields) => str(fields.title) ?? shownTitle(fields) ?? "Delete request",
        who: (fields) => str(fields.caller),
    },
} as const satisfies Record<WaitingGateKind, WaitingGate>;

function isWaitingGate(value: unknown): value is WaitingGateKind {
    return typeof value === "string" && Object.hasOwn(WAITING_GATES, value);
}

/** One trail line, when the app wrote it for a waiting gate. A TypeScript line (no `writer.app`) is skipped. */
export function parseTrailLine(line: string): TrailLine | null {
    let parsed: unknown;

    try {
        parsed = SafeJSON.parse(line, { strict: true });
    } catch (error) {
        logger.debug({ error }, "gate ledger: skipped a line that is not JSON");
        return null;
    }

    const fields = record(parsed);
    const writer = record(fields.writer);
    const pid = writer.pid;
    const at = str(fields.at);
    const event = str(fields.event);

    if (!isWaitingGate(fields.gate) || !str(writer.app) || typeof pid !== "number" || !at || !event) {
        return null;
    }

    const atMs = Date.parse(at);

    if (!Number.isFinite(atMs)) {
        return null;
    }

    return { gate: fields.gate, event, at, atMs, pid, fields };
}

export interface GateLedgerDeps {
    /** The trail lines, oldest first. Default: the end of `gates.jsonl` (the newest `TRAIL_TAIL_BYTES`). */
    lines?: () => string[];
    /** Pending rm requests. Default: `listRmRequests()`. */
    rmRequests?: () => RmRequest[];
    /** Whether the window's process still runs and started before it wrote `openedAtMs`. */
    isWriterAlive?: (pid: number, openedAtMs: number) => boolean;
    now?: Date;
    /** How many decided windows to keep in `recent`. */
    recentLimit?: number;
}

/** The trail grows by thousands of lines a day; a window lives under three minutes, so the end is enough. */
export const TRAIL_TAIL_BYTES = 2 * 1024 * 1024;

function trailLines(): string[] {
    const path = gatesAuditPath();

    if (!existsSync(path)) {
        return [];
    }

    const { lines, wholeFile } = readLastLines(path, { maxBytes: TRAIL_TAIL_BYTES });

    if (!wholeFile) {
        logger.debug({ path, maxBytes: TRAIL_TAIL_BYTES }, "gate ledger: read the newest part of the trail only");
    }

    return lines;
}

function rmWho(request: RmRequest): string | null {
    const caller = request.caller;

    if (!caller) {
        return null;
    }

    return caller.sessionTitle ?? caller.project ?? caller.agent;
}

function rmTitle(request: RmRequest): string {
    const count = request.targets.length;
    const first = request.targets[0]?.path;

    if (request.kind === "root") {
        return `Trust ${first ?? "a folder"} as a root`;
    }

    return count === 1 && first ? `Delete ${first}` : `Delete ${count} paths`;
}

/** The pending list and the latest decisions. */
export function readGateLedger(deps: GateLedgerDeps = {}): GateLedger {
    const now = (deps.now ?? new Date()).getTime();
    const alive = deps.isWriterAlive ?? isProcessAliveSince;
    const open = new Map<string, TrailLine>();
    const decided: GateDecision[] = [];

    for (const raw of (deps.lines ?? trailLines)()) {
        const line = parseTrailLine(raw);

        if (!line) {
            continue;
        }

        const key = `${line.gate}:${line.pid}`;
        const gate = WAITING_GATES[line.gate];

        if (line.event === "prompted") {
            open.set(key, line);
            continue;
        }

        const opened = open.get(key);

        // A line without an open window is a decision no window asked for (a remembered grant answers by itself).
        if (!opened) {
            continue;
        }

        open.delete(key);
        const fields = { ...opened.fields, ...line.fields };
        decided.push({
            gate: line.gate,
            event: line.event,
            at: line.at,
            who: gate.who(fields),
            title: gate.title(fields),
        });
    }

    const windows: GateWait[] = [];
    const windowByRequest = new Map<string, GateWindow>();

    for (const [key, line] of open) {
        const gate = WAITING_GATES[line.gate];
        const deadlineMs = line.atMs + gate.deadlineSeconds * 1000;

        if (deadlineMs <= now || !alive(line.pid, line.atMs)) {
            continue;
        }

        const window: GateWindow = { pid: line.pid, openedAt: line.at, deadline: new Date(deadlineMs).toISOString() };
        const requestId = line.gate === "rm" ? str(line.fields.request) : null;

        if (requestId) {
            windowByRequest.set(requestId, window);
            continue;
        }

        windows.push({
            id: key,
            gate: line.gate,
            title: gate.title(line.fields),
            who: gate.who(line.fields),
            askedAt: line.at,
            window,
            request: null,
            ...(line.gate === "ai-account"
                ? { account: str(line.fields.account) ?? undefined, provider: str(line.fields.provider) ?? undefined }
                : {}),
        });
    }

    const requests: GateWait[] = (deps.rmRequests ?? listRmRequests)()
        .filter((request) => request.status === "pending")
        .map((request) => ({
            id: `rm:${request.id}`,
            gate: "rm" as const,
            title: rmTitle(request),
            who: rmWho(request),
            askedAt: request.createdAt,
            window: windowByRequest.get(request.id) ?? null,
            request: {
                id: request.id,
                reason: request.reason,
                paths: request.targets.map((target) => ({
                    path: target.path,
                    reason: target.reason,
                    ...(target.bytes !== undefined ? { bytes: target.bytes } : {}),
                })),
                expiresAt: new Date(Date.parse(request.createdAt) + RM_REQUEST_TTL_MS).toISOString(),
            },
        }));

    const pending = [...windows, ...requests].sort((a, b) => a.askedAt.localeCompare(b.askedAt));
    const recent = decided.reverse().slice(0, deps.recentLimit ?? 10);
    return { pending, recent };
}
