import { randomInt } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { atomicWriteFileSync } from "@genesiscz/utils/storage/atomic-file";
import { rmDataDir } from "./config";
import { appendRmLedger } from "./ledger";
import type { RmCaller, RmTargetKind } from "./rules";

export type RmRequestKind = "delete" | "root";
export type RmRequestStatus = "pending" | "approved" | "denied" | "expired";

export interface RmRequestTarget {
    path: string;
    kind: RmTargetKind;
    rule: string;
    reason: string;
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

function requestFile(dir: string, id: string): string {
    return join(dir, `${id}.json`);
}

export function saveRmRequest(request: RmRequest, dir = rmRequestsDir()): void {
    mkdirSync(dir, { recursive: true });
    atomicWriteFileSync(requestFile(dir, request.id), `${SafeJSON.stringify(request, null, 2)}\n`);
}

export function createRmRequest(
    input: Pick<RmRequest, "kind" | "caller" | "cwd" | "reason" | "targets">,
    dir = rmRequestsDir(),
    now = new Date()
): RmRequest {
    let id = newRequestId();

    while (existsSync(requestFile(dir, id))) {
        id = newRequestId();
    }

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

/** The request with its expiry applied (a pending request past its TTL reads as `expired`). */
export function loadRmRequest(id: string, dir = rmRequestsDir(), now = new Date()): RmRequest | null {
    const file = requestFile(dir, id);

    if (!/^[a-z0-9]{4,12}$/.test(id) || !existsSync(file)) {
        return null;
    }

    try {
        const parsed: unknown = SafeJSON.parse(readFileSync(file, "utf8"));

        if (!isRmRequest(parsed)) {
            return null;
        }

        if (parsed.status === "pending" && now.getTime() - Date.parse(parsed.createdAt) > RM_REQUEST_TTL_MS) {
            return { ...parsed, status: "expired" };
        }

        return parsed;
    } catch (error) {
        logger.debug({ file, error }, "rm: unreadable request");
        return null;
    }
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
