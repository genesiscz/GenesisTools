import { logger } from "@genesiscz/utils/logger";
import { appendRmLedger } from "./ledger";
import { canonicalPath } from "./paths";
import { pathPresent, targetLiveState } from "./request-state";
import { lockRmRequest, pruneRmRequests } from "./request-store";
import {
    listRmRequests,
    type RmRequest,
    type RmRequestTarget,
    readRmRequestFile,
    requestBatchIds,
    rmRequestFile,
    rmRequestsDir,
    saveRmRequest,
} from "./requests";
import {
    evaluateTarget,
    graceMinutesFor,
    type RmCaller,
    type RmRuleContext,
    type RmTarget,
    type RmVerdict,
    resolveTarget,
} from "./rules";
import { moveToTrash, type TrashPaths } from "./trash";

/** A path of a request that a rule decided after it was asked, without a person: what ran and why. */
export interface RmRuledTarget {
    path: string;
    rule: string;
    reason: string;
    at: string;
    /** The trash batch it went to. */
    batchId?: string;
}

/** A target of a pending request a rule covers now, and what moves to the trash for it (the path, or its copy). */
export interface RmCoveredTarget {
    target: RmRequestTarget;
    verdict: RmVerdict;
    content: RmTarget;
}

/** The words a person reads for a request a rule closed: the owner's own form (2026-11-01). */
export function ruledLine(rule: string, reason: string): string {
    return `refused: rule ${rule}, ${reason}; deleted without a request`;
}

/**
 * The targets of a pending delete request that the rule table allows now, judged as the session that asked (read
 * only). A path still in place is evaluated as it is. A copy set aside counts as its original path with the copy's
 * content (size, repositories, birthtime), and only when the default rule asked for it: a git rule that asked then
 * judged a work tree the copy has left. A path that came back, a lost copy and a gone path stay for a person. A path
 * the person denied is never a rule's again: its copy waits for the put-back (`tools rm deny <id>` retries it), and a
 * rule that allows the path now must not delete what the person said to keep.
 */
export function ruleCoverage(
    request: RmRequest,
    ctx: RmRuleContext,
    present: (path: string) => boolean = pathPresent
): RmCoveredTarget[] {
    if (request.status !== "pending" || request.kind !== "delete") {
        return [];
    }

    const covered: RmCoveredTarget[] = [];
    const denied = new Set(request.decided?.denied ?? []);

    for (const target of request.targets) {
        if (denied.has(target.path)) {
            continue;
        }

        const state = targetLiveState(target, present);
        let judged: RmTarget;
        let content: RmTarget;

        if (state === "in-place") {
            content = resolveTarget(target.path, request.cwd);
            judged = content;
        } else if (state === "aside" && target.stored && target.rule === "default") {
            content = resolveTarget(target.stored, request.cwd);
            judged = {
                input: target.path,
                path: target.path,
                canonical: canonicalPath(target.path),
                kind: content.kind,
                identity: content.identity,
                content: content.path,
            };
        } else {
            continue;
        }

        const verdict = evaluateTarget(judged, ctx);

        if (verdict.kind === "allow") {
            covered.push({ target, verdict, content });
        }
    }

    return covered;
}

export interface RmRuledClose {
    id: string;
    /** Every path is decided: the request is `ruled`. */
    closed: boolean;
    ruled: RmRuledTarget[];
}

export interface RmSweepOptions {
    /** The rule context of the session that asked (its profiles, its scratch, its own files). */
    contextFor: (request: RmRequest) => RmRuleContext | null;
    /** Who runs the sweep, for the ledger's close lines. */
    caller: RmCaller | null;
    /** Only these requests (an approve sweeps the ones it was asked for). */
    ids?: readonly string[];
    dir?: string;
    now?: Date;
    paths?: TrashPaths;
    present?: (path: string) => boolean;
}

export interface RmSweepResult {
    ruled: RmRuledClose[];
    /** Requests every path of which is gone, closed as `gone`. */
    gone: string[];
    /** Requests open in an approval window right now: left as they are. */
    busy: string[];
}

/** Moves what a rule covers to the trash and records it on the request, under the request's decision lock. */
function closeRuled(id: string, options: RmSweepOptions & { dir: string; now: Date }): RmRuledClose | "busy" | null {
    const lock = lockRmRequest(id, options.dir);

    if (!lock.ok) {
        return "busy";
    }

    try {
        const fresh = readRmRequestFile(rmRequestFile(id, options.dir));
        const ctx = fresh ? options.contextFor(fresh) : null;

        if (!fresh || !ctx) {
            return null;
        }

        const covered = ruleCoverage(fresh, ctx, options.present);

        if (covered.length === 0) {
            return null;
        }

        const byGrace = new Map<number, RmCoveredTarget[]>();

        for (const entry of covered) {
            const minutes = graceMinutesFor({ target: entry.content, verdict: entry.verdict }, ctx);
            byGrace.set(minutes, [...(byGrace.get(minutes) ?? []), entry]);
        }

        const at = options.now.toISOString();
        const ruled: RmRuledTarget[] = [];
        const batchIds: string[] = [];

        for (const [graceMinutes, entries] of byGrace) {
            const refused = new Set<RmTarget>();
            const batch = moveToTrash(
                entries.map((entry) => ({
                    target: entry.content,
                    rule: entry.verdict.rule,
                    original: entry.target.path,
                })),
                {
                    config: ctx.config,
                    caller: fresh.caller,
                    graceMinutes,
                    paths: options.paths,
                    onRefused: (move, reason) => {
                        refused.add(move.target);
                        logger.warn({ id, path: move.original, reason }, "rm: a ruled path did not move");
                    },
                }
            );

            if (batch) {
                batchIds.push(batch.id);
            }

            for (const entry of entries.filter((item) => !refused.has(item.content))) {
                ruled.push({
                    path: entry.target.path,
                    rule: entry.verdict.rule,
                    reason: entry.verdict.reason,
                    at,
                    batchId: batch?.id,
                });
            }
        }

        if (ruled.length === 0) {
            return null;
        }

        const done = new Set(ruled.map((entry) => entry.path));
        const rest = fresh.targets.filter((target) => !done.has(target.path));
        const rules = [...new Set(ruled.map((entry) => entry.rule))].join(", ");
        const closed = rest.length === 0;
        const record = {
            ruled: [...(fresh.ruled ?? []), ...ruled],
            batchIds: [...new Set([...requestBatchIds(fresh), ...batchIds])],
        };
        saveRmRequest(
            closed
                ? { ...fresh, ...record, status: "ruled", decidedAt: at, decidedVia: `rule ${rules}` }
                : { ...fresh, ...record, targets: rest },
            options.dir
        );
        appendRmLedger({
            action: "close",
            requestId: id,
            rule: rules,
            reason: closed ? `ruled: ${rules}` : `ruled in part: ${ruled.length} of ${fresh.targets.length} paths`,
            caller: options.caller,
        });
        logger.debug({ id, closed, ruled: ruled.length, rules }, "rm: a rule decided paths of a pending request");
        return { id, closed, ruled };
    } finally {
        lock.release();
    }
}

/**
 * The request sweep: every pending delete request whose paths a rule covers now is decided by that rule (the paths
 * go to the trash, with its grace and restore), and closed as `ruled` once nothing is left for a person; a request
 * whose every path is gone is closed as `gone`. A request held by an approval window is left alone. It runs in the
 * drainer (at start, then every `sweep.everyMinutes`), in `tools rm drain`, and in `approve` before a window opens.
 */
export function sweepRmRequests(options: RmSweepOptions): RmSweepResult {
    const dir = options.dir ?? rmRequestsDir();
    const now = options.now ?? new Date();
    const result: RmSweepResult = { ruled: [], gone: [], busy: [] };
    const wanted = options.ids ? new Set(options.ids) : null;

    for (const request of listRmRequests({ dir, now })) {
        if (request.kind !== "delete" || (wanted && !wanted.has(request.id))) {
            continue;
        }

        const done = closeRuled(request.id, { ...options, dir, now });

        if (done === "busy") {
            result.busy.push(request.id);
        } else if (done) {
            result.ruled.push(done);
        }
    }

    const pruned = pruneRmRequests({
        dir,
        now,
        caller: options.caller,
        present: options.present,
        reasons: ["gone"],
        ids: options.ids,
    });
    result.gone = pruned.closed.map((entry) => entry.id);
    result.busy.push(...pruned.busy.filter((id) => !result.busy.includes(id)));
    return result;
}
