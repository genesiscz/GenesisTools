import { refOnInstance } from "../lib/rest/client";

/**
 * A job path or URL plus an optional build argument; the argument wins over a number in the URL. A URL
 * must be on the Jenkins at `baseUrl`, and its context path is dropped (see `refOnInstance`).
 */
export function resolveJobAndBuild({
    jobOrUrl,
    buildArg,
    baseUrl,
    defaultBuild = "lastBuild",
}: {
    jobOrUrl: string;
    buildArg: string | undefined;
    baseUrl: string;
    defaultBuild?: string;
}): { jobPath: string; buildNumber: string } {
    const ref = refOnInstance(baseUrl, jobOrUrl);

    return { jobPath: ref.jobPath, buildNumber: buildArg || ref.buildNumber || defaultBuild };
}

/** A whole number of 1 or more, written in full: `2oops`, `1.5`, `0` and `-1` are null. */
export function positiveInt(arg: string): number | null {
    const value = /^\d+$/.test(arg.trim()) ? Number(arg.trim()) : Number.NaN;

    return Number.isSafeInteger(value) && value >= 1 ? value : null;
}

/**
 * Two whole build numbers, `from <= to`. `stop-range` POSTs a stop for every build in between, so
 * `12oops` or `12.9` is refused instead of read as 12, and an inverted range is an error, not a no-op.
 */
export function parseBuildRange(fromArg: string, toArg: string, cmd: string): { from: number; to: number } {
    const from = positiveInt(fromArg);
    const to = positiveInt(toArg);

    if (from === null || to === null) {
        throw new Error(
            `${cmd} needs two positive whole build numbers, got "${fromArg}" "${toArg}": ${cmd} <job-or-url> <from> <to>`
        );
    }

    if (from > to) {
        throw new Error(`${cmd}: <from> (${from}) is after <to> (${to})`);
    }

    return { from, to };
}
