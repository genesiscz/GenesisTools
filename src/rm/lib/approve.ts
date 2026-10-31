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
    listRmRequests,
    loadRmMeasurements,
    type MoveOptions,
    measureTarget,
    moveToTrash,
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
    type RmTarget,
    recordRmMeasurement,
    requestsAlsoNaming,
    resolveTarget,
    returnAside,
    saveRmConfig,
    saveRmRequest,
    stillAside,
    type TrashBatch,
} from "@genesiscz/utils/rm";
import pc from "picocolors";
import type { RunContext } from "./run";

/** One target of a request with what is at its location now (the aside copy when it was moved). */
export interface ApproveEntry {
    wanted: RmRequestTarget;
    target: RmTarget;
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
type MeasuredPath = Pick<RmRequestTarget, "path" | "stored">;

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

        if (item && request) {
            deps.record(request, wanted, item);
        }

        updates.push(sizeUpdate(wanted.path, item));
    }
}

async function fillRows(input: {
    request: RmRequest;
    entries: readonly ApproveEntry[];
    measuring: readonly ApproveEntry[];
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
    await Promise.all([git, measureRows({ ...input, entries: input.measuring })]);
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
            reason: approvalItemReason(wanted.rule, wanted.reason),
            alsoIn: alsoIn.get(wanted.path),
        };

        if (isDelete && !known) {
            measuring.push(entry);
            return { ...base, measuring: true };
        }

        return {
            ...base,
            bytes: isDelete ? (fresh?.bytes ?? wanted.bytes) : undefined,
            empty: isDir ? (fresh?.empty ?? isEmptyDir(target.path)) : undefined,
            folderStats: isDir ? (fresh?.folderStats ?? folderStats(target.path)) : undefined,
        };
    });
    const updates = new ApprovalUpdates();
    const done = fillRows({ request, entries, measuring, updates, deps, signal: options.signal }).finally(() =>
        updates.close()
    );
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

/**
 * Closes a request without doing it: aside items go back, the status is `denied`, and a person's note is kept on
 * the request and in the ledger, so the agent reads why when it asks again.
 */
export function denyRequest(
    request: RmRequest,
    options: { caller: RmCaller | null; via: string; note?: string | null }
): ReturnResult {
    const back = putBack(request.targets, options.caller, request.id);
    const waiting = stillAside(request.targets, back);

    if (back.kept.length === 0) {
        removeEmptyAsideDir(request.asideDir);
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
    });
    return back;
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

    for (const { request, shared: targets, rest } of shared) {
        const paths = targets.map((target) => target.path);
        appendRmLedger({
            action: "approve",
            requestId: request.id,
            via: `request:${decidedBy.id}`,
            path: paths.join(", "),
            batchId,
        });

        if (rest.length > 0) {
            saveRmRequest({ ...request, targets: rest });
            out.println(
                pc.dim(`  request ${request.id}: ${paths.length} shared path(s) decided, the rest still waits`)
            );
            continue;
        }

        saveRmRequest({
            ...request,
            status: "approved",
            decidedAt,
            decidedVia: `request:${decidedBy.id}`,
            decided: { approved: paths, denied: [] },
            batchId,
        });
        removeEmptyAsideDir(request.asideDir);
        out.println(pc.dim(`  request ${request.id} is approved with it`));
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
                rule: `approved ${request.id}`,
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
