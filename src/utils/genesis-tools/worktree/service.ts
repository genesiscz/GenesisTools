import { realpathSync, statSync } from "node:fs";
import { WATCH_DRIVERS, type WatchDriverId } from "../../fs/watch-driver/registry";
import type { WatchDriver, WatchedRoot } from "../../fs/watch-driver/types";
import { worktreeGitDir } from "../../git/hook-status";
import { StatusInventory } from "../../git/status-inventory";
import { logger } from "../../logger";
import type { WorktreeSnapshot, WorktreeSnapshotParams, WorktreeUnavailable, WorktreeWatcher } from "./types";

const log = logger.child({ component: "worktree-service" });

export interface WorktreeService {
    snapshot(params: WorktreeSnapshotParams, signal: AbortSignal): Promise<WorktreeSnapshot>;
    watchers(): WorktreeWatcher[];
    dispose(): Promise<void>;
}

interface RootEntry {
    driver: WatchDriverId;
    root: string;
    generation: string;
    state: "opening" | "ready" | "failed";
    failure: WorktreeUnavailable | null;
    failedAt: number;
    watched: WatchedRoot | null;
    inventory: StatusInventory | null;
    openedAt: string;
    lastAnswerAt: string | null;
    lastUsed: number;
    busy: number;
    cooldownUntil: number;
}

const DEFAULT_FENCE_MS = 500;
const RETRY_FAILED_MS = 30_000;

/** The device and inode of the root folder and of its Git admin folder: a new clone at the same path is a new root. */
function generationOf(root: string, gitDir: string): string {
    const rootStat = statSync(root);
    const gitStat = statSync(gitDir);
    return `${rootStat.dev}.${rootStat.ino}-${gitStat.dev}.${gitStat.ino}`;
}

function markPrefix(entry: RootEntry): string {
    return `v1:${entry.driver}:${entry.watched?.instance ?? ""}:${entry.generation}:`;
}

/**
 * One inventory per driver and canonical root. The first call for a root answers `opening` at once and opens and
 * seeds in the background, so no caller waits for a crawl. At most `maxRoots` per driver, the least recently used
 * closed first. After a fence timeout the root answers `fence-timeout` for `fenceCooldownMs` without a wait. No timer
 * runs for an idle root.
 */
export function createWorktreeService(
    options: { drivers?: Partial<Record<WatchDriverId, WatchDriver>>; maxRoots?: number; fenceCooldownMs?: number } = {}
): WorktreeService {
    const maxRoots = options.maxRoots ?? 16;
    const fenceCooldownMs = options.fenceCooldownMs ?? 30_000;
    const drivers = new Map<WatchDriverId, Promise<WatchDriver>>();
    const roots = new Map<string, RootEntry>();

    for (const [id, driver] of Object.entries(options.drivers ?? {})) {
        const known = Object.keys(WATCH_DRIVERS).find((name): name is WatchDriverId => name === id);

        if (known && driver) {
            drivers.set(known, Promise.resolve(driver));
        }
    }

    const driverOf = (id: WatchDriverId): Promise<WatchDriver> => {
        let driver = drivers.get(id);

        if (!driver) {
            driver = WATCH_DRIVERS[id].load();
            drivers.set(id, driver);
        }

        return driver;
    };

    const closeEntry = (key: string, entry: RootEntry) => {
        roots.delete(key);
        void entry.watched?.close().catch((error) => log.debug({ error, root: entry.root }, "closing a watch failed"));
    };

    const makeRoom = (driver: WatchDriverId): boolean => {
        const ofDriver = [...roots.entries()].filter(([, entry]) => entry.driver === driver);

        if (ofDriver.length < maxRoots) {
            return true;
        }

        const idle = ofDriver.filter(([, entry]) => entry.busy === 0).sort((a, b) => a[1].lastUsed - b[1].lastUsed)[0];

        if (!idle) {
            return false;
        }

        closeEntry(idle[0], idle[1]);
        return true;
    };

    const open = async (entry: RootEntry, gitDir: string) => {
        try {
            const driver = await driverOf(entry.driver);
            const opened = await driver.open({ root: entry.root, gitDir });

            if (!opened.ok) {
                entry.state = "failed";
                entry.failure = opened.reason === "unsupported-root" ? "unsupported-root" : "no-driver";
                entry.failedAt = Date.now();
                log.debug({ root: entry.root, driver: entry.driver, opened }, "worktree watch did not open");
                return;
            }

            entry.watched = opened.watched;
            entry.inventory = new StatusInventory({ root: entry.root, gitDir, watched: opened.watched });
            const seeded = await entry.inventory.snapshot({ since: null, fenceMs: 5_000 });

            if (seeded.state !== "ok") {
                entry.state = "failed";
                entry.failure = seeded.reason;
                entry.failedAt = Date.now();
                return;
            }

            entry.state = "ready";
            log.debug({ root: entry.root, driver: entry.driver }, "worktree inventory seeded");
        } catch (error) {
            entry.state = "failed";
            entry.failure = "no-driver";
            entry.failedAt = Date.now();
            log.debug({ error, root: entry.root, driver: entry.driver }, "worktree watch failed to open");
        }
    };

    return {
        async snapshot(params, signal): Promise<WorktreeSnapshot> {
            const cpuBefore = process.cpuUsage();
            let root: string;

            try {
                root = realpathSync(params.root);
            } catch {
                return { state: "unavailable", reason: "not-a-worktree" };
            }

            const gitDir = worktreeGitDir(root);

            if (!gitDir) {
                return { state: "unavailable", reason: "not-a-worktree" };
            }

            const key = `${params.driver}\0${root}`;
            let entry = roots.get(key);

            if (entry?.state === "failed" && Date.now() - entry.failedAt > RETRY_FAILED_MS) {
                closeEntry(key, entry);
                entry = undefined;
            }

            if (!entry) {
                if (!makeRoom(params.driver)) {
                    return { state: "unavailable", reason: "over-capacity" };
                }

                entry = {
                    driver: params.driver,
                    root,
                    generation: generationOf(root, gitDir),
                    state: "opening",
                    failure: null,
                    failedAt: 0,
                    watched: null,
                    inventory: null,
                    openedAt: new Date().toISOString(),
                    lastAnswerAt: null,
                    lastUsed: Date.now(),
                    busy: 0,
                    cooldownUntil: 0,
                };
                roots.set(key, entry);
                void open(entry, gitDir);
                return { state: "unavailable", reason: "opening" };
            }

            entry.lastUsed = Date.now();

            if (entry.state === "opening") {
                return { state: "unavailable", reason: "opening" };
            }

            if (entry.state === "failed" || !entry.inventory) {
                return { state: "unavailable", reason: entry.failure ?? "no-driver" };
            }

            if (Date.now() < entry.cooldownUntil) {
                return { state: "unavailable", reason: "fence-timeout" };
            }

            const prefix = markPrefix(entry);
            const since = params.since?.startsWith(prefix) ? params.since.slice(prefix.length) : null;
            entry.busy += 1;

            try {
                const snap = await entry.inventory.snapshot({
                    since,
                    fenceMs: params.fenceMs ?? DEFAULT_FENCE_MS,
                    signal,
                });

                if (snap.state !== "ok") {
                    if (snap.reason === "fence-timeout") {
                        entry.cooldownUntil = Date.now() + fenceCooldownMs;
                    }

                    return { state: "unavailable", reason: snap.reason };
                }

                entry.lastAnswerAt = new Date().toISOString();
                const inventory = entry.inventory;
                void inventory.reconcileIfDue().catch((error) => log.debug({ error, root }, "reconcile failed"));
                const used = process.cpuUsage(cpuBefore);
                const { clock, ...rest } = snap;
                return {
                    ...rest,
                    mark: `${markPrefix(entry)}${clock}`,
                    cost: { ...snap.cost, cpuMs: snap.cost.cpuMs + (used.user + used.system) / 1000 },
                };
            } finally {
                entry.busy -= 1;
            }
        },
        watchers() {
            return [...roots.values()]
                .filter((entry) => entry.state === "ready" && entry.inventory)
                .map((entry) => ({
                    root: entry.root,
                    driver: entry.driver,
                    openedAt: entry.openedAt,
                    lastAnswerAt: entry.lastAnswerAt,
                    instance: entry.watched?.instance ?? "",
                    counters: entry.inventory?.counters() ?? {
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
                    },
                }));
        },
        async dispose() {
            for (const [key, entry] of [...roots.entries()]) {
                closeEntry(key, entry);
            }

            const loaded = await Promise.allSettled([...drivers.values()]);
            drivers.clear();
            await Promise.allSettled(
                loaded.map((result) => (result.status === "fulfilled" ? result.value.dispose() : Promise.resolve()))
            );
        },
    };
}
