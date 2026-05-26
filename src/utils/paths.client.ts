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
