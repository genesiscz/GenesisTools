import { existsSync, lstatSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { logger } from "@genesiscz/utils/logger";
import { appendRmLedger } from "./ledger";
import {
    DESTINATION_TAKEN,
    ensurePrivateDir,
    isSameOrInside,
    realOrSelf,
    renameNoReplace,
    sharedTempRoot,
} from "./paths";
import { listRmRequests, type RmRequest, type RmRequestTarget, saveRmRequest } from "./requests";
import type { RmCaller, RmTarget, RmVerdict } from "./rules";
import { measureBytes, RmTargetChangedError, renameVerified, trashItemName } from "./trash";

/** The folder under the shared temp root each agent keeps its session scratch in. */
export const AGENT_SCRATCH_DIRS: Readonly<Record<string, string>> = {
    "claude-code": "cc",
    codex: "codex",
    grok: "grok",
    copilot: "copilot",
};

export function agentScratchDir(agent: string): string {
    return AGENT_SCRATCH_DIRS[agent] ?? "agents";
}

/** The roots a session's scratch may live under: the shared `cc` convention and the agent's own folder. */
export function sessionScratchRoots(caller: RmCaller): string[] {
    return [...new Set([join(sharedTempRoot(), "cc"), join(sharedTempRoot(), agentScratchDir(caller.agent))])];
}

function segment(value: string | null | undefined, fallback: string): string {
    const clean = (value ?? "").replace(/[^\w.-]/g, "_").slice(0, 80);
    return clean && clean !== "." && clean !== ".." ? clean : fallback;
}

/** `<tmp>/<agent dir>/<project>/<session>/rm-aside`: where this caller's paths wait for the user's decision. */
export function asideRootFor(caller: RmCaller): string {
    return join(
        sharedTempRoot(),
        agentScratchDir(caller.agent),
        segment(caller.project, "unknown-project"),
        segment(caller.sessionId, "no-session"),
        "rm-aside"
    );
}

export interface AsideInput {
    target: RmTarget;
    verdict: RmVerdict;
}

export interface AsideResult {
    dir: string;
    moved: RmRequestTarget[];
    /** Paths that stay where they are (on another volume, or the rename failed), with why. */
    kept: Array<{ input: AsideInput; reason: string }>;
}

/**
 * Renames each path into `<aside root>/<batch>/`, measuring it after the move. A path on another volume stays in
 * place (a copy is not a move aside), and so does one whose rename fails.
 */
export function moveAside(
    inputs: readonly AsideInput[],
    caller: RmCaller,
    batchId: string,
    root: string = asideRootFor(caller)
): AsideResult {
    const dir = join(root, batchId);
    const result: AsideResult = { dir, moved: [], kept: [] };

    try {
        // In the machine-wide /tmp: closed to other users, who could read what waits there or swap the folder.
        ensurePrivateDir(root, { ancestors: true });
    } catch (error) {
        const reason = `the aside folder is not private (${error instanceof Error ? error.message : String(error)})`;
        logger.warn({ root, error }, "rm: aside folder refused");
        result.kept.push(...inputs.map((input) => ({ input, reason })));
        return result;
    }

    for (const [index, input] of inputs.entries()) {
        const stored = join(dir, trashItemName(index, input.target.path));

        try {
            mkdirSync(dirname(stored), { recursive: true });
            renameVerified(input.target, stored);
        } catch (error) {
            const code = (error as NodeJS.ErrnoException).code;
            const reason =
                error instanceof RmTargetChangedError
                    ? error.message
                    : code === "EXDEV"
                      ? "on another volume than the aside folder"
                      : `the move failed (${code})`;
            logger.debug({ path: input.target.path, stored, error }, "rm: kept in place instead of aside");
            result.kept.push({ input, reason });
            continue;
        }

        const bytes = measureBytes(stored);
        result.moved.push({
            path: input.target.path,
            kind: input.target.kind,
            rule: input.verdict.rule,
            reason: input.verdict.reason,
            stored,
            bytes,
        });
        appendRmLedger({ action: "aside", path: input.target.path, stored, rule: input.verdict.rule, bytes, caller });
    }

    return result;
}

export interface ReturnResult {
    returned: string[];
    kept: Array<{ path: string; reason: string }>;
}

/** A seam for the test that recreates the original path between the check and the put-back. */
export interface ReturnHooks {
    beforeMove?: (path: string) => void;
}

/**
 * Moves aside items back to where they were (a denied request). The put-back never replaces anything: a path that
 * appeared there, even after the check, keeps its place and the aside copy keeps waiting.
 */
export function returnAside(
    targets: readonly RmRequestTarget[],
    caller: RmCaller | null,
    requestId: string,
    hooks: ReturnHooks = {}
): ReturnResult {
    const result: ReturnResult = { returned: [], kept: [] };

    for (const target of targets) {
        if (!target.stored) {
            continue;
        }

        if (!existsSync(target.stored) && !isLink(target.stored)) {
            result.kept.push({ path: target.path, reason: `the aside copy is gone (${target.stored})` });
            continue;
        }

        const taken = { path: target.path, reason: `something exists there now; it waits at ${target.stored}` };

        if (existsSync(target.path) || isLink(target.path)) {
            result.kept.push(taken);
            continue;
        }

        mkdirSync(dirname(target.path), { recursive: true });
        hooks.beforeMove?.(target.path);

        try {
            renameNoReplace(target.stored, target.path);
        } catch (error) {
            if (!DESTINATION_TAKEN.has((error as NodeJS.ErrnoException).code ?? "")) {
                throw error;
            }

            result.kept.push(taken);
            continue;
        }

        result.returned.push(target.path);
        appendRmLedger({ action: "return", path: target.path, stored: target.stored, requestId, caller });
    }

    return result;
}

/**
 * An agent may cancel only its own request (same agent, same session); a person, outside any agent, may deny any.
 * Otherwise one session could put another's paths back and close the decision its user still has to make.
 */
export function mayDenyRmRequest(request: RmRequest, caller: RmCaller): boolean {
    if (!caller.isInAgent) {
        return true;
    }

    return (
        caller.sessionId !== null &&
        request.caller?.agent === caller.agent &&
        request.caller?.sessionId === caller.sessionId
    );
}

export interface DenyResult extends ReturnResult {
    /** Aside copies that could not go home (the path is taken): the request stays pending for them. */
    waiting: RmRequestTarget[];
}

/**
 * Puts a request's aside copies back and closes it as denied. A copy that cannot go back keeps the request pending,
 * with only those copies left in it, so its aside folder stays guarded until the user decides about them.
 */
export function denyRmRequest(
    request: RmRequest,
    caller: RmCaller | null,
    options: { requestsDir?: string; now?: Date; hooks?: ReturnHooks } = {}
): DenyResult {
    const back = returnAside(request.targets, caller, request.id, options.hooks);
    const returned = new Set(back.returned);
    const waiting = request.targets.filter(
        (t) => t.stored !== undefined && !returned.has(t.path) && (existsSync(t.stored) || isLink(t.stored))
    );
    const decidedAt = (options.now ?? new Date()).toISOString();

    if (waiting.length > 0) {
        saveRmRequest({ ...request, targets: waiting }, options.requestsDir);
    } else {
        saveRmRequest({ ...request, status: "denied", decidedAt, decidedVia: "cli" }, options.requestsDir);
    }

    return { ...back, waiting };
}

function isLink(path: string): boolean {
    try {
        return lstatSync(path).isSymbolicLink();
    } catch {
        return false;
    }
}

export interface PendingAside {
    dir: string;
    requestId: string;
}

/** Aside folders whose request still waits for the user. */
export function pendingAsideDirs(requestsDir?: string): PendingAside[] {
    return listRmRequests({ dir: requestsDir })
        .filter((request) => request.asideDir)
        .map((request) => ({ dir: realOrSelf(request.asideDir ?? ""), requestId: request.id }));
}

/** The pending request whose aside folder `path` is, holds, or sits in; null when none. */
export function pendingAsideFor(path: string, pending: readonly PendingAside[]): string | null {
    const hit = pending.find((entry) => isSameOrInside(path, entry.dir) || isSameOrInside(entry.dir, path));
    return hit?.requestId ?? null;
}
