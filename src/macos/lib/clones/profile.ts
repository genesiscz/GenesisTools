import { type ProfilerScope, profiler } from "@genesiscz/utils/profile";

/** One scope for every clones phase. `PROFILE=clones` turns it on; the daily
 *  file is `~/.genesis-tools/logs/<date>-profiling.log`. */
export const clonesProfile: ProfilerScope = profiler.scope("clones");

/** Per-item timings (one directory, one spawned command) are recorded only at
 *  `detail=all`; phase timings are always recorded. Keeps a 300-directory
 *  discovery from writing 300 lines at the default detail. */
export function measureItem<T>(label: string, fn: () => T): T {
    if (profiler.detail !== "all") {
        return fn();
    }

    return clonesProfile.measure(label, fn);
}

export async function measureItemAsync<T>(label: string, fn: () => Promise<T>): Promise<T> {
    if (profiler.detail !== "all") {
        return fn();
    }

    return clonesProfile.measureAsync(label, fn);
}
