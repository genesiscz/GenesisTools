import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { decisionFiles } from "@app/question/lib/decisions/read";
import { logDir } from "@app/question/lib/log-store";
import { sessionMessageQueueRoot } from "@genesiscz/utils/agent-sessions/message-queue";
import { createWatcher, type WatcherSubscription, watchPath } from "@genesiscz/utils/fs/watcher";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { nativeInboxState } from "@genesiscz/utils/macos/native-inbox";
import { profiler } from "@genesiscz/utils/profile";
import { withFileLock } from "@genesiscz/utils/storage/file-lock";
import { toolDataDir } from "@genesiscz/utils/storage/root";
import { prepareWidgetAsset } from "../composer/assets";
import { widgetDispatcher } from "../composer/dispatch";
import { type OutboxDispatcher, processWidgetOutbox } from "../composer/engine";
import { recoverWidgetOutbox } from "../composer/outbox";
import { readWarmStartRoster, writeWidgetRosterCache } from "./roster-cache";
import {
    type WidgetRosterProvider,
    type WidgetRosterScope,
    widgetRosterChange,
    widgetSessionRoots,
} from "./roster-index";
import { WidgetRosterReader } from "./roster-reader";
import { realWidgetSources, widgetSnapshot } from "./snapshot";
import { readWidgetState, widgetRoot } from "./storage";

const prof = profiler.scope("widget");

/** The safety refresh: a roster read and a snapshot, for changes no file event reported. */
const SAFETY_MS = 30_000;
/** With an inbox source unwatched, the safety refresh is what notices its changes. */
const DEGRADED_SAFETY_MS = 5000;
/** Every this many safety ticks the whole catalog is refreshed, for changes outside the watched session roots. */
const FULL_REFRESH_TICKS = 4;

export async function watchWidget({
    root,
    selectedKey,
    signal,
    emit,
    dependencies = {},
}: {
    root?: string;
    selectedKey?: string;
    signal: AbortSignal;
    emit: (snapshot: Awaited<ReturnType<typeof widgetSnapshot>>) => void;
    dependencies?: {
        prepare?: typeof prepareWidgetAsset;
        snapshot?: typeof widgetSnapshot;
        dispatcher?: OutboxDispatcher;
        inboxPaths?: { answerLog: string; database: string; decisions: string };
        watchInbox?: typeof createWatcher;
        watchSessions?: typeof createWatcher;
        sessionRoots?: Record<WidgetRosterProvider, string[]>;
    };
}): Promise<void> {
    const directory = widgetRoot(root);
    await mkdir(directory, { recursive: true });
    await withFileLock(
        join(directory, "worker.lock"),
        async () => {
            // Cold-start phases, as milliseconds since this process started (the app waits on the first snapshot).
            prof.record("start lock", performance.now());
            // This lock is the widget's "running" signal; refreshing now keeps the plugin hooks' state file current.
            nativeInboxState({ refresh: true });
            await recoverWidgetOutbox(directory);
            const jobs = new Map<string, { revision: number; controller: AbortController; done: Promise<void> }>();
            const dispatcher = dependencies.dispatcher ?? widgetDispatcher({ signal });
            const prepare = dependencies.prepare ?? prepareWidgetAsset;
            let roster: WidgetRosterReader | undefined;
            const readSnapshot: typeof widgetSnapshot =
                dependencies.snapshot ??
                ((options) =>
                    widgetSnapshot({
                        ...options,
                        sources: {
                            ...realWidgetSources,
                            sessions: async () => roster?.rows ?? [],
                            agents: async () => roster?.agents ?? { generatedAt: "", parents: [], orphans: [] },
                            rosterStatus: () => ({
                                loading: !roster?.agents.generatedAt && (roster?.loading ?? true),
                                error: roster?.error,
                            }),
                        },
                    }));
            let dispatchTask: Promise<void> | undefined;
            let last = "";
            const startedAt = Date.now();
            let emitted = false;
            const profiledInbox = new Map<string, { at: number; id: string }>();
            const refresh = async () => {
                const state = await readWidgetState(directory);
                const referenced = new Set([
                    ...Object.values(state.drafts).flatMap((draft) => draft.assetIds),
                    ...state.outgoing
                        .filter((message) => !["sent", "cancelled", "unknown"].includes(message.state))
                        .flatMap((message) => message.assetIds),
                ]);
                for (const [id, job] of jobs) {
                    const asset = state.assets[id];
                    if (!referenced.has(id) || asset?.type !== "video" || asset.revision !== job.revision) {
                        job.controller.abort();
                    }
                }
                for (const id of referenced) {
                    const asset = state.assets[id];
                    const old = jobs.get(id);
                    if (
                        asset?.type !== "video" ||
                        asset.status !== "pending" ||
                        old?.revision === asset.revision ||
                        signal.aborted
                    ) {
                        continue;
                    }
                    old?.controller.abort();
                    const controller = new AbortController();
                    const abort = () => controller.abort();
                    signal.addEventListener("abort", abort, { once: true });
                    const done = (async () => {
                        await old?.done;
                        if (!controller.signal.aborted) {
                            await prepare({ root: directory, id, signal: controller.signal });
                        }
                    })()
                        .catch((error) => {
                            logger.debug({ error, id }, "Widget video preparation ended");
                        })
                        .finally(() => {
                            signal.removeEventListener("abort", abort);
                            if (jobs.get(id)?.controller === controller) {
                                jobs.delete(id);
                            }
                        });
                    jobs.set(id, { revision: asset.revision, controller, done });
                }
                if (!dispatchTask && !signal.aborted) {
                    dispatchTask = processWidgetOutbox({ root: directory, dispatcher, signal })
                        .catch((error) => logger.warn({ error }, "Widget outgoing processing stopped"))
                        .finally(() => {
                            dispatchTask = undefined;
                        });
                }
                const snapshot = await prof.measureAsync("watch snapshot", () =>
                    readSnapshot({ root: directory, selectedKey, refresh: false })
                );
                const fingerprint = SafeJSON.stringify(snapshot);
                if (fingerprint !== last && !signal.aborted) {
                    last = fingerprint;
                    if (prof.enabled && snapshot.notifications?.complete) {
                        const active = new Set<string>();
                        for (const session of snapshot.notifications.sessions) {
                            for (const item of [session.unreadItem, session.pendingItem]) {
                                if (!item || item.kind === "result") {
                                    continue;
                                }
                                const key = item.key + (item.needsAnswer ? "|pending" : "|unread");
                                active.add(key);
                                const previous = profiledInbox.get(key);
                                if (previous?.id === item.id && previous.at === item.at) {
                                    continue;
                                }
                                profiledInbox.set(key, { id: item.id, at: item.at });
                                const latency = Date.now() - item.at;
                                if (item.at >= startedAt && latency >= 0) {
                                    prof.record("inbox receipt-to-publish", latency, `id=${item.id}`);
                                }
                            }
                        }
                        for (const key of profiledInbox.keys()) {
                            if (!active.has(key)) {
                                profiledInbox.delete(key);
                            }
                        }
                    }
                    if (!emitted) {
                        emitted = true;
                        prof.record(
                            "start first snapshot",
                            performance.now(),
                            snapshot.rosterLoading ? "roster loading" : `sessions=${snapshot.sessions.length}`
                        );
                    }
                    emit(snapshot);
                }
            };
            // The running refresh loop. Shutdown awaits it, so a refresh that was mid-flight at abort cannot
            // start an outbox processor or a video job after the worker lock is released.
            let refreshing: Promise<void> | undefined;
            let requested = false;
            const requestRefresh = async () => {
                requested = true;
                if (refreshing) {
                    return;
                }
                refreshing = (async () => {
                    try {
                        while (requested && !signal.aborted) {
                            requested = false;
                            await refresh();
                        }
                    } catch (error) {
                        if (!signal.aborted) {
                            logger.warn({ error }, "Widget refresh failed");
                        }
                    } finally {
                        refreshing = undefined;
                    }
                })();
                await refreshing;
            };
            if (!dependencies.snapshot) {
                let rosterReady = false;
                roster = new WidgetRosterReader({
                    changed: () => {
                        if (!rosterReady) {
                            rosterReady = true;
                            prof.record("start first roster", performance.now());
                        }
                        // One-shot snapshots (the settings page) read this instead of rebuilding the tree cold.
                        if (roster && !roster.error && roster.agents.generatedAt) {
                            const { rows, agents } = roster;
                            writeWidgetRosterCache({ root: directory, roster: { rows, agents } }).catch((error) => {
                                logger.debug({ error }, "Widget roster cache not written");
                            });
                        }
                        void requestRefresh();
                    },
                });
                // The first read of a fresh worker takes seconds; until it lands, show what the previous watch of this
                // root last showed, and start that read now so the worker boots while the watchers are set up.
                const warm = await readWarmStartRoster(directory);
                if (warm) {
                    roster.seed(warm);
                }
                prof.record("start roster cache", performance.now(), warm ? "seeded" : "none");
                roster.refresh();
            }
            const subscription = watchPath(join(directory, "state.json"), requestRefresh, { debounceMs: 180 });
            let queueSubscription: WatcherSubscription | undefined;
            const inboxSubscriptions: WatcherSubscription[] = [];
            const sessionSubscriptions: WatcherSubscription[] = [];
            let inboxDegraded = false;
            let sessionsDegraded = false;
            let safetyTicks = 0;
            let cancelSafety: (() => void) | undefined;
            const scheduleSafety = () => {
                if (signal.aborted) {
                    return;
                }
                const timer = setTimeout(
                    () => {
                        safetyTicks++;
                        roster?.refresh();
                        if (sessionsDegraded || safetyTicks % FULL_REFRESH_TICKS === 0) {
                            roster?.request(["all"]);
                        }
                        void requestRefresh();
                        scheduleSafety();
                    },
                    inboxDegraded ? DEGRADED_SAFETY_MS : SAFETY_MS
                );
                cancelSafety = () => clearTimeout(timer);
            };
            try {
                const queueDirectory = sessionMessageQueueRoot();
                await mkdir(queueDirectory, { recursive: true, mode: 0o700 });
                queueSubscription = await createWatcher(queueDirectory, requestRefresh, {
                    debounceMs: 180,
                    filter: (event) => event.path.endsWith(".json"),
                });
                const configured = dependencies.inboxPaths ?? {
                    answerLog: logDir(),
                    database: toolDataDir("question", "qa.db"),
                    decisions: decisionFiles().file,
                };
                const paths = {
                    answerLog: resolve(configured.answerLog),
                    database: resolve(configured.database),
                    decisions: resolve(configured.decisions),
                };
                const directories = [...new Set([paths.answerLog, dirname(paths.database), dirname(paths.decisions)])];
                const roots = directories.filter(
                    (directory) =>
                        !directories.some(
                            (parent) =>
                                directory !== parent &&
                                directory.startsWith(parent.endsWith(sep) ? parent : parent + sep)
                        )
                );
                const watchInbox = dependencies.watchInbox ?? createWatcher;
                for (const sourceDirectory of roots) {
                    if (signal.aborted) {
                        break;
                    }
                    try {
                        await mkdir(sourceDirectory, { recursive: true });
                        inboxSubscriptions.push(
                            await watchInbox(sourceDirectory, requestRefresh, {
                                debounceMs: 100,
                                filter: (event) =>
                                    event.path === paths.database ||
                                    event.path === `${paths.database}-wal` ||
                                    event.path === paths.decisions ||
                                    (dirname(event.path) === paths.answerLog && event.path.endsWith(".jsonl")),
                            })
                        );
                        logger.debug({ directory: sourceDirectory, paths }, "Watching Widget inbox sources");
                    } catch (error) {
                        inboxDegraded = true;
                        logger.warn(
                            { error, directory: sourceDirectory },
                            "Widget inbox source events unavailable; using safety refresh"
                        );
                    }
                }
                if (roster) {
                    sessionsDegraded = !(await watchSessionRoots({
                        roster,
                        roots: dependencies.sessionRoots ?? widgetSessionRoots(),
                        watch: dependencies.watchSessions ?? createWatcher,
                        subscriptions: sessionSubscriptions,
                        signal,
                    }));
                }
                prof.record("start watchers armed", performance.now());
                scheduleSafety();
                // The full refresh catches up behind the first read, in the same resident worker.
                roster?.request(["all"], { immediate: true });
                await requestRefresh();
                await new Promise<void>((resolve) => {
                    if (signal.aborted) {
                        resolve();
                    } else {
                        signal.addEventListener("abort", () => resolve(), { once: true });
                    }
                });
            } finally {
                cancelSafety?.();
                roster?.stop();
                await subscription.unsubscribe();
                await queueSubscription?.unsubscribe();
                for (const subscription of [...inboxSubscriptions, ...sessionSubscriptions]) {
                    try {
                        await subscription.unsubscribe();
                    } catch (error) {
                        logger.warn({ error }, "Widget watcher cleanup failed");
                    }
                }
                await refreshing;
                for (const job of jobs.values()) {
                    job.controller.abort();
                }
                await Promise.allSettled([...jobs.values()].map((job) => job.done));
                await dispatchTask;
            }
        },
        1500
    );
}

/**
 * Watches every provider's session roots and turns each burst of transcript changes into one roster request with
 * the index scopes it can affect. Returns false when a root could not be watched; the safety refresh then
 * refreshes the whole catalog on every tick instead.
 */
async function watchSessionRoots({
    roster,
    roots,
    watch,
    subscriptions,
    signal,
}: {
    roster: WidgetRosterReader;
    roots: Record<WidgetRosterProvider, string[]>;
    watch: typeof createWatcher;
    subscriptions: WatcherSubscription[];
    signal: AbortSignal;
}): Promise<boolean> {
    const onEvents = (events: { path: string }[]) => {
        const scopes = new Set<WidgetRosterScope>();
        let read = false;
        let listed: Set<string> | undefined;
        const listedParent = (sessionId: string) => {
            listed ??= new Set(roster.agents.parents.map((parent) => parent.sessionId));
            return listed.has(sessionId);
        };
        for (const event of events) {
            const change = widgetRosterChange({ path: event.path, roots, listedParent });
            if (change === "read") {
                read = true;
            } else if (change) {
                scopes.add(change);
            }
        }
        if (read || scopes.size > 0) {
            roster.request(scopes, { read });
        }
    };
    const all = [...new Set([...roots.claude, ...roots.codex, ...roots.grok])];
    let complete = true;
    for (const root of all) {
        if (signal.aborted) {
            break;
        }
        if (!existsSync(root)) {
            // A home that does not exist yet (another account) is found by the periodic full refresh.
            logger.debug({ root }, "Widget session root absent; not watched");
            continue;
        }
        try {
            // No debounce here: the roster request coalesces a burst itself, and a trailing debounce would never fire
            // while a busy transcript keeps writing.
            subscriptions.push(
                await watch(root, onEvents, {
                    debounceMs: 0,
                    ignorePatterns: [],
                    filter: (event) =>
                        widgetRosterChange({ path: event.path, roots, listedParent: () => true }) !== undefined,
                })
            );
        } catch (error) {
            complete = false;
            logger.warn({ error, root }, "Widget session root events unavailable; the safety refresh covers it");
        }
    }
    logger.debug({ roots: all.length, complete }, "Watching Widget session roots");
    return complete;
}
