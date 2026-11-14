/** The redirect statuses a caller that follows redirects itself acts on. */
const REDIRECT_STATUSES: ReadonlySet<number> = new Set([301, 302, 303, 307, 308]);

/**
 * The head of the response a transfer is reading, fed one header line at a time as curl delivers them. A new status
 * line starts a new response (a redirect hop curl follows, a proxy CONNECT, a `100 Continue`), so only the last head is
 * kept.
 */
export class ResponseHead {
    status = 0;
    headers: Record<string, string> = {};
    /**
     * The head ended on a redirect with a Location that the caller follows itself. Its body is then never read: the
     * caller needs only the status and the Location, and a large or slowly streamed redirect body would otherwise pass
     * the byte limit or use up the timeout.
     */
    redirect = false;

    constructor(private readonly callerFollowsRedirects: boolean) {}

    /** Returns true when this line ends a redirect head the caller follows: nothing after it is needed. */
    line(raw: string): boolean {
        const line = raw.trimEnd();
        if (line.startsWith("HTTP/")) {
            const code = Number(line.split(" ")[1]);
            this.status = Number.isInteger(code) ? code : 0;
            this.headers = {};
            this.redirect = false;
            return false;
        }

        if (line === "") {
            this.redirect =
                this.callerFollowsRedirects &&
                REDIRECT_STATUSES.has(this.status) &&
                this.headers.location !== undefined;
            return this.redirect;
        }

        const colon = line.indexOf(":");
        if (colon > 0) {
            // A repeated header (set-cookie) is joined with ", ", as curl_cffi's Headers.items() did.
            const name = line.slice(0, colon).trim().toLowerCase();
            const value = line.slice(colon + 1).trim();
            const earlier = this.headers[name];
            this.headers[name] = earlier === undefined ? value : `${earlier}, ${value}`;
        }

        return false;
    }
}
