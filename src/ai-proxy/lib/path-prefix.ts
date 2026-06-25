export function normalizeBasePath(basePath?: string): string {
    if (!basePath) {
        return "";
    }

    const trimmed = basePath.trim();
    if (!trimmed || trimmed === "/") {
        return "";
    }

    const withSlash = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
    return withSlash.replace(/\/+$/, "");
}

export function stripBasePath(pathname: string, basePath?: string): string {
    const prefix = normalizeBasePath(basePath);

    if (!prefix) {
        return pathname;
    }

    if (pathname === prefix) {
        return "/";
    }

    if (pathname.startsWith(`${prefix}/`)) {
        const stripped = pathname.slice(prefix.length);
        return stripped || "/";
    }

    return pathname;
}
