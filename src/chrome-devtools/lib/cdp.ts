/**
 * Scriptable CDP client. Same capabilities as chrome-devtools-mcp tools, but
 * callable from any bun script (no MCP session, no config reload).
 * Ported from ~/.agents/skills/chrome-devtools/scripts/cdp.ts.
 */

import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { BROWSER_DEVTOOLS_PORT } from "@genesiscz/utils/net/ports";

const log = logger.child({ component: "chrome-devtools:cdp" });

export type Target = { id: string; type: string; title: string; url: string; webSocketDebuggerUrl: string };

export type CdpEventListener = (method: string, params: Record<string, unknown>, sessionId?: string) => void;

interface CdpIncoming {
    id?: number;
    result?: unknown;
    error?: unknown;
    method?: string;
    params?: Record<string, unknown>;
    sessionId?: string;
}

export class CdpDeadlineError extends Error {}

export interface CdpCallOptions {
    timeoutMs?: number;
    signal?: AbortSignal;
}

const COMMAND_TIMEOUT_MS = 30_000;
const HANDSHAKE_TIMEOUT_MS = 10_000;

export interface ConnOpts {
    handshakeTimeoutMs?: number;
    signal?: AbortSignal;
    /**
     * Called with every raw packet BEFORE JSON.parse; return true to skip the
     * parse entirely. This is the recorder's CPU lever: high-rate packets
     * (dataReceived, websocket frames) never become objects.
     */
    dropRaw?: (raw: string) => boolean;
}

export class Conn {
    private ws: WebSocket;
    private id = 0;
    private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
    private listeners: CdpEventListener[] = [];
    private ready: Promise<void>;
    private rejectReady: (error: Error) => void = () => {};
    readonly closed: Promise<void>;

    /** Settle every in-flight send() — a request against a dead socket must reject, never hang. */
    private rejectPending(reason: string): void {
        for (const [, p] of this.pending) {
            p.reject(new Error(reason));
        }

        this.pending.clear();
    }

    constructor(wsUrl: string, opts?: ConnOpts) {
        this.ws = new WebSocket(wsUrl);
        this.ready = new Promise((resolve, reject) => {
            const finish = (error?: Error) => {
                clearTimeout(timer);
                opts?.signal?.removeEventListener("abort", abort);
                this.rejectReady = () => {};
                if (error) {
                    reject(error);
                } else {
                    resolve();
                }
            };
            const abort = () => {
                finish(opts?.signal?.reason ?? new Error("CDP attachment aborted"));
                this.ws.close();
            };
            const timeoutMs = opts?.handshakeTimeoutMs ?? HANDSHAKE_TIMEOUT_MS;
            const timer = setTimeout(() => {
                finish(new CdpDeadlineError(`CDP socket did not open within ${timeoutMs} ms`));
                this.ws.close();
            }, timeoutMs);
            this.rejectReady = finish;
            this.ws.onopen = () => finish();
            this.ws.onerror = () => finish(new Error(`CDP socket did not open: ${wsUrl}`));
            opts?.signal?.addEventListener("abort", abort, { once: true });
            if (opts?.signal?.aborted) {
                abort();
            }
        });
        // A connection may time out before its first send. Keep its rejection observed until then.
        void this.ready.catch((error: unknown) => log.debug({ error }, "CDP handshake failed"));
        this.closed = new Promise((resolve) => {
            const finish = () => {
                this.rejectReady(new Error("CDP connection closed"));
                this.rejectPending("CDP connection closed");
                resolve();
            };
            this.ws.addEventListener("close", finish);
            this.ws.addEventListener("error", finish);
        });
        this.ws.onmessage = (ev) => {
            const raw = String(ev.data);
            if (opts?.dropRaw?.(raw)) {
                return;
            }

            const msg = SafeJSON.parse(raw, { strict: true }) as CdpIncoming;
            if (msg.id !== undefined) {
                const p = this.pending.get(msg.id);
                if (p) {
                    this.pending.delete(msg.id);
                    if (msg.error) {
                        p.reject(new Error(SafeJSON.stringify(msg.error, { strict: true })));
                    } else {
                        p.resolve(msg.result);
                    }
                }

                return;
            }

            for (const l of this.listeners) {
                l(msg.method ?? "", msg.params ?? {}, msg.sessionId);
            }
        };
    }

    async send(
        method: string,
        params: Record<string, unknown> = {},
        sessionId?: string,
        options: CdpCallOptions = {}
    ): Promise<unknown> {
        const id = ++this.id;
        const timeoutMs = options.timeoutMs ?? COMMAND_TIMEOUT_MS;
        return new Promise((resolve, reject) => {
            let finished = false;
            const finish = (error?: Error, value?: unknown) => {
                if (finished) {
                    return;
                }

                finished = true;
                clearTimeout(timer);
                options.signal?.removeEventListener("abort", abort);
                this.pending.delete(id);
                if (error) {
                    reject(error);
                } else {
                    resolve(value);
                }
            };
            const abort = () => finish(options.signal?.reason ?? new Error(`${method} aborted`));
            const timer = setTimeout(
                () => finish(new CdpDeadlineError(`${method} did not answer within ${timeoutMs} ms`)),
                timeoutMs
            );
            options.signal?.addEventListener("abort", abort, { once: true });
            if (options.signal?.aborted) {
                abort();
                return;
            }

            void this.ready.then(
                () => {
                    if (finished) {
                        return;
                    }

                    if (this.ws.readyState !== WebSocket.OPEN) {
                        finish(new Error("CDP connection closed"));
                        return;
                    }

                    this.pending.set(id, {
                        resolve: (value) => finish(undefined, value),
                        reject: (error) => finish(error),
                    });
                    const payload: Record<string, unknown> = { id, method, params };
                    if (sessionId) {
                        payload.sessionId = sessionId;
                    }

                    try {
                        this.ws.send(SafeJSON.stringify(payload, { strict: true }));
                    } catch (error) {
                        finish(error instanceof Error ? error : new Error(String(error)));
                    }
                },
                (error: Error) => finish(error)
            );
        });
    }

    on(fn: CdpEventListener): void {
        this.listeners.push(fn);
    }

    /** Removes a listener `on` added, so a finished wait stops receiving the page's events. */
    off(fn: CdpEventListener): void {
        this.listeners = this.listeners.filter((listener) => listener !== fn);
    }

    close(): void {
        this.rejectReady(new Error("CDP connection closed by client"));
        this.rejectPending("CDP connection closed by client");
        this.ws.close();
    }
}

export interface RecordedNetworkEvent {
    kind: "request" | "redirect" | "response" | "failed" | "nav";
    [key: string]: unknown;
}

const LEADING_COMMENTS = /^(\s*(\/\*[\s\S]*?\*\/|\/\/[^\n]*))*\s*/;

/**
 * The expression that runs `source`: a function source is called, anything else is evaluated as it
 * is. A payload file opens with a doc comment and ends with `;`, so both are skipped before the
 * test; without that, `eval --file` evaluated the file to the function and never ran it.
 */
export function evaluationExpression(source: string): string {
    const body = source.replace(LEADING_COMMENTS, "").replace(/;\s*$/, "");
    return /^(\(|async\b|function\b)/.test(body) ? `(${body})()` : source;
}

const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

/**
 * Accepts only a debugger socket on this machine and on the port we asked for. Another process can
 * grab a freed port before the browser binds it; its "debugger URL" must never receive our input.
 */
export function localDebuggerUrl(target: Pick<Target, "webSocketDebuggerUrl">, port: number): string {
    const url = new URL(target.webSocketDebuggerUrl);
    if (!["ws:", "wss:"].includes(url.protocol) || !LOCAL_HOSTS.has(url.hostname) || Number(url.port) !== port) {
        throw new Error(`Refusing a debugger URL that is not this machine's port ${port}: ${url.host}`);
    }

    return url.toString();
}

/**
 * The port of a CDP endpoint URL such as `http://127.0.0.1:9222`. Every client in this tool dials
 * 127.0.0.1, so an endpoint on another host is refused instead of being quietly replaced by this
 * machine's port.
 */
export function cdpPortOf(endpoint: string): number {
    const url = new URL(endpoint);
    if (!LOCAL_HOSTS.has(url.hostname)) {
        throw new Error(`Only a CDP endpoint on this machine is supported, got ${url.host}`);
    }

    const port = Number(url.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error(`The CDP endpoint ${endpoint} names no port`);
    }

    return port;
}

/** Page-level session: navigation, DOM, per-page network/console. */
export class Page {
    constructor(
        private conn: Conn,
        public target: Target
    ) {}

    send = (method: string, params?: Record<string, unknown>, options?: CdpCallOptions) =>
        this.conn.send(method, params, undefined, options);
    on = (fn: CdpEventListener) => this.conn.on(fn);
    close = () => this.conn.close();

    async enable(domains: string[] = ["Network", "Page", "Runtime", "Log"]): Promise<void> {
        for (const d of domains) {
            await this.conn.send(`${d}.enable`).catch((err: unknown) => {
                log.debug({ err, domain: d }, "domain enable failed");
            });
        }
    }

    navigate(url: string) {
        return this.conn.send("Page.navigate", { url });
    }

    reload(ignoreCache = false) {
        return this.conn.send("Page.reload", { ignoreCache });
    }

    /** Pass a function source string (`"() => …"`) or a bare expression. */
    async evaluate(fnOrExpr: string, options: CdpCallOptions = {}): Promise<unknown> {
        const r = (await this.conn.send(
            "Runtime.evaluate",
            {
                expression: evaluationExpression(fnOrExpr),
                awaitPromise: true,
                returnByValue: true,
            },
            undefined,
            options
        )) as {
            result?: { value?: unknown };
            exceptionDetails?: { text: string; exception?: { description?: string } };
        };

        if (r.exceptionDetails) {
            throw new Error(`${r.exceptionDetails.text} ${r.exceptionDetails.exception?.description ?? ""}`);
        }

        return r.result?.value;
    }

    async screenshot(path: string, fullPage = false): Promise<string> {
        const r = (await this.conn.send("Page.captureScreenshot", {
            format: "png",
            captureBeyondViewport: fullPage,
        })) as { data: string };
        await Bun.write(path, Buffer.from(r.data, "base64"));

        return path;
    }

    resize(width: number, height: number) {
        return this.conn.send("Emulation.setDeviceMetricsOverride", {
            width,
            height,
            deviceScaleFactor: 0,
            mobile: false,
        });
    }

    /** Live console feed; attach BEFORE the action you want to observe. */
    onConsole(fn: (level: string, text: string) => void): void {
        this.conn.on((m, p) => {
            if (m === "Runtime.consoleAPICalled") {
                const args = (p.args ?? []) as { value?: unknown; description?: string; type?: string }[];
                fn(String(p.type), args.map((a) => a.value ?? a.description ?? a.type).join(" "));
            }

            if (m === "Log.entryAdded") {
                const entry = p.entry as { level: string; text: string };
                fn(entry.level, entry.text);
            }
        });
    }

    /**
     * Network recorder. Returns a LIVE array of events. Captures
     * redirectResponse hops — the data a flat request list hides.
     */
    recordNetwork(filter?: (url: string) => boolean): RecordedNetworkEvent[] {
        const events: RecordedNetworkEvent[] = [];
        const keep = (u: string) => (filter ? filter(u) : true);
        this.conn.on((m, p) => {
            if (m === "Network.requestWillBeSent") {
                const req = p.request as { url: string; method: string; postData?: string };
                if (!keep(req.url)) {
                    return;
                }

                const redirect = p.redirectResponse as
                    | { status: number; url: string; headers?: Record<string, string> }
                    | undefined;
                if (redirect) {
                    const h = redirect.headers ?? {};
                    events.push({
                        kind: "redirect",
                        status: redirect.status,
                        from: redirect.url,
                        location: h.location ?? h.Location ?? null,
                        setCookie: Object.entries(h)
                            .filter(([k]) => k.toLowerCase() === "set-cookie")
                            .map(([, v]) => v),
                        ts: p.timestamp,
                    });
                }

                events.push({
                    kind: "request",
                    type: p.type,
                    method: req.method,
                    url: req.url,
                    postData: req.postData ?? null,
                    requestId: p.requestId,
                    ts: p.timestamp,
                });
            }

            if (m === "Network.responseReceived") {
                const res = p.response as { status: number; url: string; headers: Record<string, string> };
                if (keep(res.url)) {
                    events.push({
                        kind: "response",
                        status: res.status,
                        url: res.url,
                        headers: res.headers,
                        requestId: p.requestId,
                        ts: p.timestamp,
                    });
                }
            }

            if (m === "Network.loadingFailed") {
                events.push({ kind: "failed", requestId: p.requestId, error: p.errorText, ts: p.timestamp });
            }

            if (m === "Page.frameNavigated") {
                const frame = p.frame as { parentId?: string; url: string };
                if (!frame.parentId) {
                    events.push({ kind: "nav", url: frame.url, ts: Date.now() / 1000 });
                }
            }
        });

        return events;
    }

    async responseBody(requestId: string): Promise<{ body?: string; base64Encoded?: boolean }> {
        return (await this.conn.send("Network.getResponseBody", { requestId })) as {
            body?: string;
            base64Encoded?: boolean;
        };
    }

    async waitForText(texts: string[], timeoutMs = 15000): Promise<boolean> {
        const deadline = Date.now() + timeoutMs;

        while (Date.now() < deadline) {
            const found = await this.evaluate(
                `() => ${SafeJSON.stringify(texts, { strict: true })}.some(t => document.body?.innerText?.includes(t))`,
                { timeoutMs: Math.max(1, deadline - Date.now()) }
            ).catch((error: unknown) => {
                log.debug({ error }, "text wait evaluation failed");
                return false;
            });

            if (found) {
                return true;
            }

            await Bun.sleep(Math.max(0, Math.min(300, deadline - Date.now())));
        }

        return false;
    }
}

export interface CdpCookie {
    name: string;
    value: string;
    domain: string;
    path: string;
    expires: number;
    httpOnly: boolean;
    secure: boolean;
    sameSite?: string;
    /** A CHIPS-partitioned cookie's key; passed back verbatim, so its shape is not ours to type. */
    partitionKey?: unknown;
}

const sameCookie = (a: CdpCookie, b: CdpCookie): boolean =>
    a.name === b.name && a.domain === b.domain && a.path === b.path;

/**
 * The summary line `cookies` prints after a listing. The RFC 6265 duplicate-name
 * tip only makes sense once there is at least one cookie to be confused about —
 * an empty jar gets a plain count instead.
 */
export function cookiesSummaryLine(count: number): string {
    if (count === 0) {
        return "0 cookies.";
    }

    return `${count} cookies. Duplicate name on different paths => longer path is sent FIRST (RFC 6265); servers taking the first value bind to the stale session.`;
}

/** Browser-level session: cookies across ALL domains incl. httpOnly, target list. */
export class Browser {
    constructor(
        private conn: Pick<Conn, "send" | "close">,
        public port: number
    ) {}

    send = (method: string, params?: Record<string, unknown>, options?: CdpCallOptions) =>
        this.conn.send(method, params, undefined, options);
    close = () => this.conn.close();

    /** ALL cookies incl. httpOnly and other domains — impossible from page JS. */
    async cookies(domainFilter?: string): Promise<CdpCookie[]> {
        const r = (await this.conn.send("Storage.getCookies", {})) as { cookies: CdpCookie[] };
        const all = r.cookies;

        return domainFilter ? all.filter((c) => c.domain.includes(domainFilter)) : all;
    }

    setCookies(cookies: CdpCookie[]) {
        return this.conn.send("Storage.setCookies", { cookies: cookies as unknown as Record<string, unknown>[] });
    }

    /**
     * Expires the cookie through `Storage.setCookies` rather than calling `Network.deleteCookies`.
     *
     * This class holds a BROWSER-level connection (that is how `Storage.getCookies` can see every
     * domain at once), and the `Network` domain does not exist there: the call came back
     * `{"code":-32601,"message":"'Network.deleteCookies' wasn't found"}`. Setting the same
     * name/domain/path with an expiry in the past is the browser-level equivalent and stays
     * surgical, unlike `Storage.clearCookies`, which would take every cookie in the browser.
     *
     * Returns `false` when no such cookie exists, and throws when one survives the write.
     */
    async deleteCookie(name: string, domain: string, path = "/"): Promise<boolean> {
        const deleted = await this.deleteCookiesMatching(
            (c) => c.name === name && c.domain === domain && c.path === path
        );

        return deleted.length > 0;
    }

    /**
     * Delete every cookie matching the predicate; returns what was deleted, and throws naming any
     * cookie still present afterwards rather than reporting it deleted.
     *
     * Two details decide whether the write deletes anything. `expires: 0` is NOT the past to
     * Chromium: it converts exactly 0 to a null time, which marks a SESSION cookie, so the old
     * write blanked the value and kept the cookie until the browser quit. `1` is 1970-01-01T00:00:01Z.
     * And the original attributes go back with it: a write without `secure` cannot replace a
     * Secure cookie, and a `__Host-` or `__Secure-` name refuses one outright.
     */
    async deleteCookiesMatching(pred: (c: CdpCookie) => boolean): Promise<string[]> {
        const victims = (await this.cookies()).filter(pred);

        if (victims.length === 0) {
            return [];
        }

        await this.setCookies(
            victims.map((c) => ({
                name: c.name,
                value: "",
                domain: c.domain,
                path: c.path,
                expires: 1,
                httpOnly: c.httpOnly,
                secure: c.secure,
                ...(c.sameSite === undefined ? {} : { sameSite: c.sameSite }),
                ...(c.partitionKey === undefined ? {} : { partitionKey: c.partitionKey }),
            }))
        );

        const survivors = (await this.cookies()).filter((c) => victims.some((v) => sameCookie(v, c)));

        if (survivors.length > 0) {
            throw new Error(
                `still present after the delete: ${survivors.map((c) => `${c.name} ${c.domain} ${c.path}`).join(", ")}`
            );
        }

        return victims.map((c) => `${c.name} ${c.domain} ${c.path}`);
    }
}

/**
 * /json/list must never be able to hang a command. Chromium answers
 * /json/version instantly while /json/list stalls behind a busy tab, and an
 * unbounded fetch there turned `nav --match <nothing>` into a 90s hang that
 * had to be killed.
 */
export const TARGETS_TIMEOUT_MS = 5000;

export async function targets(port = BROWSER_DEVTOOLS_PORT, opts: { signal?: AbortSignal } = {}): Promise<Target[]> {
    const signal = opts.signal ?? AbortSignal.timeout(TARGETS_TIMEOUT_MS);
    const r = await fetch(`http://127.0.0.1:${port}/json/list`, { signal });

    return (await r.json()) as Target[];
}

export interface CdpProbe {
    port: number;
    browser: string;
    pages: { title?: string; url: string }[];
}

/**
 * `/json/version` only: is this port answering at all, and as what?
 *
 * Separate from `probe()` because the two questions have different failure modes. A
 * stalled `/json/list` says nothing about whether the browser is up, and a caller that
 * only needs "is it alive" must not be told "no" because the tab list timed out.
 */
export async function browserVersion(port: number, opts: { signal?: AbortSignal } = {}): Promise<string | null> {
    try {
        const r = await fetch(`http://127.0.0.1:${port}/json/version`, {
            signal: opts.signal ?? AbortSignal.timeout(1200),
        });
        const v = (await r.json()) as { Browser?: string };

        return v.Browser ?? "unknown";
    } catch (err) {
        log.debug({ err, port }, "/json/version did not answer on this port");

        return null;
    }
}

/** Is this port a live CDP endpoint, and what is open on it? null when nothing answers. */
export async function probe(port: number): Promise<CdpProbe | null> {
    const browser = await browserVersion(port);

    if (browser === null) {
        return null;
    }

    try {
        // The list fetch needs its own timeout: /json/version answering while
        // /json/list stalls would otherwise hang every inventory-based command.
        const list = (await targets(port, { signal: AbortSignal.timeout(1200) })).filter((t) => t.type === "page");

        return { port, browser, pages: list };
    } catch (err) {
        log.debug({ err, port }, "CDP probe found nothing on this port");

        return null;
    }
}

/**
 * Why an eval threw: did the script navigate the page, or did the call fail?
 *
 * Only two Chrome protocol errors mean "your script did its job and tore its own
 * execution context down" — `location.reload()` and `location.href = …` both
 * produce one of them. A closed websocket is NOT one: the browser exiting or the
 * endpoint disappearing produces the same text, and there the expression may
 * never have run at all. Reporting that as success told automation callers a
 * navigation had happened when nothing did (PR #336 review t1).
 */
export function classifyEvalError(message: string): "navigated" | "failed" {
    return /context was destroyed|Inspected target navigated/i.test(message) ? "navigated" : "failed";
}

/**
 * `/substr/flags` is a regex, anything else is a plain substring, and no pattern
 * matches everything. The --match help text promised regex support from day one;
 * only substring was wired up.
 *
 * This is the ONE matcher for the tool: `follow` re-exports it rather than
 * keeping a second copy whose edge cases could drift (PR #336 review t5).
 */
export function makeMatcher(pattern?: string): (value: string) => boolean {
    if (!pattern) {
        return () => true;
    }

    const re = pattern.match(/^\/(.+)\/([gimsuy]*)$/);

    if (re) {
        // g and y make test() stateful via lastIndex, so a reused matcher would
        // silently skip every other hit. They add nothing to a boolean test.
        const compiled = new RegExp(re[1], re[2].replace(/[gy]/g, ""));

        return (value) => compiled.test(value);
    }

    return (value) => value.includes(pattern);
}

/**
 * Tabs worth suggesting when `--match` hit nothing, best first: a miss must
 * say what IS open, not just that the guess failed.
 */
export function closeTabCandidates<T extends { title?: string; url: string }>(
    pages: T[],
    wanted: string,
    limit = 6
): T[] {
    const tokens = wanted
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((t) => t.length > 1);
    const score = (t: T) => {
        const hay = `${t.title ?? ""} ${t.url}`.toLowerCase();

        return tokens.filter((tok) => hay.includes(tok)).length;
    };
    const scored = pages.map((t) => ({ t, s: score(t) }));
    const hits = scored.filter((x) => x.s > 0).sort((a, z) => z.s - a.s);

    return (hits.length ? hits : scored).slice(0, limit).map((x) => x.t);
}

/** Thrown when --match names no open tab; carries the candidates to print. */
export class NoMatchingTabError extends Error {
    constructor(
        readonly wanted: string,
        readonly candidates: { title?: string; url: string }[]
    ) {
        super(`no tab matching "${wanted}"`);
        this.name = "NoMatchingTabError";
    }
}

/** Thrown when --match names SEVERAL open tabs; carries them so the caller can list them. */
export class AmbiguousTabError extends Error {
    constructor(
        readonly wanted: string,
        readonly matches: { title?: string; url: string }[]
    ) {
        super(`"${wanted}" matches ${matches.length} tabs`);
        this.name = "AmbiguousTabError";
    }
}

/**
 * Pick a page target. A given `url` must hit; never fall back to the first tab, and never pick one
 * of several silently.
 *
 * URL matches beat title matches. An open inspector's title is `DevTools - <host><path>`, so a
 * pattern anchored on the end of a page url also matches the INSPECTOR for that page, and a plain
 * `find` handed back the DevTools frontend: `eval` then returned the Network panel's own DOM
 * instead of the app's. Ranking url above title makes the page win whenever one matches at all.
 */
export function pickPageTarget<T extends { type?: string; title?: string; url: string }>(
    list: T[],
    opts: { url?: string; index?: number; port?: number } = {}
): T {
    const pages = list.filter((t) => t.type === "page" || t.type === undefined);
    const wanted = opts.url;

    if (wanted) {
        const matches = makeMatcher(wanted);
        const byUrl = pages.filter((x) => matches(x.url));
        const hits = byUrl.length > 0 ? byUrl : pages.filter((x) => matches(x.title ?? ""));

        if (hits.length === 0) {
            throw new NoMatchingTabError(wanted, closeTabCandidates(pages, wanted));
        }

        if (hits.length > 1) {
            throw new AmbiguousTabError(wanted, hits);
        }

        return hits[0] as T;
    }

    const t = pages[opts.index ?? 0];
    if (!t) {
        throw new Error(`no page target on port ${opts.port ?? "?"}`);
    }

    return t;
}

/** Attach to a page (url substring must match when given; otherwise first page). */
export async function attach(opts: { port?: number; url?: string; index?: number } = {}): Promise<Page> {
    const port = opts.port ?? BROWSER_DEVTOOLS_PORT;
    const list = (await targets(port)).filter((t) => t.type === "page");
    const t = pickPageTarget(list, { url: opts.url, index: opts.index, port });
    const page = new Page(new Conn(t.webSocketDebuggerUrl), t);
    await page.enable();

    return page;
}

/**
 * Open a NEW tab. `PUT /json/new?<url>` is the only endpoint that creates one
 * (Chromium ≥111 rejects the GET form), and it returns the fresh target — so
 * attaching does not have to re-scan and guess which tab is the new one.
 */
export async function newTab(port: number, url: string): Promise<Target> {
    // The url is ENCODED, not interpolated raw. /json/new takes its target as this endpoint's own
    // query string, so an unencoded `&` in the target is parsed as a second parameter OF /json/new
    // and everything after it is silently dropped: ?a=1&b=2 opened a tab on ?a=1. That looked like
    // the app stripping the query, which is a long way to chase a one-line bug.
    const r = await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(url)}`, {
        method: "PUT",
        signal: AbortSignal.timeout(TARGETS_TIMEOUT_MS),
    });

    if (!r.ok) {
        throw new Error(`could not open a tab on ${port}: ${r.status} ${await r.text()}`);
    }

    return (await r.json()) as Target;
}

/** Browser-level connection (cookies across all domains). */
export async function browser(port = BROWSER_DEVTOOLS_PORT): Promise<Browser> {
    const v = (await (
        await fetch(`http://127.0.0.1:${port}/json/version`, {
            signal: AbortSignal.timeout(TARGETS_TIMEOUT_MS),
        })
    ).json()) as {
        webSocketDebuggerUrl: string;
    };

    return new Browser(new Conn(v.webSocketDebuggerUrl), port);
}
