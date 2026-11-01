import { randomInt } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { toolCommand } from "@genesiscz/utils/cli/tool-command";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { atomicWriteFileSync } from "@genesiscz/utils/storage/atomic-file";
import { type RmConfig, rmDataDir } from "./config";
import { appendRmLedger } from "./ledger";
import { effectiveConfig } from "./profiles";
import type { RmCaller, RmTargetKind } from "./rules";

export type RmRequestKind = "delete" | "root";
export type RmRequestStatus = "pending" | "approved" | "denied" | "expired" | "gone";

export interface RmRequestTarget {
    path: string;
    kind: RmTargetKind;
    rule: string;
    reason: string;
    /** Where an aside move put it, while it waits for the user. */
    stored?: string;
    /** Its allocated size, measured after the aside move by requests made before the measurement pass. */
    bytes?: number;
}

/** What an agent asked the user to allow: deleting paths no rule allows, or trusting a folder as a root. */
export interface RmRequest {
    id: string;
    kind: RmRequestKind;
    createdAt: string;
    caller: RmCaller | null;
    cwd: string;
    /** The agent's own words for why. */
    reason: string | null;
    targets: RmRequestTarget[];
    status: RmRequestStatus;
    decidedAt?: string;
    decidedVia?: string;
    /** The aside folder holding the paths that were moved out of the way (no TTL: they wait for a decision). */
    asideDir?: string;
    /** What the person picked: the paths approved and the paths denied (put back), and how the approved ones go. */
    decided?: RmRequestDecision;
    /** The newest trash batch an approval made; kept for readers older than `batchIds`. */
    batchId?: string;
    /** Every trash batch the approvals made, oldest first; `tools rm restore <request id>` restores each. */
    batchIds?: string[];
    /** The person's note on a deny, shown to the agent when it asks for the same path again. */
    deniedNote?: string;
}

/** How approved items leave: the trash (restorable for a short grace) or deleted at once. */
export type RmDisposal = "trash" | "permanent";

/** Whether an approval also trusts the item's folder: not at all, for the asking session, or for everyone. */
export type RmRememberChoice = "once" | "session" | "folder";

/** Minutes approved items wait in the trash before the drain: "Move to the trash (deleted after 10 minutes)". */
export const RM_APPROVED_TRASH_MINUTES = 10;

/** How long "this session, this folder" trusts the folder. */
export const RM_SESSION_ROOT_HOURS = 8;

/** The trash grace a disposal means: none for a permanent delete, else `trashMinutes` (default 10). */
export function disposalGraceMinutes(disposal: RmDisposal, trashMinutes = RM_APPROVED_TRASH_MINUTES): number {
    return disposal === "permanent" ? 0 : trashMinutes;
}

export interface RmRequestDecision {
    approved: string[];
    denied: string[];
    disposal?: RmDisposal;
    remember?: RmRememberChoice;
}

/** A request older than this is expired: the user answers fresh asks, not yesterday's. */
export const RM_REQUEST_TTL_MS = 24 * 60 * 60_000;

const ID_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";

export function rmRequestsDir(): string {
    return rmDataDir("requests");
}

function newRequestId(): string {
    return Array.from({ length: 6 }, () => ID_ALPHABET[randomInt(ID_ALPHABET.length)]).join("");
}

/** A request id no saved request in `dir` uses yet, for a request drafted before it is saved. */
export function reserveRmRequestId(dir = rmRequestsDir()): string {
    let id = newRequestId();

    while (existsSync(requestFile(dir, id))) {
        id = newRequestId();
    }

    return id;
}

/** Where request `id` is saved. */
export function rmRequestFile(id: string, dir = rmRequestsDir()): string {
    return join(dir, `${id}.json`);
}

function requestFile(dir: string, id: string): string {
    return rmRequestFile(id, dir);
}

export function saveRmRequest(request: RmRequest, dir = rmRequestsDir()): void {
    mkdirSync(dir, { recursive: true });
    atomicWriteFileSync(requestFile(dir, request.id), `${SafeJSON.stringify(request, null, 2)}\n`);
}

/** Saves a new pending request; `id` is one `reserveRmRequestId` gave out earlier, else a fresh one. */
export function createRmRequest(
    input: Pick<RmRequest, "kind" | "caller" | "cwd" | "reason" | "targets" | "asideDir"> & { id?: string },
    dir = rmRequestsDir(),
    now = new Date()
): RmRequest {
    const id = input.id ?? reserveRmRequestId(dir);
    const request: RmRequest = { ...input, id, createdAt: now.toISOString(), status: "pending" };
    saveRmRequest(request, dir);
    appendRmLedger({
        action: "request",
        requestId: id,
        reason: input.reason ?? undefined,
        caller: input.caller,
        path: input.targets.map((t) => t.path).join(", "),
    });
    logger.debug({ id, kind: input.kind, targets: input.targets.length }, "rm: request created");
    return request;
}

/** An approved deletion uses the requester's policy, not the approving person's profile. */
export function approvalGraceMinutes(request: RmRequest, base: RmConfig): number {
    return (request.caller ? effectiveConfig(base, request.caller, request.cwd).config : base).grace.otherMinutes;
}

function isRmRequest(value: unknown): value is RmRequest {
    return (
        typeof value === "object" &&
        value !== null &&
        "id" in value &&
        typeof value.id === "string" &&
        "status" in value &&
        typeof value.status === "string" &&
        "targets" in value &&
        Array.isArray(value.targets)
    );
}

/** A request read from `file` as it is saved; null when it cannot be read or is not a request. */
export function readRmRequestFile(file: string): RmRequest | null {
    try {
        const parsed: unknown = SafeJSON.parse(readFileSync(file, "utf8"));
        return isRmRequest(parsed) ? parsed : null;
    } catch (error) {
        logger.debug({ file, error }, "rm: unreadable request");
        return null;
    }
}

/** The request with its expiry applied (a pending request past its TTL reads as `expired`). */
export function loadRmRequest(id: string, dir = rmRequestsDir(), now = new Date()): RmRequest | null {
    const file = requestFile(dir, id);

    if (!/^[a-z0-9]{4,12}$/.test(id) || !existsSync(file)) {
        return null;
    }

    const parsed = readRmRequestFile(file);

    if (!parsed) {
        return null;
    }

    if (
        parsed.status === "pending" &&
        !parsed.asideDir &&
        now.getTime() - Date.parse(parsed.createdAt) > RM_REQUEST_TTL_MS
    ) {
        return { ...parsed, status: "expired" };
    }

    return parsed;
}

export function listRmRequests(options: { all?: boolean; dir?: string; now?: Date } = {}): RmRequest[] {
    const dir = options.dir ?? rmRequestsDir();

    if (!existsSync(dir)) {
        return [];
    }

    return readdirSync(dir)
        .filter((name) => name.endsWith(".json"))
        .map((name) => loadRmRequest(name.slice(0, -5), dir, options.now))
        .filter((request): request is RmRequest => request !== null)
        .filter((request) => options.all || request.status === "pending")
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/** Every trash batch the approvals of `request` made, oldest first; a file saved before `batchIds` has `batchId` only. */
export function requestBatchIds(request: Pick<RmRequest, "batchId" | "batchIds">): string[] {
    if (request.batchIds && request.batchIds.length > 0) {
        return request.batchIds;
    }

    return request.batchId ? [request.batchId] : [];
}

/** The trash batch the approved request `id` made; null when there is no such request or it made none. */
export function requestBatchId(id: string, dir = rmRequestsDir()): string | null {
    const request = loadRmRequest(id, dir);

    if (!request) {
        return null;
    }

    return request.batchId ?? null;
}

/**
 * The one line an agent must pass on, which stands alone: agents often keep only `| tail -1` of `tools rm`, and a
 * hook repeats it when the output was cut (`>/dev/null`).
 */
export function rmRequestHintLine(id: string, count: number): string {
    const rm = toolCommand("rm");
    return (
        `rm request ${id}: ${count} path(s) wait for the user. Do not run approve yourself. ` +
        `Tell the user: ! ${rm} approve ${id}. Cancel your own: ${rm} deny ${id}`
    );
}

/** For each path, the other pending requests that name it too (an agent asked twice). */
export function requestsAlsoNaming(
    paths: readonly string[],
    exceptId: string,
    pending: readonly RmRequest[]
): Map<string, string[]> {
    const found = new Map<string, string[]>();

    for (const path of paths) {
        const ids = pending
            .filter((request) => request.id !== exceptId && request.status === "pending")
            .filter((request) => request.targets.some((target) => target.path === path))
            .map((request) => request.id);

        if (ids.length > 0) {
            found.set(path, ids);
        }
    }

    return found;
}

/**
 * For each in-place path, the pending request of the same agent and session that already names it in place: asking
 * again would open a second request for the same object (n5vpfy and yzbyqx, 2026-11-01).
 */
export function alreadyAskedInPlace(
    paths: readonly string[],
    caller: Pick<RmCaller, "agent" | "sessionId">,
    pending: readonly RmRequest[]
): Map<string, string> {
    const found = new Map<string, string>();

    if (!caller.sessionId) {
        return found;
    }

    const own = pending
        .filter((request) => request.status === "pending" && request.kind === "delete")
        .filter((request) => request.caller?.agent === caller.agent && request.caller?.sessionId === caller.sessionId)
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt));

    for (const path of paths) {
        const hit = own.find((request) => request.targets.some((target) => !target.stored && target.path === path));

        if (hit) {
            found.set(path, hit.id);
        }
    }

    return found;
}

export interface RmPriorDenial {
    path: string;
    requestId: string;
    decidedAt: string;
    note: string | null;
}

/**
 * The person's latest deny, in the approval window, of a request from this session that named one of `paths`. An
 * agent's own cancel (`tools rm deny`, decided via `cli`) is not a person's answer and is skipped.
 */
export function priorDenials(
    paths: readonly string[],
    sessionId: string | null,
    requests: readonly RmRequest[]
): RmPriorDenial[] {
    if (!sessionId) {
        return [];
    }

    const denied = requests
        .filter((request) => request.status === "denied" && request.decidedVia !== "cli")
        .filter((request) => request.caller?.sessionId === sessionId)
        .sort((a, b) => (b.decidedAt ?? "").localeCompare(a.decidedAt ?? ""));
    const result: RmPriorDenial[] = [];

    for (const path of paths) {
        const hit = denied.find(
            (request) =>
                request.decided?.denied.includes(path) || request.targets.some((target) => target.path === path)
        );

        if (hit) {
            result.push({
                path,
                requestId: hit.id,
                decidedAt: hit.decidedAt ?? hit.createdAt,
                note: hit.deniedNote ?? null,
            });
        }
    }

    return result;
}
