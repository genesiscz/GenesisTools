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

export function parseBuildRange(fromArg: string, toArg: string, cmd: string): { from: number; to: number } {
    const from = Number.parseInt(fromArg, 10);
    const to = Number.parseInt(toArg, 10);

    if (!Number.isFinite(from) || !Number.isFinite(to)) {
        throw new Error(`${cmd} needs a build range: ${cmd} <job-or-url> <from> <to>`);
    }

    return { from, to };
}
