import { existsSync, lstatSync, mkdirSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";
import { logger } from "@genesiscz/utils/logger";
import { appendRmLedger } from "./ledger";
import { isSameOrInside, realOrSelf, sharedTempRoot } from "./paths";
import { listRmRequests, type RmRequestTarget } from "./requests";
import type { RmCaller, RmTarget, RmVerdict } from "./rules";
import { measureBytes, trashItemName } from "./trash";

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

    for (const [index, input] of inputs.entries()) {
        const stored = join(dir, trashItemName(index, input.target.path));

        try {
            mkdirSync(dirname(stored), { recursive: true });
            renameSync(input.target.path, stored);
        } catch (error) {
            const code = (error as NodeJS.ErrnoException).code;
            const reason = code === "EXDEV" ? "on another volume than the aside folder" : `the move failed (${code})`;
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

/** Moves aside items back to where they were (a denied request). */
export function returnAside(
    targets: readonly RmRequestTarget[],
    caller: RmCaller | null,
    requestId: string
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

        if (existsSync(target.path) || isLink(target.path)) {
            result.kept.push({ path: target.path, reason: `something exists there now; it waits at ${target.stored}` });
            continue;
        }

        mkdirSync(dirname(target.path), { recursive: true });
        renameSync(target.stored, target.path);
        result.returned.push(target.path);
        appendRmLedger({ action: "return", path: target.path, stored: target.stored, requestId, caller });
    }

    return result;
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
