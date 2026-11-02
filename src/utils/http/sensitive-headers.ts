/**
 * Which HTTP headers carry a credential, by name. One table for every redactor (`har-analyzer redact`, `chrome-devtools
 * har --sanitize`): each used to keep its own exact-name list, and neither had the custom `authToken` header a
 * timesheet app sends, so a sanitized HAR still showed the live token (2026-11-02).
 *
 * A name matches by its parts, case-insensitive and without separators, so `authToken`, `X-Auth-Token`,
 * `x_api_key` and `X-Goog-Api-Key` all match. Headers that only name auth without carrying it are left alone: the
 * HTTP/2 `:authority`, the `WWW-Authenticate` challenge and the CORS `Access-Control-*` lists.
 */
export type SensitiveHeaderKind = "token" | "secret" | "session" | "cookie";

export function normalizeHeaderName(name: string): string {
    return name.toLowerCase().replace(/[-_.:\s]/g, "");
}

export function sensitiveHeaderKind(name: string): SensitiveHeaderKind | null {
    const key = normalizeHeaderName(name);

    if (key === "cookie" || key === "setcookie") {
        return "cookie";
    }

    if (key === "authority" || key.startsWith("accesscontrol") || key.endsWith("authenticate")) {
        return null;
    }

    if (/secret|apikey|password|passwd/.test(key)) {
        return "secret";
    }

    if (key.includes("session")) {
        return "session";
    }

    if (/token|auth|credential|signature/.test(key)) {
        return "token";
    }

    return null;
}
