import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { WatchChange, WatchedRoot } from "../fs/watch-driver/types";
import { HOOK_GIT_TIMEOUT_MS, readHookStatusAsync } from "./hook-status";
import type { StatusEntry } from "./porcelain";

export const RESEED_REASONS = [
    "git-state",
    "ignore-rules",
    "too-many-paths",
    "fresh-instance",
    "recrawl",
    "overflow",
    "drift",
] as const;
export type ReseedReason = (typeof RESEED_REASONS)[number];

export interface InventoryCost {
    cpuMs: number;
    gitRuns: number;
    fullStatus: boolean;
    fenceMs: number;
}

export type InventorySnapshot =
    | {
          state: "ok";
          clock: string;
          head: string | null;
          entries: StatusEntry[];
          source: "inventory" | "seed" | "reseed";
          reseed?: ReseedReason;
          changed: WatchChange[] | null;
          verifiedMsAgo: number;
          cost: InventoryCost;
      }
    | { state: "unavailable"; reason: "fence-timeout" | "git-failed" };

export interface InventoryCounters {
    answers: number;
    seeds: number;
    reseeds: Record<ReseedReason, number>;
    reconciles: number;
    drifts: number;
    fenceTimeouts: number;
}

const IGNORE_FILES = new Set([".gitignore", ".gitattributes", ".gitmodules"]);
const BOUNDARY_LOG = 64;

function parentOf(path: string): string | null {
    const slash = path.replace(/\/+$/, "").lastIndexOf("/");
    return slash > 0 ? path.slice(0, slash) : null;
}

function ancestorsTopDown(path: string): string[] {
    const parts = path.replace(/\/+$/, "").split("/");
    const result: string[] = [];

    for (let i = 1; i < parts.length; i++) {
        result.push(parts.slice(0, i).join("/"));
    }

    return result;
}

/** The highest ancestor that holds no tracked file, or the path itself; sorted, no point under another. */
export function collapsePoints(changed: readonly string[], trackedDirs: ReadonlySet<string>): string[] {
    const points = new Set<string>();

    for (const raw of changed) {
        const path = raw.replace(/\\/g, "/").replace(/\/+$/, "");

        if (!path) {
            continue;
        }

        const untrackedAncestor = ancestorsTopDown(path).find((dir) => !trackedDirs.has(dir));
        points.add(untrackedAncestor ?? path);
    }

    const sorted = [...points].sort();
    return sorted.filter((point) => !sorted.some((other) => other !== point && point.startsWith(`${other}/`)));
}

function statStamp(path: string): string {
    const stat = statSync(path, { throwIfNoEntry: false });
    return stat ? `${stat.ino}:${stat.size}:${stat.mtimeMs}` : "-";
}

/**
 * Index stat, `logs/HEAD` stat and the text of `HEAD`, read without a Git process. `info/exclude` is in the stamp too:
 * it lives in the admin folder, which no driver reports.
 */
export function gitStateStamp(gitDir: string): string {
    let head = "-";

    try {
        head = readFileSync(join(gitDir, "HEAD"), "utf8").trim();
    } catch {
        // No HEAD file: the stamp says so, and a later HEAD changes it.
    }

    return [
        statStamp(join(gitDir, "index")),
        statStamp(join(gitDir, "logs", "HEAD")),
        statStamp(join(gitDir, "info", "exclude")),
        head,
    ].join("|");
}

function isIgnoreRuleChange(path: string): boolean {
    const base = path.slice(path.lastIndexOf("/") + 1);
    return IGNORE_FILES.has(base);
}

function entryGroup(entry: StatusEntry): number {
    return entry.kind === "untracked" ? 1 : entry.kind === "ignored" ? 2 : 0;
}

/** Git's order: tracked entries by path, then untracked, then ignored. */
function sortEntries(entries: StatusEntry[]): StatusEntry[] {
    return entries.sort((a, b) => entryGroup(a) - entryGroup(b) || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

function underPoint(entryPath: string, point: string): boolean {
    const path = entryPath.replace(/\/+$/, "");
    return path === point || path.startsWith(`${point}/`);
}

function sameEntries(a: readonly StatusEntry[], b: readonly StatusEntry[]): StatusEntry[] {
    const key = (entry: StatusEntry) =>
        `${entry.kind} ${entry.index}${entry.worktree} ${entry.submodule ?? ""} ${entry.path}`;
    const left = new Map(a.map((entry) => [key(entry), entry]));
    const right = new Map(b.map((entry) => [key(entry), entry]));
    const drift: StatusEntry[] = [];

    for (const [name, entry] of right) {
        if (!left.has(name)) {
            drift.push(entry);
        }
    }

    for (const [name, entry] of left) {
        if (!right.has(name)) {
            drift.push(entry);
        }
    }

    return drift;
}

async function trackedDirsOf(root: string, signal?: AbortSignal): Promise<{ dirs: Set<string>; cpuMs: number } | null> {
    const proc = Bun.spawn(["git", "-C", root, "--no-optional-locks", "ls-files", "-z"], {
        stdout: "pipe",
        stderr: "pipe",
        timeout: HOOK_GIT_TIMEOUT_MS,
        signal,
    });
    const [text, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    const cpuMs = Number(proc.resourceUsage()?.cpuTime.total ?? 0n) / 1000;

    if (exitCode !== 0) {
        return null;
    }

    const dirs = new Set<string>();

    for (const path of text.split("\0")) {
        let parent = parentOf(path);

        while (parent !== null && !dirs.has(parent)) {
            dirs.add(parent);
            parent = parentOf(parent);
        }
    }

    return { dirs, cpuMs };
}

/**
 * The Git status of one root kept current from a watcher. The invariant: at clock C the inventory equals what a full
 * status prints at C. A watcher never supplies an entry: it only names paths, and each one is asked of Git again,
 * limited to its collapse point. Memory only, so there is no saved shape.
 */
export class StatusInventory {
    private readonly root: string;
    private readonly gitDir: string;
    private readonly watched: WatchedRoot;
    private readonly read: typeof readHookStatusAsync;
    private readonly now: () => number;
    private readonly reconcileAfterMs: number;
    private readonly maxCollapsePoints: number;
    private entries: StatusEntry[] | null = null;
    private head: string | null = null;
    private clock: string | null = null;
    private trackedDirs = new Set<string>();
    private stamp = "";
    private lastFull = 0;
    private boundaries: Array<{ clock: string; changes: WatchChange[] | null }> = [];
    private chain: Promise<unknown> = Promise.resolve();
    private readonly count: InventoryCounters = {
        answers: 0,
        seeds: 0,
        reseeds: {
            "git-state": 0,
            "ignore-rules": 0,
            "too-many-paths": 0,
            "fresh-instance": 0,
            recrawl: 0,
            overflow: 0,
            drift: 0,
        },
        reconciles: 0,
        drifts: 0,
        fenceTimeouts: 0,
    };

    constructor(options: {
        root: string;
        gitDir: string;
        watched: WatchedRoot;
        read?: typeof readHookStatusAsync;
        now?: () => number;
        reconcileAfterMs?: number;
        maxCollapsePoints?: number;
    }) {
        this.root = options.root;
        this.gitDir = options.gitDir;
        this.watched = options.watched;
        this.read = options.read ?? readHookStatusAsync;
        this.now = options.now ?? Date.now;
        this.reconcileAfterMs = options.reconcileAfterMs ?? 60_000;
        this.maxCollapsePoints = options.maxCollapsePoints ?? 200;
    }

    /** One call at a time per inventory: a later call waits for the earlier one and then takes its own boundary. */
    private serial<T>(work: () => Promise<T>): Promise<T> {
        const next = this.chain.then(work, work);
        this.chain = next.catch(() => undefined);
        return next;
    }

    snapshot(options: { since: string | null; fenceMs: number; signal?: AbortSignal }): Promise<InventorySnapshot> {
        return this.serial(() => this.takeSnapshot(options));
    }

    reconcileIfDue(): Promise<{ ran: boolean; drift: StatusEntry[] }> {
        return this.serial(async () => {
            if (this.entries === null || this.now() - this.lastFull < this.reconcileAfterMs) {
                return { ran: false, drift: [] };
            }

            const cost: InventoryCost = { cpuMs: 0, gitRuns: 0, fullStatus: false, fenceMs: 0 };
            const boundary = await this.watched.changesSince(this.clock, { fenceMs: 1_000 });

            if (boundary.kind === "lost") {
                return { ran: false, drift: [] };
            }

            const applied = await this.apply(
                boundary.changes.map((change) => change.path),
                cost
            );

            if (!applied) {
                return { ran: false, drift: [] };
            }

            this.remember(boundary.clock, boundary.changes);
            const full = await this.read(this.root);
            this.count.reconciles += 1;

            if (!full.ok || this.entries === null) {
                return { ran: true, drift: [] };
            }

            const drift = sameEntries(this.entries, full.value.entries);
            this.entries = sortEntries([...full.value.entries]);
            this.head = full.value.branch?.oid ?? this.head;
            this.lastFull = this.now();

            if (drift.length > 0) {
                this.count.drifts += 1;
                this.count.reseeds.drift += 1;
            }

            return { ran: true, drift };
        });
    }

    counters(): InventoryCounters {
        return structuredClone(this.count);
    }

    private remember(clock: string, changes: WatchChange[] | null): void {
        this.clock = clock;
        this.boundaries.push({ clock, changes });

        if (this.boundaries.length > BOUNDARY_LOG) {
            this.boundaries.splice(0, this.boundaries.length - BOUNDARY_LOG);
        }
    }

    /** The driver's list between `since` and now, or null when `since` is unknown here or an interval was lost. */
    private changedSince(since: string | null): WatchChange[] | null {
        if (since === null) {
            return null;
        }

        const index = this.boundaries.findIndex((boundary) => boundary.clock === since);

        if (index < 0) {
            return null;
        }

        const changes: WatchChange[] = [];

        for (const boundary of this.boundaries.slice(index + 1)) {
            if (boundary.changes === null) {
                return null;
            }

            changes.push(...boundary.changes);
        }

        return changes;
    }

    private async seed(
        fenceMs: number,
        cost: InventoryCost,
        signal?: AbortSignal
    ): Promise<"ok" | "fence-timeout" | "git-failed"> {
        const start = await this.watched.changesSince(null, { fenceMs, signal });

        if (start.kind === "lost") {
            return "fence-timeout";
        }

        cost.fenceMs += start.fenceMs;
        const stamp = gitStateStamp(this.gitDir);
        const [full, tracked] = await Promise.all([this.read(this.root, { signal }), trackedDirsOf(this.root, signal)]);
        cost.gitRuns += 2;
        cost.fullStatus = true;
        cost.cpuMs += full.cost.cpuMs + (tracked?.cpuMs ?? 0);

        if (!full.ok || !tracked) {
            return "git-failed";
        }

        this.entries = sortEntries([...full.value.entries]);
        this.head = full.value.branch?.oid ?? null;
        this.trackedDirs = tracked.dirs;
        this.stamp = stamp;
        this.lastFull = this.now();
        this.boundaries = [];
        this.remember(start.clock, null);
        return "ok";
    }

    /** Asks Git again about every changed path, limited to its collapse point. False when Git failed. */
    private async apply(paths: readonly string[], cost: InventoryCost): Promise<boolean> {
        const points = collapsePoints(paths, this.trackedDirs);

        if (points.length === 0 || this.entries === null) {
            return true;
        }

        const limited = await this.read(this.root, { pathspecs: points.map((point) => `:(literal)${point}`) });
        cost.gitRuns += 1;
        cost.cpuMs += limited.cost.cpuMs;

        if (!limited.ok) {
            return false;
        }

        const kept = this.entries.filter((entry) => !points.some((point) => underPoint(entry.path, point)));
        this.entries = sortEntries([...kept, ...limited.value.entries]);
        this.head = limited.value.branch?.oid ?? this.head;
        return true;
    }

    private reseedReason(changes: readonly WatchChange[]): ReseedReason | null {
        if (gitStateStamp(this.gitDir) !== this.stamp) {
            return "git-state";
        }

        if (changes.some((change) => isIgnoreRuleChange(change.path))) {
            return "ignore-rules";
        }

        if (
            collapsePoints(
                changes.map((change) => change.path),
                this.trackedDirs
            ).length > this.maxCollapsePoints
        ) {
            return "too-many-paths";
        }

        return null;
    }

    private answer(options: {
        since: string | null;
        source: "inventory" | "seed" | "reseed";
        reseed?: ReseedReason;
        cost: InventoryCost;
    }): InventorySnapshot {
        this.count.answers += 1;
        return {
            state: "ok",
            clock: this.clock ?? "",
            head: this.head,
            entries: [...(this.entries ?? [])],
            source: options.source,
            ...(options.reseed ? { reseed: options.reseed } : {}),
            changed: options.source === "inventory" ? this.changedSince(options.since) : null,
            verifiedMsAgo: this.now() - this.lastFull,
            cost: options.cost,
        };
    }

    private async takeSnapshot(options: {
        since: string | null;
        fenceMs: number;
        signal?: AbortSignal;
    }): Promise<InventorySnapshot> {
        const cost: InventoryCost = { cpuMs: 0, gitRuns: 0, fullStatus: false, fenceMs: 0 };

        const reseed = async (reason: ReseedReason | null): Promise<InventorySnapshot> => {
            const seeded = await this.seed(options.fenceMs, cost, options.signal);

            if (seeded !== "ok") {
                this.count.fenceTimeouts += seeded === "fence-timeout" ? 1 : 0;
                return { state: "unavailable", reason: seeded };
            }

            if (reason) {
                this.count.reseeds[reason] += 1;
                return this.answer({ since: options.since, source: "reseed", reseed: reason, cost });
            }

            this.count.seeds += 1;
            return this.answer({ since: options.since, source: "seed", cost });
        };

        if (this.entries === null || this.clock === null) {
            return reseed(null);
        }

        const boundary = await this.watched.changesSince(this.clock, {
            fenceMs: options.fenceMs,
            signal: options.signal,
        });

        if (boundary.kind === "lost") {
            if (
                boundary.reason === "fresh-instance" ||
                boundary.reason === "recrawl" ||
                boundary.reason === "overflow"
            ) {
                return reseed(boundary.reason);
            }

            this.count.fenceTimeouts += boundary.reason === "fence-timeout" ? 1 : 0;
            return { state: "unavailable", reason: "fence-timeout" };
        }

        cost.fenceMs += boundary.fenceMs;
        const reason = this.reseedReason(boundary.changes);

        if (reason) {
            return reseed(reason);
        }

        if (
            !(await this.apply(
                boundary.changes.map((change) => change.path),
                cost
            ))
        ) {
            return { state: "unavailable", reason: "git-failed" };
        }

        this.remember(boundary.clock, boundary.changes);
        return this.answer({ since: options.since, source: "inventory", cost });
    }
}
