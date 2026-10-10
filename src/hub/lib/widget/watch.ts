import { mkdir } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { decisionFiles } from "@app/question/lib/decisions/read";
import { logDir } from "@app/question/lib/log-store";
import { sessionMessageQueueRoot } from "@genesiscz/utils/agent-sessions/message-queue";
import { createWatcher, type WatcherSubscription, watchPath } from "@genesiscz/utils/fs/watcher";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { nativeInboxState } from "@genesiscz/utils/macos/native-inbox";
import { boundedCommand } from "@genesiscz/utils/process/bounded-command";
import { profiler } from "@genesiscz/utils/profile";
import { withFileLock } from "@genesiscz/utils/storage/file-lock";
import { toolDataDir } from "@genesiscz/utils/storage/root";
import { prepareWidgetAsset } from "../composer/assets";
import { widgetDispatcher } from "../composer/dispatch";
import { type OutboxDispatcher, processWidgetOutbox } from "../composer/engine";
import { recoverWidgetOutbox } from "../composer/outbox";
import { WidgetRosterReader } from "./roster-reader";
import { invalidateWidgetAgents, realWidgetSources, widgetSnapshot } from "./snapshot";
import { readWidgetState, widgetRoot } from "./storage";

const prof = profiler.scope("widget");

async function discoverWidgetSessions(signal: AbortSignal): Promise<void> {
    const result = await boundedCommand({
        command: [process.execPath, resolve(import.meta.dir, "../../index.ts"), "widget", "discover"],
        cwd: resolve(import.meta.dir, "../../../.."),
        timeoutMs: 120_000,
        maxBufferBytes: 256 * 1024,
        signal,
    });
    if (result.status !== 0) {
        throw new Error(
            `Widget session discovery failed: ${result.error?.message ?? (result.stderr.slice(-1000) || result.status)}`
        );
    }
}

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
        discover?: (signal: AbortSignal) => Promise<void>;
        snapshot?: typeof widgetSnapshot;
        dispatcher?: OutboxDispatcher;
        inboxPaths?: { answerLog: string; database: string; decisions: string };
        watchInbox?: typeof createWatcher;
    };
}): Promise<void> {
    const directory = widgetRoot(root);
    await mkdir(directory, { recursive: true });
    await withFileLock(
        join(directory, "worker.lock"),
        async () => {
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
            const discover = dependencies.discover ?? discoverWidgetSessions;
            let discoveryTask: Promise<void> | undefined;
            let dispatchTask: Promise<void> | undefined;
            let last = "";
            let lastDiscovery = 0;
            const startedAt = Date.now();
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
            const requestDiscovery = () => {
                if (signal.aborted || discoveryTask || Date.now() - lastDiscovery < 15_000) {
                    return;
                }
                lastDiscovery = Date.now();
                discoveryTask = prof
                    .measureAsync("watch discovery", () => discover(signal))
                    .then(() => {
                        if (!signal.aborted) {
                            invalidateWidgetAgents();
                            roster?.refresh(true);
                            return requestRefresh();
                        }
                    })
                    .catch((error) => {
                        if (!signal.aborted) {
                            logger.warn(
                                { error },
                                "Widget session discovery failed; indexed sessions remain available"
                            );
                        }
                    })
                    .finally(() => {
                        discoveryTask = undefined;
                    });
            };
            if (!dependencies.snapshot) {
                roster = new WidgetRosterReader({
                    changed: () => {
                        void requestRefresh();
                    },
                });
            }
            const subscription = watchPath(join(directory, "state.json"), requestRefresh, { debounceMs: 180 });
            let queueSubscription: WatcherSubscription | undefined;
            const inboxSubscriptions: WatcherSubscription[] = [];
            const safety = setInterval(() => {
                roster?.refresh();
                requestDiscovery();
                void requestRefresh();
            }, 5000);
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
                        logger.warn(
                            { error, directory: sourceDirectory },
                            "Widget inbox source events unavailable; using safety refresh"
                        );
                    }
                }
                roster?.refresh();
                requestDiscovery();
                await requestRefresh();
                await new Promise<void>((resolve) => {
                    if (signal.aborted) {
                        resolve();
                    } else {
                        signal.addEventListener("abort", () => resolve(), { once: true });
                    }
                });
            } finally {
                clearInterval(safety);
                roster?.stop();
                await subscription.unsubscribe();
                await queueSubscription?.unsubscribe();
                for (const subscription of inboxSubscriptions) {
                    try {
                        await subscription.unsubscribe();
                    } catch (error) {
                        logger.warn({ error }, "Widget inbox watcher cleanup failed");
                    }
                }
                await refreshing;
                for (const job of jobs.values()) {
                    job.controller.abort();
                }
                await Promise.allSettled([...jobs.values()].map((job) => job.done));
                await dispatchTask;
                await discoveryTask;
            }
        },
        1500
    );
}
