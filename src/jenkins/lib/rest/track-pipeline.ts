import { logger, out } from "@genesiscz/utils/logger";
import pc from "picocolors";
import { JenkinsCertificateError } from "../mcp/client";
import { MonitorNotifier } from "../mcp/notify";
import type { JenkinsBackend } from "./client";
import { getDownstreamJobs, getJobNameFromPath, isMasterBuild, type JobContext } from "./jobs";
import type { BuildResult, JenkinsBuild, PipelineResult } from "./types";

const BUILD_TREE =
    "number,result,building,duration,timestamp,estimatedDuration,actions[causes[upstreamProject,upstreamBuild]]";
const DISCOVERY_DELAYS = [5000, 10000, 20000];
const MAX_DISCOVERY_ATTEMPTS = 10;
const POLL_DELAYS = [5000, 10000, 20000, 40000, 60000];
const MAX_MONITOR_MS = 30 * 60 * 1000;
const TIMESTAMP_WINDOW_MS = 5 * 60 * 1000;

export interface TrackDeps extends JobContext {
    sleep?: (ms: number) => Promise<void>;
    notify?: (message: string) => Promise<void>;
}

export async function fetchBuildInfo(
    backend: JenkinsBackend,
    jobPath: string,
    build: number | "latest" | "lastBuild"
): Promise<JenkinsBuild | null> {
    const ref = build === "latest" ? "lastBuild" : build;

    try {
        return await backend.apiOrNull<JenkinsBuild>(`${jobPath}/${ref}/api/json?tree=${BUILD_TREE}`);
    } catch (error) {
        // A failed certificate check fails every later request too: stop instead of polling for 30 minutes.
        if (error instanceof JenkinsCertificateError) {
            throw error;
        }

        out.error(pc.yellow(`# Warning: could not fetch build info for ${jobPath} #${ref}: ${error}`));
        return null;
    }
}

function decodedSegment(segment: string): string {
    try {
        return decodeURIComponent(segment);
    } catch (error) {
        logger.debug({ error, segment }, "jenkins track: job segment is not valid percent-encoding");
        return segment;
    }
}

/**
 * `job/Acme/job/web` as Jenkins names it in an upstream cause: `Acme/web`. A path taken from a URL
 * keeps its percent-encoding (`Acme%20Team`), while the cause carries the plain name, so each
 * segment is decoded.
 */
export function jobFullName(jobPath: string): string {
    const segments = jobPath.split("/").filter(Boolean);
    const names: string[] = [];

    for (let i = 0; i < segments.length; i++) {
        if (segments[i] === "job" && segments[i + 1] !== undefined) {
            names.push(decodedSegment(segments[i + 1] as string));
            i++;
        }
    }

    return names.join("/");
}

/** True when Jenkins records `masterBuild` of `masterJobPath` as what started `build`. */
export function startedBy(build: JenkinsBuild, masterJobPath: string, masterBuild: JenkinsBuild): boolean {
    const master = jobFullName(masterJobPath);

    return (build.actions ?? []).some((action) =>
        (action?.causes ?? []).some(
            (cause) => cause.upstreamProject === master && cause.upstreamBuild === masterBuild.number
        )
    );
}

export async function notifyDone(message: string): Promise<void> {
    try {
        await new MonitorNotifier().send({ title: "Jenkins", body: message, group: `jenkins-track-${message}` });
    } catch (error) {
        logger.debug({ error }, "jenkins track: notification failed");
    }

    out.println(pc.cyan(`# Notification: ${message}`));
}

/** Lines such as `Triggering <job> #<n>` in the master's log name downstream builds directly. */
export function findTriggeredBuilds(
    log: string,
    downstreamJobPaths: string[]
): Array<{ jobPath: string; buildNumber: number }> {
    const triggers: Array<{ jobPath: string; buildNumber: number }> = [];

    for (const line of log.split("\n")) {
        const match = line.match(/(?:Triggering|triggered|starting)\s+([^\s#]+)(?:\s*#(\d+))?/i);

        if (!match?.[1] || !match[2]) {
            continue;
        }

        const triggeredJob = match[1];
        const jobPath = downstreamJobPaths.find(
            (p) => getJobNameFromPath(p) === triggeredJob || p.includes(triggeredJob)
        );

        if (jobPath) {
            triggers.push({ jobPath, buildNumber: Number.parseInt(match[2], 10) });
        }
    }

    return triggers;
}

/**
 * The downstream build that started within five minutes of the master AND names it as its upstream
 * cause, among the job's last six builds. A build that only ran nearby is left out: it would pass
 * the pipeline on a downstream build the master never triggered.
 */
async function discoverByTimestamp(
    backend: JenkinsBackend,
    masterBuild: JenkinsBuild,
    masterJobPath: string,
    downstreamJobPath: string
): Promise<JenkinsBuild | null> {
    const latest = await fetchBuildInfo(backend, downstreamJobPath, "lastBuild");

    if (!latest) {
        return null;
    }

    const matches = (build: JenkinsBuild): boolean =>
        Math.abs(build.timestamp - masterBuild.timestamp) < TIMESTAMP_WINDOW_MS &&
        startedBy(build, masterJobPath, masterBuild);

    if (matches(latest)) {
        return latest;
    }

    for (let offset = 1; offset <= 5 && latest.number - offset >= 1; offset++) {
        const previous = await fetchBuildInfo(backend, downstreamJobPath, latest.number - offset);

        if (previous && matches(previous)) {
            return previous;
        }
    }

    return null;
}

async function waitForDownstreamBuilds(
    backend: JenkinsBackend,
    masterBuild: JenkinsBuild,
    jobPath: string,
    deps: TrackDeps
): Promise<Map<string, JenkinsBuild>> {
    const downstreamJobPaths = getDownstreamJobs(jobPath, deps);
    const discovered = new Map<string, JenkinsBuild>();
    const sleep = deps.sleep ?? Bun.sleep;

    if (downstreamJobPaths.length === 0) {
        return discovered;
    }

    out.println(pc.blue(`# Waiting for downstream builds: ${downstreamJobPaths.map(getJobNameFromPath).join(", ")}`));

    for (let attempt = 0; attempt < MAX_DISCOVERY_ATTEMPTS; attempt++) {
        const log = (await backend.apiTextOrNull(`${jobPath}/${masterBuild.number}/consoleText`)) ?? "";

        for (const trigger of findTriggeredBuilds(log, downstreamJobPaths)) {
            if (discovered.has(trigger.jobPath)) {
                continue;
            }

            const build = await fetchBuildInfo(backend, trigger.jobPath, trigger.buildNumber);

            if (build) {
                discovered.set(trigger.jobPath, build);
                out.println(pc.green(`# Found downstream: ${getJobNameFromPath(trigger.jobPath)} #${build.number}`));
            }
        }

        for (const downstreamPath of downstreamJobPaths) {
            if (discovered.has(downstreamPath)) {
                continue;
            }

            const build = await discoverByTimestamp(backend, masterBuild, jobPath, downstreamPath);

            if (build) {
                discovered.set(downstreamPath, build);
                out.println(
                    pc.green(`# Found downstream (timestamp): ${getJobNameFromPath(downstreamPath)} #${build.number}`)
                );
            }
        }

        if (discovered.size === downstreamJobPaths.length) {
            break;
        }

        const delay = DISCOVERY_DELAYS[Math.min(attempt, DISCOVERY_DELAYS.length - 1)];
        out.println(pc.gray(`# Waiting for downstream builds... (attempt ${attempt + 1}/${MAX_DISCOVERY_ATTEMPTS})`));
        await sleep(delay);
    }

    return discovered;
}

function toResult(build: JenkinsBuild): BuildResult {
    return {
        status: build.result ?? "NOT_BUILT",
        duration: build.duration ?? 0,
        building: build.building,
        number: build.number,
    };
}

/** Polls with backoff (5s up to 60s) until the build ends or 30 minutes pass. */
export async function monitorBuildToCompletion(
    backend: JenkinsBackend,
    jobPath: string,
    build: JenkinsBuild,
    deps: TrackDeps = {}
): Promise<BuildResult> {
    const sleep = deps.sleep ?? Bun.sleep;
    const startedAt = Date.now();
    let current = build;
    let attempt = 0;

    while (current.building && Date.now() - startedAt < MAX_MONITOR_MS) {
        await sleep(POLL_DELAYS[Math.min(attempt, POLL_DELAYS.length - 1)]);
        attempt++;

        const updated = await fetchBuildInfo(backend, jobPath, current.number);

        if (updated) {
            current = updated;
        }
    }

    return toResult(current);
}

/** Follows a build and, for a master job, the downstream builds it triggers; notifies once at the end. */
export async function trackPipeline(
    backend: JenkinsBackend,
    jobPath: string,
    buildNumber: number | "latest",
    deps: TrackDeps = {}
): Promise<PipelineResult> {
    const jobName = getJobNameFromPath(jobPath);

    if (!isMasterBuild(jobPath, deps)) {
        out.println(pc.yellow(`# Warning: ${jobName} is not a master build, tracking as single build`));
    }

    out.println(pc.blue(`# Tracking pipeline: ${jobName} #${buildNumber}`));

    const masterBuild = await fetchBuildInfo(backend, jobPath, buildNumber);

    if (!masterBuild) {
        throw new Error(`Could not fetch master build: ${jobPath} #${buildNumber}`);
    }

    out.println(pc.gray(`# Master build number: ${masterBuild.number}`));

    let masterResult: BuildResult;

    if (masterBuild.building) {
        out.println(pc.blue("# Master build still in progress, monitoring..."));
        masterResult = await monitorBuildToCompletion(backend, jobPath, masterBuild, deps);
        out.println(pc.green(`# Master build complete: ${masterResult.status}`));
    } else {
        masterResult = toResult(masterBuild);
        out.println(pc.gray(`# Master build already complete: ${masterResult.status}`));
    }

    const downstreamBuilds = await waitForDownstreamBuilds(backend, masterBuild, jobPath, deps);
    const downstream: PipelineResult["downstream"] = [];

    if (downstreamBuilds.size > 0) {
        out.println(pc.blue(`# Monitoring ${downstreamBuilds.size} downstream build(s) in parallel...`));

        const results = await Promise.all(
            [...downstreamBuilds].map(async ([path, build]) => ({
                jobName: getJobNameFromPath(path),
                buildNumber: build.number,
                result: await monitorBuildToCompletion(backend, path, build, deps),
            }))
        );
        downstream.push(...results);

        for (const ds of downstream) {
            const color = ds.result.status === "SUCCESS" ? pc.green : pc.red;
            out.println(color(`# ${ds.jobName} #${ds.buildNumber}: ${ds.result.status}`));
        }
    }

    // A downstream build that was never found is not a pass: `every` over the builds that were found
    // says true for none at all.
    const missing = getDownstreamJobs(jobPath, deps)
        .filter((path) => !downstreamBuilds.has(path))
        .map(getJobNameFromPath);

    for (const name of missing) {
        out.println(pc.red(`# ${name}: no build found`));
    }

    const allPassed =
        masterResult.status === "SUCCESS" &&
        missing.length === 0 &&
        downstream.every((ds) => ds.result.status === "SUCCESS");
    const parts = [
        ...downstream.map((ds) => `${ds.jobName} ${ds.result.status}`),
        ...missing.map((name) => `${name} NOT FOUND`),
    ];
    const summary =
        parts.length > 0
            ? `${jobName} #${masterBuild.number} pipeline complete - ${parts.join(", ")}`
            : `${jobName} #${masterBuild.number} ${masterResult.status}`;

    out.println(pc.bold(allPassed ? pc.green("# Pipeline SUCCESS") : pc.red("# Pipeline FAILED")));
    await (deps.notify ?? notifyDone)(summary);

    return { master: masterResult, downstream, missing, allPassed };
}
