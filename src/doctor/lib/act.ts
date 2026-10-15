import { closeSync, fsyncSync, lstatSync, mkdirSync, openSync, writeSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { freeDiskSpace } from "@genesiscz/utils/fs/disk-usage";
import { acquireLock, type LockHandle } from "@genesiscz/utils/fs/lock";
import { SafeJSON } from "@genesiscz/utils/json";
import type { Analyzer } from "./analyzer";
import { runOne } from "./executor";
import { appendHistory } from "./history";
import { guardPaths } from "./path-guard";
import { DOCTOR_DIR, makeRunId } from "./paths";
import {
    type CwdReader,
    listProcesses,
    PROCESS_LIST_UNAVAILABLE,
    type ProcessLister,
    readCwds,
    selfAndAncestors,
    snapshotProcesses,
} from "./processes";
import { isActable, metadataBlockers, metadataPaths, pathsHash } from "./remove-action";

export { pathsHash } from "./remove-action";

import { moveManyToTrash, type TrashResult } from "./trash";
import type { Action, ActionResult, AnalyzerContext, ConfirmMode, Finding, RemoveMethod, Severity } from "./types";

export const ACT_SCHEMA_VERSION = 1;
export const MANIFESTS_DIR = join(DOCTOR_DIR, "manifests");
export const ACT_LOCK_PATH = join(DOCTOR_DIR, "act.lock");
export const SETTLE_NOTE_DELETE = "df may keep rising for several minutes after a large delete";
export const SETTLE_NOTE_TRASH = "Trash stays on the same volume: nothing is freed until the Trash is emptied";
/** The shown size may drift this far from the fresh one (`--expect`) before the item is `stale`. */
export const STALE_DRIFT = 0.25;
/** In a long run (a big Trash batch), the findings are re-derived again when this much time passed since the last
 *  re-check, so an app that started meanwhile blocks the later items. */
export const RECHECK_AFTER_MS = 30_000;
const ACTABLE_CATEGORIES = new Set(["disk", "system"]);

export type ActReason =
    | "not-found"
    | "blocked"
    | "unknown-action"
    | "category-not-allowed"
    | "method-required"
    | "method-not-applicable"
    | "method-conflict"
    | "confirm-required"
    | "outside-allowlist"
    | "in-use"
    | "stale"
    | "locked";

export type ActStatus = "ok" | "staged" | "skipped" | "failed" | "refused";
export type FreesNow = "yes" | "no" | "later";

export interface ActItem {
    findingId: string;
    status: ActStatus;
    reason?: ActReason;
    /** Null only when there is no fresh finding to read it from: `not-found`, and `locked` (refused before re-deriving). */
    severity: Severity | null;
    paths: string[];
    estimatedBytes: number | null;
    remeasuredBytes: number | null;
    freesNow: FreesNow;
    trashPaths?: string[];
    restore?: string | null;
    requiredConfirm?: ConfirmMode;
    expectedPhrase?: string;
    blacklistReason?: string;
    blockers?: string[];
    error?: string;
}

export interface ActVolume {
    /** A path on the measured volume (the parent of the first item's first path). Null when nothing ran. */
    path: string | null;
    availableBefore: number | null;
    availableAfter: number | null;
    deltaBytes: number | null;
    settleNote: string;
}

export interface ActFollowUp {
    findingId: string;
    actionId: string;
    label: string;
    confirm: ConfirmMode;
    confirmPhrase?: string;
}

export interface ActResult {
    schemaVersion: typeof ACT_SCHEMA_VERSION;
    runId: string;
    analyzerId: string;
    actionId: string;
    method: RemoveMethod | null;
    dryRun: boolean;
    startedAt: string;
    endedAt: string;
    volume: ActVolume;
    manifestPath: string | null;
    items: ActItem[];
    totals: {
        requested: number;
        ok: number;
        staged: number;
        skipped: number;
        failed: number;
        refused: number;
        estimatedBytes: number;
        remeasuredBytes: number;
    };
    followUps: ActFollowUp[];
}

export interface ManifestPathEntry {
    path: string;
    kind: "file" | "dir" | "symlink" | "other" | "missing";
    allocatedBytes: number | null;
    apparentBytes: number | null;
    mtime: string | null;
    entries: number | null;
}

export type ActEvent =
    | {
          type: "plan";
          schemaVersion: typeof ACT_SCHEMA_VERSION;
          runId: string;
          at: string;
          argv: string[];
          analyzerId: string;
          actionId: string;
          method: RemoveMethod | null;
          dryRun: boolean;
          volume: { path: string | null; availableBefore: number | null; totalBefore: number | null };
          items: Array<{
              findingId: string;
              severity: Severity;
              title: string;
              paths: ManifestPathEntry[];
              confirmedWith: "none" | "yes" | "phrase";
              restore: string | null;
          }>;
          refused: Array<{ findingId: string; reason: ActReason }>;
      }
    | { type: "item-start"; findingId: string; at: string }
    | {
          type: "item-done";
          findingId: string;
          status: ActStatus;
          error: string | null;
          trashPaths?: string[];
          at: string;
      }
    | { type: "volume-after"; availableAfter: number | null; at: string }
    | { type: "result"; result: ActResult };

export interface ActOptions {
    actionId: string;
    analyzerId: string;
    ids: string[];
    method?: RemoveMethod;
    yes: boolean;
    confirm: string[];
    /** The `reclaimableBytes` the caller showed; a fresh value more than 25% away makes the item `stale`. */
    expect?: Map<string, number>;
    /** The `pathsHash` the caller showed; a fresh finding with another path set is `stale`. */
    expectPaths?: Map<string, string>;
    dryRun: boolean;
    argv: string[];
}

export interface ActDeps {
    analyzers: Analyzer[];
    manifestsDir?: string;
    lockPath?: string;
    home?: string;
    onEvent?: (event: ActEvent) => void;
    trash?: (path: string) => Promise<TrashResult>;
    remove?: (path: string) => Promise<void>;
    statfs?: (path: string) => { available: number; total: number } | null;
    appendHistory?: (runId: string, result: ActionResult) => Promise<void>;
    processes?: ProcessLister;
    cwds?: CwdReader;
    now?: () => Date;
}

export interface ActRun {
    result: ActResult;
    exitCode: 0 | 1;
}

interface Passing {
    item: ActItem;
    finding: Finding;
    action: Action;
    paths: string[];
    confirmedWith: "none" | "yes" | "phrase";
}

interface InUseProbe {
    /** Blockers for these paths: a process working inside, or no process list at all. */
    blockersFor(paths: string[]): string[];
}

function defaultStatfs(path: string): { available: number; total: number } | null {
    try {
        const space = freeDiskSpace(path);
        return { available: space.available, total: space.total };
    } catch {
        return null;
    }
}

async function defaultRemove(path: string): Promise<void> {
    await rm(path, { recursive: true, force: false });
}

function numberOrNull(value: unknown): number | null {
    return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function remeasuredOf(finding: Finding): number | null {
    return numberOrNull(finding.metadata?.allocatedBytes) ?? numberOrNull(finding.reclaimableBytes);
}

function floorOf(finding: Finding): number | null {
    return numberOrNull(finding.metadata?.freeableFloorBytes) ?? remeasuredOf(finding);
}

function errorText(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}

function appendError(item: ActItem, text: string): void {
    item.error = item.error ? `${item.error}; ${text}` : text;
}

/** One process-table read per run: a removal path that a process works inside (its cwd) is in use, and a run without a
 *  process table refuses every removal. This run's own process and its ancestors never count. */
async function probeInUse(deps: ActDeps): Promise<InUseProbe> {
    const snapshot = await snapshotProcesses(deps.processes ?? listProcesses);

    if (!snapshot.ok) {
        return { blockersFor: () => [PROCESS_LIST_UNAVAILABLE] };
    }

    const own = selfAndAncestors(snapshot.procs);
    const pids = snapshot.procs.map((proc) => proc.pid).filter((pid) => !own.has(pid));
    const cwds = [...(deps.cwds ?? readCwds)(pids).entries()].filter(([pid]) => !own.has(pid));

    return {
        blockersFor: (paths) => {
            const inside = cwds.filter(([, cwd]) => paths.some((path) => cwd === path || cwd.startsWith(`${path}/`)));
            return inside.length > 0
                ? [
                      `a process works inside (pid ${inside
                          .map(([pid]) => pid)
                          .slice(0, 3)
                          .join(", ")})`,
                  ]
                : [];
        },
    };
}

function pathEntries(finding: Finding, paths: string[]): ManifestPathEntry[] {
    return paths.map((path) => {
        let stat: ReturnType<typeof lstatSync> | null = null;

        try {
            stat = lstatSync(path);
        } catch {
            stat = null;
        }

        if (!stat) {
            return { path, kind: "missing", allocatedBytes: null, apparentBytes: null, mtime: null, entries: null };
        }

        const kind = stat.isSymbolicLink() ? "symlink" : stat.isFile() ? "file" : stat.isDirectory() ? "dir" : "other";
        const single = paths.length === 1;

        if (kind === "dir") {
            return {
                path,
                kind,
                allocatedBytes: single ? remeasuredOf(finding) : null,
                apparentBytes: single ? numberOrNull(finding.metadata?.apparentBytes) : null,
                mtime: stat.mtime.toISOString(),
                entries: single ? numberOrNull(finding.metadata?.fileCount) : null,
            };
        }

        return {
            path,
            kind,
            allocatedBytes: stat.blocks * 512,
            apparentBytes: stat.size,
            mtime: stat.mtime.toISOString(),
            entries: 1,
        };
    });
}

class Manifest {
    private fd: number | null = null;

    constructor(readonly path: string) {}

    open(): void {
        mkdirSync(dirname(this.path), { recursive: true });
        this.fd = openSync(this.path, "a");
    }

    /** One JSON line, flushed to disk before the caller goes on, so a crash leaves a readable record. */
    append(event: ActEvent): void {
        if (this.fd === null) {
            return;
        }

        writeSync(this.fd, `${SafeJSON.stringify(event)}\n`);
        fsyncSync(this.fd);
    }

    close(): void {
        if (this.fd !== null) {
            closeSync(this.fd);
            this.fd = null;
        }
    }
}

function refusedItem(id: string, reason: ActReason, error: string): ActItem {
    return {
        findingId: id,
        status: "refused",
        reason,
        severity: null,
        paths: [],
        estimatedBytes: null,
        remeasuredBytes: null,
        freesNow: "no",
        error,
    };
}

function analyzerCtx(runId: string, dryRun: boolean): AnalyzerContext {
    return { runId, opts: { thorough: false, fresh: true, dryRun }, emit: () => {} };
}

async function rederive(
    analyzer: Analyzer,
    ids: string[],
    runId: string,
    dryRun: boolean
): Promise<Map<string, Finding>> {
    const fresh = new Map<string, Finding>();
    const wanted = new Set(ids);

    for (const finding of await analyzer.recheck(ids, analyzerCtx(runId, dryRun))) {
        if (wanted.has(finding.id)) {
            fresh.set(finding.id, finding);
        }
    }

    return fresh;
}

/**
 * `tools doctor act`: run one action on findings re-derived from a fresh scan of the owning analyzer, behind the
 * guards of the Disk Manager contract (first failure wins per finding): not-found, blocked, unknown or disallowed
 * action, method, confirm, path guard, in-use, stale. A path is never read from an id: an id the fresh scan does not
 * produce is `not-found`, and act removes only the `paths` of the finding the scan produced. The lock is taken before
 * the re-derive; the manifest's plan line is fsynced before the first change; the guard and the in-use check run
 * again right before each item, and a long run re-derives every 30 s.
 */
export async function runAct(opts: ActOptions, deps: ActDeps): Promise<ActRun> {
    const now = deps.now ?? (() => new Date());
    const started = now();
    const runId = makeRunId(started);
    const ids = [...new Set(opts.ids)];
    const settleNote = opts.method === "trash" ? SETTLE_NOTE_TRASH : SETTLE_NOTE_DELETE;
    const items: ActItem[] = [];
    const finish = (volume: ActVolume, manifestPath: string | null, followUps: ActFollowUp[]): ActRun => {
        const result = buildResult({ opts, runId, started, ended: now(), volume, manifestPath, items, followUps });
        deps.onEvent?.({ type: "result", result });
        const bad = items.some((item) => item.status === "failed" || item.status === "refused");
        return { result, exitCode: bad ? 1 : 0 };
    };
    let lock: LockHandle | null = null;

    if (!opts.dryRun) {
        try {
            lock = await acquireLock(deps.lockPath ?? ACT_LOCK_PATH, { staleMs: 30 * 60_000, updateMs: 60_000 });
        } catch (err) {
            for (const id of ids) {
                items.push(refusedItem(id, "locked", `another doctor act is running: ${errorText(err)}`));
            }

            const volume = { path: null, availableBefore: null, availableAfter: null, deltaBytes: null, settleNote };
            return finish(volume, null, []);
        }
    }

    try {
        return await runUnderLock({ opts, deps, runId, ids, items, settleNote, finish });
    } finally {
        await lock?.release().catch(() => {});
    }
}

async function runUnderLock(args: {
    opts: ActOptions;
    deps: ActDeps;
    runId: string;
    ids: string[];
    items: ActItem[];
    settleNote: string;
    finish: (volume: ActVolume, manifestPath: string | null, followUps: ActFollowUp[]) => ActRun;
}): Promise<ActRun> {
    const { opts, deps, runId, ids, items, settleNote, finish } = args;
    const now = deps.now ?? (() => new Date());
    const home = deps.home ?? homedir();
    const statfs = deps.statfs ?? defaultStatfs;
    const emit = (event: ActEvent): void => deps.onEvent?.(event);
    const analyzer = deps.analyzers.find((a) => a.id === opts.analyzerId) ?? null;

    if (!analyzer) {
        for (const id of ids) {
            items.push(refusedItem(id, "not-found", `unknown analyzer ${opts.analyzerId}`));
        }

        return finish(
            { path: null, availableBefore: null, availableAfter: null, deltaBytes: null, settleNote },
            null,
            []
        );
    }

    let current = await rederive(analyzer, ids, runId, opts.dryRun);
    let inUse = await probeInUse(deps);
    const passing: Passing[] = [];

    for (const id of ids) {
        const finding = current.get(id);

        if (!finding) {
            items.push(refusedItem(id, "not-found", "the fresh scan did not produce this finding"));
            continue;
        }

        const verdict = judge({ finding, analyzer, opts, home, inUse });
        items.push(verdict.item);

        if (verdict.pass) {
            passing.push(verdict.pass);
        }
    }

    const firstPath = passing.flatMap((p) => p.paths)[0] ?? null;
    const volumePath = firstPath ? dirname(firstPath) : passing.length > 0 ? home : null;
    const before = volumePath ? statfs(volumePath) : null;
    const planEvent = (): ActEvent => ({
        type: "plan",
        schemaVersion: ACT_SCHEMA_VERSION,
        runId,
        at: now().toISOString(),
        argv: opts.argv,
        analyzerId: opts.analyzerId,
        actionId: opts.actionId,
        method: opts.method ?? null,
        dryRun: opts.dryRun,
        volume: { path: volumePath, availableBefore: before?.available ?? null, totalBefore: before?.total ?? null },
        items: passing.map((p) => ({
            findingId: p.finding.id,
            severity: p.finding.severity,
            title: p.finding.title,
            paths: pathEntries(p.finding, p.paths),
            confirmedWith: p.confirmedWith,
            restore: p.item.restore ?? null,
        })),
        refused: items
            .filter((item) => item.status === "refused")
            .map((item) => ({ findingId: item.findingId, reason: item.reason ?? "not-found" })),
    });
    const volumeBefore: ActVolume = {
        path: volumePath,
        availableBefore: before?.available ?? null,
        availableAfter: null,
        deltaBytes: null,
        settleNote,
    };

    if (passing.length === 0 || opts.dryRun) {
        if (opts.dryRun) {
            emit(planEvent());

            for (const p of passing) {
                p.item.status = "skipped";
            }
        }

        return finish(volumeBefore, null, []);
    }

    const manifest = new Manifest(join(deps.manifestsDir ?? MANIFESTS_DIR, `${runId}.jsonl`));
    const followUps: ActFollowUp[] = [];
    const record = (p: Passing, event: ActEvent): void => {
        try {
            manifest.append(event);
        } catch (err) {
            appendError(p.item, `manifest line not written: ${errorText(err)}`);
        }

        emit(event);
    };

    try {
        try {
            manifest.open();
            const plan = planEvent();
            manifest.append(plan);
            emit(plan);
        } catch (err) {
            for (const p of passing) {
                p.item.status = "failed";
                p.item.error = `the manifest could not be written, so nothing was removed: ${errorText(err)}`;
            }

            return finish(volumeBefore, null, []);
        }

        let checkedAt = Date.now();

        for (const p of passing) {
            if (Date.now() - checkedAt > RECHECK_AFTER_MS) {
                const remaining = passing.filter((q) => q.item.status === "ok").map((q) => q.finding.id);
                current = await rederive(analyzer, remaining, runId, false);
                inUse = await probeInUse(deps);
                checkedAt = Date.now();
            }

            const late = lateRefusal({ p, analyzer, opts, home, inUse, current });

            if (late) {
                p.item.status = "refused";
                p.item.reason = late.reason;

                if (late.error) {
                    appendError(p.item, late.error);
                }

                if (late.blockers) {
                    p.item.blockers = late.blockers;
                }

                record(p, {
                    type: "item-done",
                    findingId: p.finding.id,
                    status: "refused",
                    error: p.item.error ?? null,
                    at: now().toISOString(),
                });
                continue;
            }

            record(p, { type: "item-start", findingId: p.finding.id, at: now().toISOString() });
            const outcome =
                p.action.kind === "remove-path"
                    ? await removeItem({ p, method: opts.method ?? "delete", deps, analyzer, home })
                    : await commandItem({ p, runId, followUps });
            record(p, {
                type: "item-done",
                findingId: p.finding.id,
                status: p.item.status,
                error: p.item.error ?? null,
                ...(p.item.trashPaths ? { trashPaths: p.item.trashPaths } : {}),
                at: now().toISOString(),
            });

            try {
                await (deps.appendHistory ?? appendHistory)(runId, {
                    ...outcome,
                    metadata: {
                        ...outcome.metadata,
                        method: opts.method ?? null,
                        paths: p.paths,
                        manifestPath: manifest.path,
                        ...(p.item.trashPaths ? { trashPaths: p.item.trashPaths } : {}),
                    },
                });
            } catch (err) {
                appendError(p.item, `history not written: ${errorText(err)}`);
            }
        }

        const after = volumePath ? statfs(volumePath) : null;
        const volumeAfter: ActEvent = {
            type: "volume-after",
            availableAfter: after?.available ?? null,
            at: now().toISOString(),
        };

        try {
            manifest.append(volumeAfter);
        } catch {
            // The items already carry their own log errors; the volume line is a summary only.
        }

        emit(volumeAfter);
        const delta = before && after ? after.available - before.available : null;
        settleFreesNow(passing, delta);

        return finish(
            {
                path: volumePath,
                availableBefore: before?.available ?? null,
                availableAfter: after?.available ?? null,
                deltaBytes: delta,
                settleNote,
            },
            manifest.path,
            followUps
        );
    } finally {
        manifest.close();
    }
}

/** Revalidate the full authorization against the latest finding before consuming it. */
function lateRefusal(args: {
    p: Passing;
    analyzer: Analyzer;
    opts: ActOptions;
    home: string;
    inUse: InUseProbe;
    current: Map<string, Finding>;
}): { reason: ActReason; error?: string; blockers?: string[] } | null {
    const { p } = args;
    const fresh = args.current.get(p.finding.id);

    if (!fresh) {
        return { reason: "not-found", error: "the finding vanished before its turn" };
    }

    if (pathsHash(metadataPaths(fresh)) !== pathsHash(p.paths)) {
        return { reason: "stale", error: "the finding's paths changed before its turn" };
    }

    const verdict = judge({ ...args, finding: fresh });
    Object.assign(p.item, verdict.item);

    if (!verdict.pass) {
        return { reason: verdict.item.reason ?? "unknown-action" };
    }

    // Keep the result array's item reference, but execute only the newly authorized action and finding.
    Object.assign(p, verdict.pass, { item: p.item });
    return null;
}

function judge(args: { finding: Finding; analyzer: Analyzer; opts: ActOptions; home: string; inUse: InUseProbe }): {
    item: ActItem;
    pass: Passing | null;
} {
    const { finding, analyzer, opts } = args;
    const paths = metadataPaths(finding);
    const shown = numberOrNull(finding.reclaimableBytes);
    const expected = opts.expect?.get(finding.id);
    const expectedPaths = opts.expectPaths?.get(finding.id);
    const restoreHint = typeof finding.metadata?.restoreHint === "string" ? finding.metadata.restoreHint : null;
    const item: ActItem = {
        findingId: finding.id,
        status: "refused",
        severity: finding.severity,
        paths,
        estimatedBytes: expected ?? shown,
        remeasuredBytes: remeasuredOf(finding),
        freesNow: "no",
    };
    const refuse = (reason: ActReason, extra: Partial<ActItem> = {}): { item: ActItem; pass: null } => {
        Object.assign(item, { reason, ...extra });
        return { item, pass: null };
    };

    if (finding.severity === "blocked") {
        return refuse("blocked", { blacklistReason: finding.blacklistReason ?? "blocked by the analyzer" });
    }

    const action = finding.actions.find((a) => a.id === opts.actionId);

    if (!action) {
        return refuse("unknown-action", {
            error: `the finding offers ${finding.actions.map((a) => a.id).join(", ") || "no actions"}`,
        });
    }

    if (!isActable(action) || !ACTABLE_CATEGORIES.has(analyzer.category)) {
        return refuse("category-not-allowed", { error: `${action.id} is not a reclaim action doctor act runs` });
    }

    if (action.kind === "remove-path") {
        if (!opts.method) {
            return refuse("method-required", { error: "pass --method trash or --method delete" });
        }

        if (action.method && action.method !== opts.method) {
            return refuse("method-conflict", { error: `${action.id} only works with --method ${action.method}` });
        }
    } else if (opts.method) {
        return refuse("method-not-applicable", { error: `${action.id} runs its own command; drop --method` });
    }

    const required: ConfirmMode = finding.severity === "dangerous" ? "typed" : action.confirm;
    const phrase = action.confirmPhrase ?? "DELETE";
    let confirmedWith: Passing["confirmedWith"] = "none";

    if (required === "yesno") {
        if (!opts.yes) {
            return refuse("confirm-required", { requiredConfirm: "yesno" });
        }

        confirmedWith = "yes";
    } else if (required === "typed") {
        if (!opts.confirm.includes(phrase)) {
            return refuse("confirm-required", { requiredConfirm: "typed", expectedPhrase: phrase });
        }

        confirmedWith = "phrase";
    }

    let realPaths: string[] = [];

    if (action.kind === "remove-path") {
        const guard = guardPaths({
            paths,
            allowRoots: analyzer.allowRoots(),
            home: args.home,
            analyzerId: analyzer.id,
        });

        if (!guard.ok) {
            return refuse("outside-allowlist", { error: guard.error });
        }

        realPaths = guard.realPaths;
    }

    const blockers = [
        ...metadataBlockers(finding),
        ...(action.kind === "remove-path" ? args.inUse.blockersFor([...paths, ...realPaths]) : []),
    ];

    if (blockers.length > 0) {
        return refuse("in-use", { blockers });
    }

    if (expected !== undefined && shown !== null && expected > 0) {
        const drift = Math.abs(shown - expected) / expected;

        if (drift > STALE_DRIFT) {
            return refuse("stale", {
                error: `now ${shown} bytes, the caller showed ${expected} (${Math.round(drift * 100)}% drift)`,
            });
        }
    }

    if (expectedPaths !== undefined && expectedPaths !== pathsHash(paths)) {
        return refuse("stale", { error: "the finding's paths changed since the caller showed them" });
    }

    item.status = "ok";
    item.restore = restoreHint;
    return { item, pass: { item, finding, action, paths, confirmedWith } };
}

async function trashPaths(paths: string[], deps: ActDeps): Promise<TrashResult[]> {
    if (deps.trash) {
        const trash = deps.trash;
        const results: TrashResult[] = [];

        for (const path of paths) {
            results.push(await trash(path));
        }

        return results;
    }

    return moveManyToTrash(paths);
}

async function removeItem(args: {
    p: Passing;
    method: RemoveMethod;
    deps: ActDeps;
    analyzer: Analyzer;
    home: string;
}): Promise<ActionResult> {
    const { p, method, deps, analyzer, home } = args;
    const moved: string[] = [];

    try {
        for (const path of p.paths) {
            const inUse = await probeInUse(deps);
            const guarded = guardPaths({
                paths: [path],
                allowRoots: analyzer.allowRoots(),
                home,
                analyzerId: analyzer.id,
            });
            if (!guarded.ok) {
                throw new Error(`Refusing removal: ${guarded.error}`);
            }
            const blockers = inUse.blockersFor([path, ...guarded.realPaths]);
            if (blockers.length > 0) {
                throw new Error(`Refusing removal: ${blockers.join("; ")}`);
            }
            if (method === "trash") {
                // One consuming call per guarded path; another path may change while this one is in flight.
                const [result] = await trashPaths([path], deps);
                if (!result?.ok) {
                    throw new Error(result?.error ?? "Trash returned no result");
                }
                moved.push(result.trashPath ?? path);
            } else {
                await (deps.remove ?? defaultRemove)(path);
                if (p.action.recreateEmpty) {
                    await mkdir(path, { recursive: true });
                }
            }
        }
    } catch (err) {
        p.item.status = "failed";
        p.item.error = errorText(err);

        if (moved.length > 0) {
            p.item.trashPaths = moved;
        }

        return { findingId: p.finding.id, actionId: p.action.id, status: "failed", error: p.item.error };
    }

    if (method === "trash") {
        p.item.status = "staged";
        p.item.trashPaths = moved;
        p.item.restore = "Finder: Put Back from the Trash";
        return { findingId: p.finding.id, actionId: p.action.id, status: "staged", actualReclaimedBytes: 0 };
    }

    p.item.status = "ok";
    return {
        findingId: p.finding.id,
        actionId: p.action.id,
        status: "ok",
        actualReclaimedBytes: floorOf(p.finding) ?? undefined,
    };
}

async function commandItem(args: { p: Passing; runId: string; followUps: ActFollowUp[] }): Promise<ActionResult> {
    const { p } = args;
    const result = await runOne({ runId: args.runId, dryRun: false }, p.finding, p.action);
    p.item.status = result.status === "staged" ? "staged" : result.status;

    if (result.error) {
        p.item.error = result.error;
    }

    for (const next of p.action.followUp?.(result) ?? []) {
        args.followUps.push({
            findingId: p.finding.id,
            actionId: next.id,
            label: next.label,
            confirm: next.confirm,
            ...(next.confirmPhrase !== undefined ? { confirmPhrase: next.confirmPhrase } : {}),
        });
    }

    return result;
}

/** Trash and failures free nothing now. A delete is "yes" once statfs shows at least 90% of the floor bytes, else
 *  "later" (APFS hands large deletes back over minutes). */
function settleFreesNow(passing: Passing[], delta: number | null): void {
    const deleted = passing.filter((p) => p.item.status === "ok");
    const expected = deleted.reduce((sum, p) => sum + (floorOf(p.finding) ?? 0), 0);
    const settled = delta !== null && expected > 0 && delta >= expected * 0.9;

    for (const p of passing) {
        if (p.item.status === "ok") {
            p.item.freesNow = p.action.kind === "remove-path" && settled ? "yes" : "later";
        } else {
            p.item.freesNow = "no";
        }
    }
}

function buildResult(args: {
    opts: ActOptions;
    runId: string;
    started: Date;
    ended: Date;
    volume: ActVolume;
    manifestPath: string | null;
    items: ActItem[];
    followUps: ActFollowUp[];
}): ActResult {
    const count = (status: ActStatus): number => args.items.filter((item) => item.status === status).length;
    const counted = args.items.filter((item) => item.status !== "refused" && item.status !== "failed");

    return {
        schemaVersion: ACT_SCHEMA_VERSION,
        runId: args.runId,
        analyzerId: args.opts.analyzerId,
        actionId: args.opts.actionId,
        method: args.opts.method ?? null,
        dryRun: args.opts.dryRun,
        startedAt: args.started.toISOString(),
        endedAt: args.ended.toISOString(),
        volume: args.volume,
        manifestPath: args.manifestPath,
        items: args.items,
        totals: {
            requested: args.items.length,
            ok: count("ok"),
            staged: count("staged"),
            skipped: count("skipped"),
            failed: count("failed"),
            refused: count("refused"),
            estimatedBytes: counted.reduce((sum, item) => sum + (item.estimatedBytes ?? 0), 0),
            remeasuredBytes: counted.reduce((sum, item) => sum + (item.remeasuredBytes ?? 0), 0),
        },
        followUps: args.followUps,
    };
}
