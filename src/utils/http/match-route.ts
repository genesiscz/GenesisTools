/**
 * Tiny pattern matcher for HTTP routes inside `Bun.serve` handlers.
 *
 *   const params = matchRoute(req, "GET", "/api/v1/watchers/:id", url.pathname);
 *   if (params) { const id = parseInt(params.id, 10); ... }
 *
 * The method must equal `req.method`, the segment count must match exactly,
 * `:name` segments capture into the returned map and literal segments must
 * match verbatim. Returns `null` on no match so callers fall through.
 */
export function matchRoute(
    req: Request,
    method: string,
    pattern: string,
    pathname: string
): Record<string, string> | null {
    if (req.method !== method) {
        return null;
    }

    const patternParts = pattern.split("/").filter(Boolean);
    const pathParts = pathname.split("/").filter(Boolean);

    if (patternParts.length !== pathParts.length) {
        return null;
    }

    const params: Record<string, string> = {};

    for (let i = 0; i < patternParts.length; i++) {
        const patternPart = patternParts[i];
        const pathPart = pathParts[i];

        if (patternPart.startsWith(":")) {
            try {
                params[patternPart.slice(1)] = decodeURIComponent(pathPart);
            } catch {
                // A malformed escape (%E0%A4%A) is not a match, not a crash.
                return null;
            }

            continue;
        }

        if (patternPart !== pathPart) {
            return null;
        }
    }

    return params;
}
