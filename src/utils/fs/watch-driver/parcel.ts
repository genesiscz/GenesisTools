import { randomBytes } from "node:crypto";
import { closeSync, openSync, statSync, unlinkSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import type { AsyncSubscription } from "@parcel/watcher";
import { nativeWatcherBackend } from "../watcher";
import type { WatchChange, WatchChanges, WatchDriver, WatchedRoot, WatchOpen } from "./types";

const DEFAULT_MAX_EVENTS = 50_000;
const COOKIE_PREFIX = "genesis-watch-cookie-";

function toPosix(path: string): string {
    return path.replace(/\\/g, "/");
}

/** True when `child` is `parent` or below it. */
function isInside(parent: string, child: string): boolean {
    const rel = relative(parent, child);
    return rel === "" || (!rel.startsWith("..") && !/^[a-zA-Z]:/.test(rel) && !rel.startsWith("/"));
}

/**
 * The Parcel driver: a live `subscribe` on the root with the platform's own backend (never Parcel's Watchman backend,
 * which would be the first driver twice) and no ignore list. Events stay in memory, at most `maxEvents`; past the cap a
 * boundary older than the dropped events answers `lost: overflow`. The clock is `<subscription id>:<sequence>`.
 *
 * The fence is the driver's own cookie: one uniquely named file created and removed in the root's Git admin folder,
 * awaited through the live stream (never a snapshot replay). A linked worktree has no folder inside the watched tree
 * that Git ignores, so `open` answers `unsupported-root` there.
 */
export function parcelDriver(options: { maxEvents?: number } = {}): WatchDriver {
    const maxEvents = options.maxEvents ?? DEFAULT_MAX_EVENTS;
    const subscriptions = new Set<AsyncSubscription>();

    const open = async (spec: { root: string; gitDir: string }): Promise<WatchOpen> => {
        const root = resolve(spec.root);
        const gitDir = resolve(spec.gitDir);

        if (statSync(join(root, ".git"), { throwIfNoEntry: false })?.isFile() || !isInside(root, gitDir)) {
            return {
                ok: false,
                reason: "unsupported-root",
                detail: "a linked worktree has no Git admin folder in the tree",
            };
        }

        let watcher: typeof import("@parcel/watcher");

        try {
            watcher = await import("@parcel/watcher");
        } catch (error) {
            return { ok: false, reason: "not-installed", detail: String(error) };
        }

        const instance = `parcel-${randomBytes(6).toString("hex")}`;
        const events: Array<{ seq: number; change: WatchChange }> = [];
        const waiters = new Map<string, () => void>();
        let seq = 0;
        let droppedThrough = 0;
        let failure: string | null = null;
        let closed = false;
        let cookieCount = 0;

        const onEvents = (error: Error | null, batch: Array<{ path: string; type: string }>) => {
            if (error) {
                failure = error.message;
                return;
            }

            for (const event of batch) {
                const absolute = resolve(event.path);

                if (isInside(gitDir, absolute)) {
                    const waiter = waiters.get(absolute);

                    if (waiter && event.type === "create") {
                        waiters.delete(absolute);
                        waiter();
                    }

                    continue;
                }

                seq += 1;
                events.push({
                    seq,
                    change: { path: toPosix(relative(root, absolute)), exists: event.type !== "delete" },
                });
            }

            if (events.length > maxEvents) {
                const dropped = events.splice(0, events.length - maxEvents);
                droppedThrough = dropped[dropped.length - 1]?.seq ?? droppedThrough;
            }
        };

        let subscription: AsyncSubscription;

        try {
            subscription = await watcher.subscribe(root, onEvents, {
                backend: nativeWatcherBackend(process.platform, false),
            });
        } catch (error) {
            return { ok: false, reason: "open-failed", detail: String(error) };
        }

        subscriptions.add(subscription);

        /** Creates a cookie in the admin folder and waits until its create event came through the stream. */
        const fence = (fenceMs: number, signal?: AbortSignal): Promise<boolean> =>
            new Promise((resolveFence) => {
                cookieCount += 1;
                const cookie = join(gitDir, `${COOKIE_PREFIX}${instance}-${cookieCount}`);
                let settled = false;
                const finish = (ok: boolean) => {
                    if (settled) {
                        return;
                    }

                    settled = true;
                    clearTimeout(timer);
                    waiters.delete(cookie);

                    try {
                        unlinkSync(cookie);
                    } catch {
                        // The cookie may be gone already; nothing else depends on its removal.
                    }

                    resolveFence(ok);
                };
                const timer = setTimeout(() => finish(false), fenceMs);
                waiters.set(cookie, () => finish(true));
                signal?.addEventListener("abort", () => finish(false), { once: true });

                try {
                    closeSync(openSync(cookie, "w"));
                } catch {
                    finish(false);
                }
            });

        const watched: WatchedRoot = {
            instance,
            async changesSince(since, fenceOptions): Promise<WatchChanges> {
                if (closed) {
                    return { kind: "lost", reason: "closed" };
                }

                if (failure) {
                    return { kind: "lost", reason: "driver-error", detail: failure };
                }

                const started = performance.now();

                if (!(await fence(fenceOptions.fenceMs, fenceOptions.signal))) {
                    return { kind: "lost", reason: "fence-timeout" };
                }

                const fenceMs = performance.now() - started;
                const clock = `${instance}:${seq}`;

                if (since === null) {
                    return { kind: "changes", clock, changes: [], fenceMs };
                }

                const split = since.lastIndexOf(":");
                const sinceSeq = Number(since.slice(split + 1));

                if (since.slice(0, split) !== instance || !Number.isInteger(sinceSeq)) {
                    return { kind: "lost", reason: "fresh-instance" };
                }

                if (sinceSeq < droppedThrough) {
                    return {
                        kind: "lost",
                        reason: "overflow",
                        detail: `more than ${maxEvents} events since the boundary`,
                    };
                }

                const changes = events.filter((event) => event.seq > sinceSeq).map((event) => event.change);
                return { kind: "changes", clock, changes, fenceMs };
            },
            async close() {
                if (closed) {
                    return;
                }

                closed = true;
                subscriptions.delete(subscription);
                await subscription.unsubscribe();
            },
        };

        return { ok: true, watched };
    };

    return {
        facts: { outlivesProcess: false, fence: "own-cookie", fencesLinkedWorktrees: false },
        async available() {
            try {
                await import("@parcel/watcher");
                return { ok: true, version: "@parcel/watcher" };
            } catch (error) {
                return { ok: false, reason: String(error) };
            }
        },
        open,
        async dispose() {
            const open = [...subscriptions];
            subscriptions.clear();
            await Promise.all(open.map((subscription) => subscription.unsubscribe()));
        },
    };
}
