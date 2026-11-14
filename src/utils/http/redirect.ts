/** The redirect statuses a caller that follows redirects itself acts on (with the Location header). */
export const REDIRECT_STATUSES: ReadonlySet<number> = new Set([301, 302, 303, 307, 308]);
