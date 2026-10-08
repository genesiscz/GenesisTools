import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { watchPath } from "@genesiscz/utils/fs/watcher";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { withFileLock } from "@genesiscz/utils/storage/file-lock";
import { prepareWidgetAsset } from "../composer/assets";
import { widgetDispatcher } from "../composer/dispatch";
import { type OutboxDispatcher, processWidgetOutbox } from "../composer/engine";
import { recoverWidgetOutbox } from "../composer/outbox";
import { widgetSnapshot } from "./snapshot";
import { readWidgetState, widgetRoot } from "./storage";

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
    };
}): Promise<void> {
    const directory = widgetRoot(root);
    await mkdir(directory, { recursive: true });
    await withFileLock(
        join(directory, "worker.lock"),
        async () => {
            await recoverWidgetOutbox(directory);
            const jobs = new Map<string, { revision: number; controller: AbortController; done: Promise<void> }>();
            const dispatcher = dependencies.dispatcher ?? widgetDispatcher({ signal });
            const prepare = dependencies.prepare ?? prepareWidgetAsset;
            const readSnapshot = dependencies.snapshot ?? widgetSnapshot;
            let dispatchTask: Promise<void> | undefined;
            let last = "";
            let lastDiscovery = 0;
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
                const discover = Date.now() - lastDiscovery > 15_000;
                if (discover) {
                    lastDiscovery = Date.now();
                }
                const snapshot = await readSnapshot({ root: directory, selectedKey, refresh: discover });
                const fingerprint = SafeJSON.stringify(snapshot);
                if (fingerprint !== last && !signal.aborted) {
                    last = fingerprint;
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
            const subscription = watchPath(join(directory, "state.json"), requestRefresh, { debounceMs: 180 });
            const safety = setInterval(() => {
                void requestRefresh();
            }, 5000);
            try {
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
                await subscription.unsubscribe();
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
