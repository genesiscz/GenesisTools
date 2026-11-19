import { statSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { newestLoadedModuleMtime, onLoadedCodeChange } from "@genesiscz/utils/bun/loaded-modules";
import { spawnToolDetached } from "@genesiscz/utils/cli";
import { moduleDir } from "@genesiscz/utils/fs/module-dir";
import { logger } from "@genesiscz/utils/logger";
import { genesisAppLauncherPath } from "@genesiscz/utils/macos/genesis-app";
import { MeetingsConfigStore } from "@genesiscz/utils/meetings/config";
import { MeetingStore } from "@genesiscz/utils/meetings/record";
import { claimPidFile, clearPidFile, inspectPidFile } from "@genesiscz/utils/process/pidfile";
import { sandboxInstalled } from "@genesiscz/utils/storage/real-home-guard";
import { hasOpenAssignSteps } from "./assign";
import { showRecordingGrantCard } from "./recording-preflight";
import { hasPendingStartAlerts, lastStartFailure } from "./start-failures";
import { hasRecordingToWatch, hasSourceAudioToWatch, watchedSourceId, watchLoop } from "./watch";

/**
 * Starting the background watcher: one core that the watch command, the recorder, a config change that turns on
 * source audio preservation, and the daemon at login all call, so a library never imports a command for it.
 */

const { log } = logger.scoped("meetings-watcher");
/** How long `ensureWatcher` waits for the spawned watcher to own its pidfile. */
const WATCHER_CLAIM_MS = 15_000;

export function watcherPidPath(store: MeetingStore): string {
    return join(store.root, "watch.pid");
}

/**
 * Claims the watcher's pidfile: a dead or foreign owner is taken over, a live one is refused. An empty file follows the
 * shared claim's one rule (`EMPTY_HOLDER_GRACE_MS` in pidfile.ts), so one a SIGKILL left behind no longer blocks.
 */
export async function claimWatcher(store: MeetingStore): Promise<void> {
    const file = watcherPidPath(store);
    const claim = await claimPidFile(file, {
        reclaimable: (state) => state.status === "dead" || state.status === "foreign",
    });

    if (claim.status !== "claimed") {
        const owner = claim.status === "held" && "pid" in claim.state ? ` (pid ${claim.state.pid})` : "";
        throw new Error(`another meetings watcher holds ${file}${owner}`);
    }
}

function watcherCodeStamp(root: string): number {
    const app = statSync(genesisAppLauncherPath(), { throwIfNoEntry: false });
    return Math.max(newestLoadedModuleMtime(root), app?.mtimeMs ?? 0, app?.ctimeMs ?? 0);
}

/** Release the pidfile after the active tick finishes. The daemon can then start the updated watcher. */
export async function runWatcher(
    store: MeetingStore,
    options: {
        newest?: (root: string) => number;
        everyMs?: number;
        loop?: typeof watchLoop;
    } = {}
): Promise<void> {
    await claimWatcher(store);
    const owner = new AbortController();
    const stop = () => owner.abort();
    const stopWatching = onLoadedCodeChange({
        root: resolve(moduleDir(import.meta), "../..") + sep,
        startedAt: performance.timeOrigin,
        newest: options.newest ?? watcherCodeStamp,
        everyMs: options.everyMs,
        onChanged: () => {
            log.info("the watcher code or installed app changed; releasing the watcher for restart");
            stop();
        },
    });
    process.on("SIGTERM", stop);
    process.on("SIGINT", stop);
    try {
        await (options.loop ?? watchLoop)(store, owner.signal);
    } finally {
        stopWatching();
        process.off("SIGTERM", stop);
        process.off("SIGINT", stop);
        clearPidFile(watcherPidPath(store));
    }
}

/** Outside the default store, a manual recording starts a watcher only when sources.<id>.autoRecord.enabled is true. */
export async function shouldStartWatcherForRecording(): Promise<boolean> {
    if (!sandboxInstalled()) {
        return true;
    }

    const config = await new MeetingsConfigStore().read();
    return config.sources[watchedSourceId(config)].autoRecord.enabled;
}

/**
 * Starts the watcher unless it runs already or no capture, missing linked audio or project step needs it.
 * The daemon calls it at login.
 */
export function ensureWatcher(): Promise<"started" | "running" | "disabled"> {
    // Several startup triggers can call this at once: they share one attempt, so only one child is spawned.
    inFlight ??= startWatcher().finally(() => {
        inFlight = undefined;
    });

    return inFlight;
}

let inFlight: Promise<"started" | "running" | "disabled"> | undefined;

/** Status reads any store. The autostart commands manage the configured store the watcher process opens. */
export async function recordingAutostart(mode: "on" | "off" | "status" = "status", store = new MeetingStore()) {
    if (mode !== "status" && resolve(store.root) !== resolve(new MeetingStore().root)) {
        throw new Error("Recording autostart can only change the configured meetings store.");
    }

    const configStore = new MeetingsConfigStore(store.storage);
    if (mode !== "status") {
        await configStore.setAutoRecord(mode === "on");
    }
    const config = await configStore.read();
    const enabled = config.sources[watchedSourceId(config)].autoRecord.enabled;
    if (!enabled && mode === "off") {
        await showRecordingGrantCard();
    }
    if (enabled && mode === "on") {
        await ensureWatcher();
    }
    const running = inspectPidFile(watcherPidPath(store)).status === "live";
    return { enabled, running, lastFailure: lastStartFailure(store) };
}

async function startWatcher(): Promise<"started" | "running" | "disabled"> {
    const config = await new MeetingsConfigStore().read();

    const store = new MeetingStore();
    if (
        !Object.values(config.sources).some((source) => source.preserveAudio) &&
        !config.sources[watchedSourceId(config)].autoRecord.enabled &&
        !hasOpenAssignSteps(store) &&
        !hasRecordingToWatch(store) &&
        !hasSourceAudioToWatch(store) &&
        !hasPendingStartAlerts(store)
    ) {
        return "disabled";
    }

    const pidPath = watcherPidPath(store);

    if (inspectPidFile(pidPath).status === "live") {
        return "running";
    }

    const pid = spawnToolDetached(["meetings", "watch"]);
    // "started" means the child owns the pidfile. A second call in this window shares this attempt (`inFlight`).
    const deadline = Date.now() + WATCHER_CLAIM_MS;

    while (inspectPidFile(pidPath).status !== "live") {
        if (Date.now() >= deadline) {
            throw new Error(
                `The meetings watcher did not claim its pidfile within ${WATCHER_CLAIM_MS / 1000} seconds.`
            );
        }

        await Bun.sleep(Math.min(500, deadline - Date.now()));
    }

    log.info({ pid }, "meetings watcher started in the background");
    return "started";
}
