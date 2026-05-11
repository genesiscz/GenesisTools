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

    // Strip view/<name>/ filter that change-request multibranch URLs include
    const filtered: string[] = [];

    for (let i = 0; i < segments.length; i++) {
        if (segments[i] === "view" && segments[i + 1]) {
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
