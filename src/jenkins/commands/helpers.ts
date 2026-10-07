import { parseJenkinsInput } from "../lib/mcp/url";

/** A job path or URL plus an optional build argument; the argument wins over a number in the URL. */
export function resolveJobAndBuild(
    jobOrUrl: string,
    buildArg: string | undefined,
    defaultBuild = "lastBuild"
): { jobPath: string; buildNumber: string } {
    const ref = parseJenkinsInput(jobOrUrl);

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
