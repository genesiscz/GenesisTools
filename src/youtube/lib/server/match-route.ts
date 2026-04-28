/**
 * Tiny pattern-matching helper for HTTP routes inside `Bun.serve` handlers.
 *
 * Usage:
 *   const params = matchRoute(req, "GET", "/api/v1/jobs/:id/activity", url.pathname);
 *   if (params) { const id = parseInt(params.id, 10); ... }
 *
 * Matches:
 *   - method must equal req.method
 *   - segment count must match exactly
 *   - `:name` segments capture into the returned `params` map
 *   - literal segments must match verbatim
 *
 * Returns `null` when there's no match — callers fall through to the next route.
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
            params[patternPart.slice(1)] = decodeURIComponent(pathPart);
            continue;
        }

        if (patternPart !== pathPart) {
            return null;
        }
    }

    return params;
}
