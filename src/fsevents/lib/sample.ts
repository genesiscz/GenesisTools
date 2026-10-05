import { realpathSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { abortableSleep } from "@genesiscz/utils/async";
import { logger } from "@genesiscz/utils/logger";
import { Stopwatch } from "@genesiscz/utils/Stopwatch";
import { type ChurnProfile, DirectoryCounter } from "./churn";

export interface SampleEvent {
    path: string;
    event: string;
    type: string;
}

export interface SampleOptions {
    root: string;
    durationMs: number;
    /** How many of the busiest directories the result keeps. */
    top: number;
    /** Aborting ends the sample early. The events counted so far are still returned. */
    signal?: AbortSignal;
    onEvent?: (event: SampleEvent) => void;
}

export interface SampleResult extends ChurnProfile {
    root: string;
    elapsedMs: number;
    interrupted: boolean;
}

/** The absolute, symlink-free directory to watch. fsevents reports real paths, so `/tmp` is `/private/tmp`. */
export function resolveSampleRoot(root: string): string {
    const absolute = resolve(root);
    let real: string;

    try {
        real = realpathSync(absolute);
    } catch (error) {
        logger.debug({ err: error, root: absolute }, "fsevents: the sample root could not be resolved");
        throw new Error(`Cannot watch ${absolute}: it does not exist or cannot be read.`);
    }

    if (!statSync(real).isDirectory()) {
        throw new Error(`Cannot watch ${real}: it is not a directory.`);
    }

    return real;
}

/**
 * Watch `root` with the native FSEvents API and count the events per directory until the deadline or the
 * abort signal, whichever comes first. The wait is one timer plus one abort listener, so the process sleeps
 * between events.
 */
export async function sampleDirectoryChurn(options: SampleOptions): Promise<SampleResult> {
    const root = resolveSampleRoot(options.root);
    const fsevents = await import("fsevents");
    const counter = new DirectoryCounter();
    const stopwatch = new Stopwatch();

    logger.debug({ root, durationMs: options.durationMs }, "fsevents: starting the watcher");
    const stopWatching = fsevents.watch(root, (eventPath, flags) => {
        const info = fsevents.getInfo(eventPath, flags);
        counter.add(info.path);
        options.onEvent?.({ path: info.path, event: info.event, type: info.type });
    });

    let interrupted = false;

    try {
        await abortableSleep(options.durationMs, options.signal);
    } catch (error) {
        if (!options.signal?.aborted) {
            throw error;
        }

        interrupted = true;
        logger.debug({ root }, "fsevents: the sample was interrupted");
    } finally {
        await stopWatching();
    }

    const elapsedMs = stopwatch.elapsedMs;
    logger.debug({ root, events: counter.total, elapsedMs, interrupted }, "fsevents: the sample finished");

    return { ...counter.snapshot(options.top), root, elapsedMs, interrupted };
}
