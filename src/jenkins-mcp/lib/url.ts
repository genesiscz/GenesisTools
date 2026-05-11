export interface JenkinsRef {
    jobPath: string;
    buildNumber?: string;
    nodeId?: string;
}

const TRAILING_SEGMENTS = new Set([
    "pipeline-overview",
    "console",
    "consoleText",
    "consoleFull",
    "wfapi",
    "api",
    "changes",
    "testReport",
    "execution",
]);

export function parseJenkinsInput(input: string): JenkinsRef {
    const trimmed = input.trim();

    if (!trimmed.startsWith("http://") && !trimmed.startsWith("https://")) {
        return { jobPath: trimmed.replace(/^\/+/, "").replace(/\/+$/, "") };
    }

    const url = new URL(trimmed);
    let segments = url.pathname.split("/").filter(Boolean);

    // Strip view/<name>/ filter that change-request multibranch URLs include.
    // A "view" segment is only a filter marker when it sits BETWEEN a job and the next job —
    // i.e. previous segment is NOT "job" and segment[i+2] === "job". This keeps jobs
    // literally named "view" (/job/.../job/view/job/...) intact.
    const filtered: string[] = [];

    for (let i = 0; i < segments.length; i++) {
        const isViewFilter =
            segments[i] === "view" && !!segments[i + 1] && segments[i - 1] !== "job" && segments[i + 2] === "job";

        if (isViewFilter) {
            i++;
            continue;
        }

        filtered.push(segments[i]);
    }
    segments = filtered;

    // Trim trailing meta segments
    while (segments.length > 0 && TRAILING_SEGMENTS.has(segments[segments.length - 1])) {
        segments.pop();
    }

    // Extract trailing build number
    let buildNumber: string | undefined;
    const last = segments[segments.length - 1];

    if (last && /^\d+$/.test(last)) {
        buildNumber = last;
        segments.pop();
    }

    const jobPath = segments.join("/");
    const nodeId = url.searchParams.get("selected-node") ?? undefined;
    return { jobPath, buildNumber, nodeId };
}

export interface ResolveRefOpts {
    input: string;
    buildOverride?: string;
    nodeOverride?: string;
}

/** Parse `input` then apply optional explicit overrides (which win over URL-derived values). */
export function resolveRef(opts: ResolveRefOpts): JenkinsRef {
    const ref = parseJenkinsInput(opts.input);
    return {
        jobPath: ref.jobPath,
        buildNumber: opts.buildOverride ?? ref.buildNumber,
        nodeId: opts.nodeOverride ?? ref.nodeId,
    };
}

/** Inverse: produce a build URL given a Jenkins base URL and a ref. */
export function buildUrl(base: string, ref: JenkinsRef): string {
    const baseTrim = base.replace(/\/+$/, "");

    if (!ref.buildNumber) {
        return `${baseTrim}/${ref.jobPath}/`;
    }

    const url = `${baseTrim}/${ref.jobPath}/${ref.buildNumber}/`;

    if (ref.nodeId) {
        return `${url}pipeline-overview/?selected-node=${ref.nodeId}`;
    }

    return url;
}
