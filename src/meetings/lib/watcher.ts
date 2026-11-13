import { join } from "node:path";
import { spawnToolDetached } from "@genesiscz/utils/cli";
import { logger } from "@genesiscz/utils/logger";
import { MeetingsConfigStore } from "@genesiscz/utils/meetings/config";
import { MeetingStore } from "@genesiscz/utils/meetings/record";
import { inspectPidFile } from "@genesiscz/utils/process/pidfile";
import { hasOpenAssignSteps } from "./assign";
import { hasRecordingToWatch, hasSourceAudioToWatch, watchedSourceId } from "./watch";

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
 * Starts the watcher unless it runs already or no capture, missing linked audio or project step needs it.
 * The daemon calls it at login.
 */
export async function ensureWatcher(): Promise<"started" | "running" | "disabled"> {
    const config = await new MeetingsConfigStore().read();

    const store = new MeetingStore();
    if (
        !Object.values(config.sources).some((source) => source.preserveAudio) &&
        !config.sources[watchedSourceId(config)].autoRecord.enabled &&
        !hasOpenAssignSteps(store) &&
        !hasRecordingToWatch(store) &&
        !hasSourceAudioToWatch(store)
    ) {
        return "disabled";
    }

    if (inspectPidFile(watcherPidPath(new MeetingStore())).status === "live") {
        return "running";
    }

    const pid = spawnToolDetached(["meetings", "watch"]);
    // "started" means the child owns the pidfile, so a second ensureWatcher in this window does not spawn another.
    const deadline = Date.now() + WATCHER_CLAIM_MS;

    while (inspectPidFile(watcherPidPath(new MeetingStore())).status !== "live") {
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
