const JENKINS_PAGE_SEGMENT = /\/(?:user|me|job|view|login|manage|computer|blue)(?:\/.*)?$/i;

/**
 * The Jenkins root from whatever URL was pasted. A page of the same Jenkins (`/user/x/`,
 * `/me/security/`, `/job/...`, `/login?from=...`) logs in to the same server, so the page path,
 * the query and the fragment are dropped. A Jenkins served under a path prefix keeps the prefix.
 */
export function normalizeBaseUrl(raw: string): string {
    const trimmed = raw.trim();
    const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;

    try {
        const url = new URL(withScheme);

        return `${url.origin}${url.pathname.replace(JENKINS_PAGE_SEGMENT, "")}`.replace(/\/+$/, "");
    } catch {
        return withScheme.replace(/[?#].*$/, "").replace(/\/+$/, "");
    }
}
