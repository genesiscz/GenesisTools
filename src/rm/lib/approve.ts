import { existsSync, readdirSync, rmdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { abortableSleep } from "@genesiscz/utils/async";
import { toolCommand } from "@genesiscz/utils/cli";
import { logger, out } from "@genesiscz/utils/logger";
import {
    type ApprovalChoices,
    type ApprovalItem,
    type ApprovalItemUpdate,
    type ApprovalRequestInfo,
    ApprovalUpdates,
    appendRmLedger,
    approvalAsker,
    approvalItemReason,
    disposalGraceMinutes,
    folderStats,
    freshMeasurement,
    hardDenyReason,
    isRmMeasurementRunning,
    isRootActive,
    kickDrainer,
    listRmRequests,
    loadRmMeasurements,
    type MoveOptions,
    measureTarget,
    moveToTrash,
    pathPresent,
    probeItemGit,
    type ReturnResult,
    RM_APPROVED_TRASH_MINUTES,
    RM_SESSION_ROOT_HOURS,
    type RmCaller,
    type RmMeasuredItem,
    type RmRememberChoice,
    type RmRequest,
    type RmRequestMeasurements,
    type RmRequestTarget,
    type RmRoot,
    type RmRuleContext,
    type RmTarget,
    recheckAfterWait,
    recordRmMeasurement,
    requestBatchIds,
    requestsAlsoNaming,
    resolveTarget,
    returnAside,
    saveRmConfig,
    saveRmRequest,
    stillAside,
    type TrashBatch,
    targetLiveState,
    updateRmRequest,
} from "@genesiscz/utils/rm";
import pc from "picocolors";
import { LOST_COPY_CAUSE } from "./display";
import type { PersonAnswer, RunContext } from "./run";

/** One target of a request with what is at its location now (the aside copy when it was moved). */
export interface ApproveEntry {
    wanted: RmRequestTarget;
    target: RmTarget;
}

/** The rule of every item an approval moves to the trash is this prefix and the request id. */
const APPROVED_RULE_PREFIX = "approved ";

/** A trash batch a person's approval made: its grace is what the person picked, so only a person ends it early. */
export function isApprovedBatch(batch: Pick<TrashBatch, "items">): boolean {
    return batch.items.some((item) => item.rule.startsWith(APPROVED_RULE_PREFIX));
}

/** The row of a path that is back in place beside its aside copy: approving it deletes the copy, never the path. */
export const CAME_BACK_REASON = "Delete the set-aside copy (the path is back in place)";

/** The original path exists again and its aside copy too (k38jcw, m8sn2z): a deny cannot put the copy back. */
export function cameBack(target: RmRequestTarget): boolean {
    return targetLiveState(target) === "came-back";
}

/** A path whose aside copy is gone: nothing is left to approve, put back or guard for it. */
export function copyLost(target: RmRequestTarget): boolean {
    return targetLiveState(target) === "copy-lost";
}

/** Prints and logs the paths of `request` whose aside copies an approval found gone; it decides them no further. */
export function reportLostCopies(request: RmRequest, lost: readonly RmRequestTarget[], caller: RmCaller | null): void {
    for (const target of lost) {
        out.println(pc.yellow(`gone ${target.path}: its set-aside copy was ${LOST_COPY_CAUSE} (${target.stored})`));
        appendRmLedger({
            action: "lost",
            requestId: request.id,
            caller,
            path: target.path,
            stored: target.stored,
            reason: "the aside copy was already gone at the approval",
        });
    }
}

/**
 * Closes `request` as `gone` when every path it still names is a lost aside copy, as prune would if it closed those:
 * an approval has nothing left to move. The caller holds the request's lock.
 */
export function closeAllLost(request: RmRequest, caller: RmCaller | null): void {
    saveRmRequest({ ...request, status: "gone", decidedAt: new Date().toISOString(), decidedVia: "approve" });
    appendRmLedger({ action: "close", requestId: request.id, reason: "gone", caller });
    removeEmptyAsideDir(request.asideDir);
    out.println(`Request ${request.id} closed as gone: nothing is left to approve.`);
}

/** An aside batch folder that the decision emptied; a non-empty one (something kept) stays. */
export function removeEmptyAsideDir(dir: string | undefined): void {
    if (!dir || !existsSync(dir) || readdirSync(dir).length > 0) {
        return;
    }

    rmdirSync(dir);
}

/** True for a folder with nothing in it; an unreadable folder is not called empty. */
function isEmptyDir(dir: string): boolean {
    try {
        return readdirSync(dir).length === 0;
    } catch (error) {
        logger.debug({ error, dir }, "rm: could not list a folder for the approval window");
        return false;
    }
}

/** A path to measure: where the request names it, and its aside copy while it waits. */
type MeasuredPath = Pick<RmRequestTarget, "path" | "stored"> & Partial<Pick<RmRequestTarget, "rule">>;

/** How the rows get their sizes and git facts; tests replace them. */
export interface ApprovalRowDeps {
    measure: (target: MeasuredPath, signal: AbortSignal) => Promise<RmMeasuredItem | null>;
    probeGit: typeof probeItemGit;
    loadMeasurements: (id: string) => RmRequestMeasurements | null;
    /** Saves one measured path with the request, so the next `approve` reads it. */
    record: (request: RmRequest, target: MeasuredPath, item: RmMeasuredItem) => void;
    /** A measurement pass of the request runs in another process. */
    passRunning: (id: string) => boolean;
    /** The top path's mtime, which tells a saved measurement from a stale one. */
    mtimeOf?: (path: string) => number | null;
    /** How long to wait between two reads of a running pass's results. */
    followMs: number;
    /** How long to follow a running pass before measuring the rest here. */
    followLimitMs: number;
}

const DEFAULT_ROW_DEPS: ApprovalRowDeps = {
    measure: (target, signal) => measureTarget(target, { signal }),
    probeGit: probeItemGit,
    loadMeasurements: (id) => loadRmMeasurements(id),
    record: (request, target, item) => recordRmMeasurement({ request, target, item }),
    passRunning: (id) => isRmMeasurementRunning(id),
    followMs: 500,
    followLimitMs: 180_000,
};

/** The window's rows now, and the sizes and git facts that follow them once the window is open. */
export interface ApprovalRows {
    items: ApprovalItem[];
    updates: ApprovalUpdates;
    /** Resolves once every update is in, or the signal stopped the rest. */
    done: Promise<void>;
}

function sizeUpdate(path: string, item: RmMeasuredItem | null): ApprovalItemUpdate {
    if (!item) {
        return { path, measuring: false };
    }

    return { path, bytes: item.bytes, empty: item.empty, folderStats: item.folderStats, measuring: false };
}

function nextTurn(): Promise<void> {
    return new Promise((resolve) => setImmediate(resolve));
}

/** Pushes the size of each entry the saved measurements hold fresh; returns the entries still to measure. */
function takeSaved<T extends { wanted: MeasuredPath }>(
    entries: readonly T[],
    saved: RmRequestMeasurements | null,
    updates: ApprovalUpdates,
    deps: ApprovalRowDeps
): T[] {
    return entries.filter(({ wanted }) => {
        const fresh = freshMeasurement(saved, wanted, deps.mtimeOf);

        if (fresh) {
            updates.push(sizeUpdate(wanted.path, fresh));
        }

        return fresh === null;
    });
}

/**
 * Sizes for the rows marked measuring. A pass started with the request may still walk: its saved results are read
 * instead of walking the same trees twice. What it leaves (it ended, or it walks too long) is measured here and saved
 * with the request. Without a request (a person's own run) every row is measured here.
 */
async function measureRows(input: {
    request: RmRequest | null;
    entries: readonly { wanted: MeasuredPath }[];
    updates: ApprovalUpdates;
    deps: ApprovalRowDeps;
    signal: AbortSignal;
}): Promise<void> {
    const { request, updates, deps, signal } = input;
    const followUntil = Date.now() + deps.followLimitMs;
    let left = [...input.entries];

    while (request && left.length > 0 && !signal.aborted && Date.now() < followUntil && deps.passRunning(request.id)) {
        left = takeSaved(left, deps.loadMeasurements(request.id), updates, deps);

        if (left.length > 0) {
            await abortableSleep(deps.followMs, signal).catch(() => undefined);
        }
    }

    if (request) {
        left = takeSaved(left, deps.loadMeasurements(request.id), updates, deps);
    }

    for (const { wanted } of left) {
        if (signal.aborted) {
            return;
        }

        let item: RmMeasuredItem | null = null;

        try {
            item = await deps.measure(wanted, signal);
        } catch (error) {
            if (signal.aborted) {
                return;
            }

            logger.debug({ error, path: wanted.path }, "rm: could not measure a path for the approval window");
        }

        // The window still gets the size when it cannot be saved (a full disk): the next approve measures again.
        if (item && request) {
            try {
                deps.record(request, wanted, item);
            } catch (error) {
                logger.warn({ error, path: wanted.path, request: request.id }, "rm: could not save a measured size");
            }
        }

        updates.push(sizeUpdate(wanted.path, item));
    }
}

/** A folder's emptiness and file count for rows whose size is known but whose stats were not saved with it. */
async function folderFacts(
    entries: readonly ApproveEntry[],
    updates: ApprovalUpdates,
    signal: AbortSignal
): Promise<void> {
    for (const { wanted, target } of entries) {
        if (signal.aborted) {
            return;
        }

        updates.push({ path: wanted.path, empty: isEmptyDir(target.path), folderStats: folderStats(target.path) });
        await nextTurn();
    }
}

async function fillRows(input: {
    request: RmRequest;
    entries: readonly ApproveEntry[];
    measuring: readonly ApproveEntry[];
    statsLater: readonly ApproveEntry[];
    updates: ApprovalUpdates;
    deps: ApprovalRowDeps;
    signal: AbortSignal;
}): Promise<void> {
    const { entries, updates, deps } = input;
    // The window opens in this turn; the probes and the walks start in the next one.
    await nextTurn();
    const git = deps
        .probeGit(entries.map(({ wanted }) => ({ path: wanted.path, aside: wanted.stored !== undefined })))
        .then((found) => {
            for (const [path, facts] of found) {
                updates.push({ path, git: facts });
            }
        })
        .catch((error: unknown) => logger.debug({ error }, "rm: git facts for the approval window failed"));
    await Promise.all([
        git,
        folderFacts(input.statsLater, updates, input.signal),
        measureRows({ ...input, entries: input.measuring }),
    ]);
}

/**
 * The sizes of a person's own run (`tools rm <paths>` on a terminal, no request), measured after the window opened.
 * `paths` are the rows marked `measuring`.
 */
export function liveSizes(
    paths: readonly string[],
    options: { signal: AbortSignal; deps?: Partial<ApprovalRowDeps> }
): ApprovalUpdates {
    const deps = { ...DEFAULT_ROW_DEPS, ...options.deps };
    const updates = new ApprovalUpdates();
    const entries = paths.map((path) => ({ wanted: { path } }));
    void nextTurn()
        .then(() => measureRows({ request: null, entries, updates, deps, signal: options.signal }))
        .catch((error: unknown) => logger.warn({ error }, "rm: measuring the sizes for the approval window failed"))
        .finally(() => updates.close());
    return updates;
}

/**
 * The window's rows: what is known at once (the reason, the kind, the other requests naming the same path, and a
 * size the request's measurement pass saved that is still fresh), and the rest as updates that follow: each size not
 * saved is measured (rows marked `measuring` until then) and the git facts are probed, so the window opens before
 * any tree is walked. `signal` stops the walks once the person answered.
 */
export function approvalRows(
    request: RmRequest,
    entries: readonly ApproveEntry[],
    options: { signal: AbortSignal; deps?: Partial<ApprovalRowDeps> }
): ApprovalRows {
    const deps = { ...DEFAULT_ROW_DEPS, ...options.deps };
    const alsoIn = requestsAlsoNaming(
        entries.map((entry) => entry.wanted.path),
        request.id,
        listRmRequests()
    );
    const saved = request.kind === "delete" ? deps.loadMeasurements(request.id) : null;
    const measuring: ApproveEntry[] = [];
    // A folder's stats walk up to 2000 entries: unless the saved measurement holds them, they follow the window too.
    const statsLater: ApproveEntry[] = [];
    const items = entries.map((entry): ApprovalItem => {
        const { wanted, target } = entry;
        const isDelete = request.kind === "delete" && target.kind !== "missing";
        const isDir = target.kind === "dir";
        const fresh = isDelete ? freshMeasurement(saved, wanted, deps.mtimeOf) : null;
        // An aside copy from before the measurement pass carries the size its move measured.
        const known = fresh !== null || wanted.bytes !== undefined;
        const base = {
            path: wanted.path,
            kind: target.kind,
            storedAt: wanted.stored,
            reason: cameBack(wanted) ? CAME_BACK_REASON : approvalItemReason(wanted.rule, wanted.reason),
            alsoIn: alsoIn.get(wanted.path),
        };

        if (isDelete && !known) {
            measuring.push(entry);
            return { ...base, measuring: true };
        }

        if (isDir && !fresh?.folderStats) {
            statsLater.push(entry);
        }

        return {
            ...base,
            bytes: isDelete ? (fresh?.bytes ?? wanted.bytes) : undefined,
            empty: isDir ? fresh?.empty : undefined,
            folderStats: isDir ? fresh?.folderStats : undefined,
        };
    });
    const updates = new ApprovalUpdates();
    const done = fillRows({
        request,
        entries,
        measuring,
        statsLater,
        updates,
        deps,
        signal: options.signal,
    })
        // Nothing awaits this while the person decides: a failure is logged, never an unhandled rejection.
        .catch((error: unknown) => logger.warn({ error }, "rm: filling the approval window's rows failed"))
        .finally(() => updates.close());
    return { items, updates, done };
}

/** The saved sizes of the request's paths that are still fresh, by request path. */
export function savedSizes(request: RmRequest, entries: readonly ApproveEntry[]): Map<string, number> {
    const saved = loadRmMeasurements(request.id);
    const sizes = new Map<string, number>();

    for (const { wanted } of entries) {
        const fresh = freshMeasurement(saved, wanted);

        if (fresh) {
            sizes.set(wanted.path, fresh.bytes);
        }
    }

    return sizes;
}

/** The request as the window shows it. */
export function approvalRequestInfo(request: RmRequest, items: ApprovalItem[]): ApprovalRequestInfo {
    return {
        id: request.id,
        kind: request.kind,
        why: request.reason,
        cwd: request.cwd,
        graceMinutes: request.kind === "delete" ? RM_APPROVED_TRASH_MINUTES : undefined,
        askedAt: request.createdAt,
        asker: approvalAsker(request.caller),
        items,
    };
}

/** The ticked entries and the rest; nothing unticked (`selected` null) approves them all. */
export function splitBySelection(
    entries: readonly ApproveEntry[],
    selected: readonly string[] | null
): { approved: ApproveEntry[]; denied: ApproveEntry[] } {
    if (!selected) {
        return { approved: [...entries], denied: [] };
    }

    const picked = new Set(selected);
    return {
        approved: entries.filter((entry) => picked.has(entry.wanted.path)),
        denied: entries.filter((entry) => !picked.has(entry.wanted.path)),
    };
}

/** Puts the aside items of `targets` back, prints what moved and what stayed, and logs it. */
export function putBack(targets: readonly RmRequestTarget[], caller: RmCaller | null, requestId: string): ReturnResult {
    const back = returnAside(targets, caller, requestId);

    for (const path of back.returned) {
        out.println(pc.green(`put back ${path}`));
    }

    for (const kept of back.kept) {
        out.println(pc.yellow(`not put back ${kept.path}: ${kept.reason}`));
    }

    return back;
}

/** What a deny did: the put-back, the copies that still wait (the path is taken), and the copies already gone. */
export interface DenyOutcome {
    back: ReturnResult;
    /** Aside copies that could not go home because something is there now: the request stays pending for them. */
    waiting: RmRequestTarget[];
    /** Aside copies something outside `tools rm` deleted: nothing is left to put back or to guard. */
    lost: RmRequestTarget[];
}

/**
 * Closes a request without doing it: aside items go back, the status is `denied`, and a person's note is kept on
 * the request and in the ledger, so the agent reads why when it asks again.
 */
export function denyRequest(
    request: RmRequest,
    options: { caller: RmCaller | null; via: string; note?: string | null }
): DenyOutcome {
    // Read before the put-back, which empties the stored location of every copy it returns.
    const lost = request.targets.filter((target) => target.stored !== undefined && !pathPresent(target.stored));
    const back = putBack(
        request.targets.filter((target) => !lost.includes(target)),
        options.caller,
        request.id
    );
    const waiting = stillAside(request.targets, back);

    if (back.kept.length === 0) {
        removeEmptyAsideDir(request.asideDir);
    }

    for (const target of lost) {
        appendRmLedger({
            action: "lost",
            requestId: request.id,
            caller: options.caller,
            path: target.path,
            stored: target.stored,
            reason: "the aside copy was already gone at the deny",
        });
    }

    const retry = options.via === "cli" && request.decidedVia !== undefined && request.decidedVia !== "cli";
    const note = retry ? request.deniedNote : (options.note ?? undefined);
    const decision = {
        ...request.decided,
        approved: request.decided?.approved ?? [],
        denied: [...new Set([...(request.decided?.denied ?? []), ...request.targets.map((target) => target.path)])],
    };
    saveRmRequest({
        ...request,
        decided: decision,
        status: waiting.length > 0 ? "pending" : request.decided?.approved.length ? "approved" : "denied",
        targets: waiting.length > 0 ? waiting : request.targets,
        decidedAt: retry ? request.decidedAt : new Date().toISOString(),
        decidedVia: retry ? request.decidedVia : options.via,
        deniedNote: note,
    });
    appendRmLedger({
        action: "deny",
        requestId: request.id,
        caller: options.caller,
        path: resolve(request.cwd),
        via: options.via,
        note,
        // `cli` is the asking agent's own cancel; every other way is a person's answer.
        person: options.via === "cli" ? undefined : { via: options.via },
    });
    return { back, waiting, lost };
}

/** Prints what a deny did: the copies that were already gone, then the closed line, or that some copies still wait. */
export function printDenyOutcome(id: string, outcome: DenyOutcome, closedLine: string): void {
    if (outcome.lost.length > 0) {
        const paths = outcome.lost.map((target) => target.path).join(", ");
        out.println(
            pc.yellow(`${outcome.lost.length} set-aside copy(ies) were already gone (${LOST_COPY_CAUSE}): ${paths}`)
        );
    }

    if (outcome.waiting.length > 0) {
        out.println(`Request ${id} still needs recovery.`);

        if (outcome.waiting.some(cameBack)) {
            out.println(
                pc.dim(
                    `  the path is back; ${toolCommand("rm")} approve ${id} deletes the set-aside copy, or move the copy yourself`
                )
            );
        }

        process.exitCode = 1;
        return;
    }

    out.println(closedLine);
}

/**
 * Records the decision on the request: approved (with the ticked and the put-back paths) and its batch. A path that
 * was refused, changed while the person decided, or could not be moved keeps the request pending, with only those.
 */
export function saveApproved(input: {
    request: RmRequest;
    answer: PersonAnswer;
    approved: readonly ApproveEntry[];
    denied: readonly ApproveEntry[];
    pending: readonly RmRequestTarget[];
    batchId?: string;
    ctx: RunContext;
}): void {
    const { request, answer, approved, denied, pending, batchId, ctx } = input;
    saveRmRequest({
        ...request,
        status: pending.length > 0 ? "pending" : "approved",
        targets: pending.length > 0 ? request.targets.filter((target) => pending.includes(target)) : request.targets,
        decidedAt: new Date().toISOString(),
        decidedVia: answer.via,
        decided: {
            approved: [
                ...new Set([...(request.decided?.approved ?? []), ...approved.map((entry) => entry.wanted.path)]),
            ],
            denied: [...new Set([...(request.decided?.denied ?? []), ...denied.map((entry) => entry.wanted.path)])],
            disposal: request.kind === "delete" ? answer.choices.disposal : undefined,
            remember: request.kind === "delete" ? answer.choices.remember : undefined,
        },
        // A second approval of the same request makes a second batch: both stay restorable, the newest is batchId.
        batchId: batchId ?? request.batchId,
        batchIds: batchId ? [...requestBatchIds(request), batchId] : request.batchIds,
    });
    appendRmLedger({
        action: "approve",
        requestId: request.id,
        via: answer.via,
        caller: ctx.caller,
        batchId,
        person: { via: answer.via },
    });
}

function exitPendingFor(id: string, pending: readonly RmRequestTarget[]): void {
    if (pending.length === 0) {
        return;
    }

    out.println(
        pc.yellow(`Request ${id} stays pending for ${pending.length} blocked, changed or not put back path(s).`)
    );
    process.exitCode = 1;
}

/** The rules a request's paths are checked against once more: a root's are the hard-deny ones only. */
export type ApprovalDenyCheck = (target: RmTarget, rules: RmRuleContext) => string | null;

/**
 * Does what the person answered for one request: a Deny puts everything back; otherwise the ticked rows of
 * `selected` (null: every row) are checked again (the prompt can wait for minutes) and moved, the unticked ones put
 * back, and `blocked` (refused before the prompt, or not shown in it) keeps the request pending.
 */
export function applyApprovalAnswer(input: {
    ctx: RunContext;
    request: RmRequest;
    openEntries: readonly ApproveEntry[];
    blocked: readonly ApproveEntry[];
    answer: PersonAnswer;
    selected: readonly string[] | null;
    denyOf: ApprovalDenyCheck;
    /** Starts the background drain after the move; tests replace it. */
    kickDrainer?: (config: RunContext["config"]) => void;
}): void {
    const { ctx, request, openEntries, blocked, answer, selected, denyOf } = input;
    const id = request.id;

    if (!answer.approved) {
        if (answer.deniedByPerson) {
            const outcome = denyRequest(request, { caller: ctx.caller, via: answer.via, note: answer.choices.note });
            printDenyOutcome(id, outcome, `Request ${id} denied.`);
        }

        return;
    }

    const { approved, denied } = splitBySelection(openEntries, selected);

    if (approved.length === 0) {
        const outcome = denyRequest(request, { caller: ctx.caller, via: answer.via, note: answer.choices.note });
        printDenyOutcome(id, outcome, `Nothing was ticked: request ${id} denied.`);
        return;
    }

    // The prompt can wait for minutes: each ticked path must still name what the person was shown, and still pass
    // the rules no approval overrides. A changed one stays in the request, which stays pending for it, as do the
    // paths refused before the prompt.
    const pending: RmRequestTarget[] = blocked.map((entry) => entry.wanted);
    const ready = approved.filter(({ wanted, target }) => {
        const reason = recheckAfterWait(target, ctx.rules, denyOf);

        if (reason) {
            out.println(pc.red(`refuse ${wanted.path}: ${reason}`));
            pending.push(wanted);
        }

        return reason === null;
    });

    if (ready.length === 0) {
        process.exitCode = 1;
        return;
    }

    if (request.kind === "root") {
        approveRoots(ctx, request, ready, answer.via);
        saveApproved({ request, answer, approved: ready, denied, pending, ctx });
        exitPendingFor(id, pending);
        return;
    }

    const { batch, back } = approveDelete({
        ctx,
        request,
        approved: ready,
        denied,
        choices: answer.choices,
        onRefused: (entry) => pending.push(entry.wanted),
        sizes: savedSizes(request, ready),
    });
    const moved = ready.filter((entry) => !pending.includes(entry.wanted));
    // An unticked aside copy that could not go home stays pending, so its aside folder stays guarded.
    pending.push(
        ...stillAside(
            denied.map((entry) => entry.wanted),
            back
        )
    );
    saveApproved({ request, answer, approved: moved, denied, pending, batchId: batch?.id, ctx });
    (input.kickDrainer ?? kickDrainer)(ctx.config);
    exitPendingFor(id, pending);
}

/** Trusts each approved folder of a root request. */
export function approveRoots(
    ctx: RunContext,
    request: RmRequest,
    approved: readonly ApproveEntry[],
    via: string
): void {
    const roots: RmRoot[] = approved.map(({ target }) => ({
        path: target.canonical,
        note: request.reason ?? undefined,
        addedAt: new Date().toISOString(),
        via: `request:${request.id}`,
    }));
    saveRmConfig({ ...ctx.base, roots: [...ctx.base.roots, ...roots] });

    for (const root of roots) {
        appendRmLedger({ action: "root-add", path: root.path, requestId: request.id, via, caller: ctx.caller });
    }

    out.println(pc.green(`Trusted ${roots.map((r) => r.path).join(", ")}.`));
}

/** Another pending request that names some of the approved paths: the ones it shares and the ones it keeps. */
interface SharedRequest {
    request: RmRequest;
    shared: RmRequestTarget[];
    rest: RmRequestTarget[];
}

function sharedRequests(request: RmRequest, approved: readonly ApproveEntry[]): SharedRequest[] {
    // Only in-place requests can describe the same object. An aside copy, including one
    // in another request, is a distinct object and requires its own approval.
    const inPlace = new Set(approved.filter(({ wanted }) => !wanted.stored).map(({ wanted }) => wanted.path));
    return listRmRequests()
        .filter((other) => other.id !== request.id)
        .map((other) => ({
            request: other,
            shared: other.targets.filter((target) => !target.stored && inPlace.has(target.path)),
            rest: other.targets.filter((target) => target.stored || !inPlace.has(target.path)),
        }))
        .filter((other) => other.shared.length > 0);
}

/** Marks the other requests decided with this one: fully shared ones approved, the rest keep their own paths. */
function settleShared(shared: readonly SharedRequest[], decidedBy: RmRequest, batchId: string | undefined): void {
    const decidedAt = new Date().toISOString();

    for (const candidate of shared) {
        const paths = new Set(candidate.shared.map((target) => target.path));
        // Read again under the other request's lock: the copy listRmRequests() gave may be minutes old.
        const update = updateRmRequest(candidate.request.id, (fresh) => {
            if (fresh.status !== "pending") {
                return null;
            }

            const rest = fresh.targets.filter((target) => target.stored || !paths.has(target.path));

            if (rest.length === fresh.targets.length) {
                return null;
            }

            return rest.length > 0
                ? { ...fresh, targets: rest }
                : {
                      ...fresh,
                      status: "approved",
                      decidedAt,
                      decidedVia: `request:${decidedBy.id}`,
                      decided: { approved: [...paths], denied: [] },
                      batchId: batchId ?? fresh.batchId,
                      batchIds: batchId ? [...requestBatchIds(fresh), batchId] : fresh.batchIds,
                  };
        });

        if (update.kind === "busy") {
            out.println(
                pc.dim(`  request ${candidate.request.id} is open in another window; it keeps its shared path(s)`)
            );
            continue;
        }

        if (update.kind !== "saved") {
            continue;
        }

        appendRmLedger({
            action: "approve",
            requestId: candidate.request.id,
            via: `request:${decidedBy.id}`,
            path: [...paths].join(", "),
            batchId,
        });

        if (update.request.status === "approved") {
            removeEmptyAsideDir(update.request.asideDir);
            out.println(pc.dim(`  request ${candidate.request.id} is approved with it`));
        } else {
            out.println(
                pc.dim(`  request ${candidate.request.id}: ${paths.size} shared path(s) decided, the rest still waits`)
            );
        }
    }
}

/** The parent folders of the approved paths as roots: for the asking session for 8 h, or for everyone. */
function rememberedRoots(
    ctx: RunContext,
    request: RmRequest,
    approved: readonly ApproveEntry[],
    remember: RmRememberChoice
): RmRoot[] {
    const session = request.caller?.sessionId ?? null;

    if (remember === "once" || (remember === "session" && !session)) {
        return [];
    }

    const now = Date.now();
    const folders = [...new Set(approved.map((entry) => dirname(entry.wanted.path)))];
    const roots: RmRoot[] = [];

    for (const folder of folders) {
        const target = resolveTarget(folder, request.cwd);
        const denied = target.kind === "dir" ? hardDenyReason(target, ctx.rules) : "not a folder";

        if (denied) {
            out.println(pc.yellow(`not remembered ${folder}: ${denied}`));
            continue;
        }

        roots.push({
            path: target.canonical,
            note: request.reason ?? undefined,
            addedAt: new Date(now).toISOString(),
            via: `request:${request.id}`,
            ...(remember === "session" && session
                ? { session, expiresAt: new Date(now + RM_SESSION_ROOT_HOURS * 3_600_000).toISOString() }
                : {}),
        });
    }

    return roots;
}

/** Saves the remembered roots, replacing a root of the same folder and scope, and dropping expired ones (any session). */
function saveRemembered(ctx: RunContext, roots: readonly RmRoot[], requestId: string): void {
    if (roots.length === 0) {
        return;
    }

    const now = Date.now();
    const kept = ctx.base.roots.filter(
        (root) =>
            isRootActive(root, root.session ?? null, now) &&
            !roots.some((added) => added.path === root.path && added.session === root.session)
    );
    saveRmConfig({ ...ctx.base, roots: [...kept, ...roots] });

    for (const root of roots) {
        appendRmLedger({
            action: "root-add",
            path: root.path,
            requestId,
            via: root.session ? "remember:session" : "remember:folder",
            caller: ctx.caller,
        });
        const scope = root.session ? `for this session until ${root.expiresAt}` : "always";
        out.println(pc.green(`Trusted ${root.path} (${scope}).`));
    }
}

export interface DeleteApproval {
    batch: TrashBatch | null;
    back: ReturnResult;
}

/**
 * Carries out an approved delete: the ticked paths move to the trash
 * with the picked disposal's grace, the unticked ones go back from aside, and a remember choice adds roots. The caller
 * starts the drainer (`kickDrainer`), which deletes a permanent batch at once.
 */
export function approveDelete(input: {
    ctx: RunContext;
    request: RmRequest;
    approved: readonly ApproveEntry[];
    denied: readonly ApproveEntry[];
    choices: ApprovalChoices;
    /** An approved path the trash refused (unavailable, or changed since the check): it stays where it is. */
    onRefused?: (entry: ApproveEntry, reason: string) => void;
    /** Test seams of the trash move (an unwritable trash root, a swap before the rename). */
    hooks?: MoveOptions["hooks"];
    /** Sizes measured for the window, by request path: the drain then does not walk those trees again. */
    sizes?: ReadonlyMap<string, number>;
}): DeleteApproval {
    const { ctx, request, approved, denied, choices } = input;
    const byTarget = new Map(approved.map((entry) => [entry.target, entry]));
    const refused = new Set<ApproveEntry>();
    const graceMinutes = disposalGraceMinutes(choices.disposal);
    const batch = moveToTrash(
        [
            ...approved.map(({ wanted, target }) => ({
                target,
                rule: `${APPROVED_RULE_PREFIX}${request.id}`,
                original: wanted.path,
                bytes: wanted.bytes ?? input.sizes?.get(wanted.path),
            })),
        ],
        {
            config: ctx.config,
            caller: request.caller,
            graceMinutes,
            hooks: input.hooks,
            onRefused: (move, reason) => {
                out.println(pc.red(`refuse ${move.original ?? move.target.path}: ${reason}`));
                const entry = byTarget.get(move.target);

                if (entry) {
                    refused.add(entry);
                    input.onRefused?.(entry, reason);
                }
            },
        }
    );
    const back = putBack(
        denied.map((entry) => entry.wanted),
        ctx.caller,
        request.id
    );

    if (back.kept.length === 0) {
        removeEmptyAsideDir(request.asideDir);
    }

    // A refused path stayed where it is: it settles no other request and adds no remembered root.
    const completed = approved.filter((entry) => !refused.has(entry));
    printDisposal(request.id, batch, graceMinutes);
    settleShared(sharedRequests(request, completed), request, batch?.id);
    saveRemembered(ctx, rememberedRoots(ctx, request, completed, choices.remember), request.id);
    return { batch, back };
}

function printDisposal(requestId: string, batch: TrashBatch | null, graceMinutes: number): void {
    const count = batch?.items.length ?? 0;

    if (graceMinutes === 0) {
        out.println(pc.green(`Deleting ${count} item(s) for good.`));
        return;
    }

    out.println(pc.green(`Moved ${count} item(s) to the trash; the drain deletes them in ${graceMinutes} min.`));

    if (batch) {
        out.println(pc.dim(`  undo: ${toolCommand("rm")} restore ${requestId}`));
    }
}
