/** Browser-safe path display helpers — no Node built-ins. */

export function toPosixPath(p: string): string {
    return p.replace(/\\/g, "/");
}

export function collapsePathForDisplay(p: string): string {
    if (!p) {
        return p;
    }

    const normalized = toPosixPath(p.trim());

    if (normalized.startsWith("~/") || normalized === "~") {
        return normalized;
    }

    const mac = normalized.match(/^\/Users\/[^/]+(\/.*)?$/);
    if (mac) {
        return `~${mac[1] ?? ""}`;
    }

    const linux = normalized.match(/^\/home\/[^/]+(\/.*)?$/);
    if (linux) {
        return `~${linux[1] ?? ""}`;
    }

    return normalized;
}

function splitPathSegments(path: string): string[] {
    const normalized = collapsePathForDisplay(toPosixPath(path.trim()));

    if (!normalized) {
        return [];
    }

    if (normalized === "~") {
        return ["~"];
    }

    if (normalized.startsWith("~/")) {
        return ["~", ...normalized.slice(2).split("/").filter(Boolean)];
    }

    if (normalized.startsWith("/")) {
        return normalized.split("/").filter(Boolean);
    }

    return normalized.split("/").filter(Boolean);
}

function joinPathSegments(segments: string[]): string {
    if (segments.length === 0) {
        return "";
    }

    if (segments[0] === "~") {
        if (segments.length === 1) {
            return "~";
        }

        return `~/${segments.slice(1).join("/")}`;
    }

    return `/${segments.join("/")}`;
}

/** Longest shared directory prefix across paths (collapsed, no trailing slash). Empty when not shared. */
export function longestCommonPathPrefix(paths: readonly string[]): string {
    const normalized = [
        ...new Set(paths.map((path) => collapsePathForDisplay(toPosixPath(path.trim()))).filter(Boolean)),
    ];

    if (normalized.length < 2) {
        return "";
    }

    const segmentLists = normalized.map(splitPathSegments);
    const first = segmentLists[0];
    let sharedSegmentCount = 0;

    for (let index = 0; index < first.length; index++) {
        const segment = first[index];

        if (!segmentLists.every((parts) => parts[index] === segment)) {
            break;
        }

        sharedSegmentCount = index + 1;
    }

    if (sharedSegmentCount === 0) {
        return "";
    }

    if (sharedSegmentCount === 1 && first[0] === "~") {
        return "";
    }

    return joinPathSegments(first.slice(0, sharedSegmentCount));
}

export function shortenPathWithPrefix(path: string, prefix: string): string {
    const full = collapsePathForDisplay(toPosixPath(path.trim()));

    if (!full) {
        return full;
    }

    if (!prefix) {
        return full;
    }

    const shared = collapsePathForDisplay(toPosixPath(prefix.trim()));

    if (!shared) {
        return full;
    }

    if (full === shared) {
        return ".";
    }

    const sharedWithSlash = shared.endsWith("/") ? shared : `${shared}/`;

    if (full.startsWith(sharedWithSlash)) {
        const rest = full.slice(sharedWithSlash.length);

        return rest || ".";
    }

    return full;
}

export function formatPathForDisplay(path: string, commonPrefix?: string): { display: string; full: string } {
    const full = collapsePathForDisplay(toPosixPath(path.trim()));

    return {
        full,
        display: shortenPathWithPrefix(full, commonPrefix ?? ""),
    };
}
