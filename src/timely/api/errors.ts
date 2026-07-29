/**
 * Which Timely surface produced the failure. They fail for different reasons:
 * `api` is api.timelyapp.com/1.1 (OAuth bearer), `memories` is
 * app.timelyapp.com's suggested_entries/entries JSON (browser session only),
 * `token` is the OAuth token endpoint itself.
 */
export type TimelyRequestScope = "api" | "memories" | "token";

/**
 * An HTTP failure from Timely that keeps its status code, so callers can tell a
 * rejected session (401/403) apart from a transient server error and report
 * something the user can act on.
 */
export class TimelyHttpError extends Error {
    readonly status: number;
    readonly scope: TimelyRequestScope;
    /** Whether a stored browser cookie was sent, which decides the remedy for a memories 401. */
    readonly usedCookie: boolean;

    constructor(message: string, options: { status: number; scope: TimelyRequestScope; usedCookie?: boolean }) {
        super(message);
        this.name = "TimelyHttpError";
        this.status = options.status;
        this.scope = options.scope;
        this.usedCookie = options.usedCookie ?? false;
    }
}

/** True when the status means Timely refused the credentials, not the request. */
export function isAuthStatus(status: number): boolean {
    return status === 401 || status === 403;
}

/**
 * app.timelyapp.com is a web host, not the 1.1 API: it answers an unauthenticated
 * request by bouncing to its sign-in page rather than with a 401. So a redirect
 * here is a refused session, not a moved resource, and it has to be classified as
 * one — otherwise a stale cookie reads as "this day has no memories".
 */
export function isSessionRedirect(status: number): boolean {
    return status >= 300 && status < 400;
}

/** Every status that means "your credentials were refused", on either Timely host. */
export function isCredentialRejection(status: number): boolean {
    return isAuthStatus(status) || isSessionRedirect(status);
}

/** True when Timely refused the credentials rather than the request itself. */
export function isTimelyAuthFailure(err: unknown): err is TimelyHttpError {
    return err instanceof TimelyHttpError && isCredentialRejection(err.status);
}
