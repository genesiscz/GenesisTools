/**
 * Scriptable CDP client. Same capabilities as chrome-devtools-mcp tools, but
 * callable from any bun script (no MCP session, no config reload).
 * Ported from ~/.agents/skills/chrome-devtools/scripts/cdp.ts.
 */
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";

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

export interface ConnOpts {
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
            this.ws.onopen = () => resolve();
            this.ws.onerror = (e) => reject(e);
        });
        this.closed = new Promise((resolve) => {
            const finish = () => {
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

    async send(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<unknown> {
        await this.ready;

        if (this.ws.readyState !== WebSocket.OPEN) {
            throw new Error("CDP connection closed");
        }

        const id = ++this.id;

        return new Promise((resolve, reject) => {
            this.pending.set(id, { resolve, reject });
            const payload: Record<string, unknown> = { id, method, params };
            if (sessionId) {
                payload.sessionId = sessionId;
            }

            this.ws.send(SafeJSON.stringify(payload, { strict: true }));
        });
    }

    on(fn: CdpEventListener): void {
        this.listeners.push(fn);
    }

    close(): void {
        this.rejectPending("CDP connection closed by client");
        this.ws.close();
    }
}

export interface RecordedNetworkEvent {
    kind: "request" | "redirect" | "response" | "failed" | "nav";
    [key: string]: unknown;
}

/** Page-level session: navigation, DOM, per-page network/console. */
export class Page {
    constructor(
        private conn: Conn,
        public target: Target
    ) {}

    send = (method: string, params?: Record<string, unknown>) => this.conn.send(method, params);
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
    async evaluate(fnOrExpr: string): Promise<unknown> {
        const expression = /^\s*(\(|async|function)/.test(fnOrExpr) ? `(${fnOrExpr})()` : fnOrExpr;
        const r = (await this.conn.send("Runtime.evaluate", {
            expression,
            awaitPromise: true,
            returnByValue: true,
        })) as {
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
                `() => ${SafeJSON.stringify(texts, { strict: true })}.some(t => document.body?.innerText?.includes(t))`
            ).catch(() => false);

            if (found) {
                return true;
            }

            await Bun.sleep(300);
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
}

/** Browser-level session: cookies across ALL domains incl. httpOnly, target list. */
export class Browser {
    constructor(
        private conn: Conn,
        public port: number
    ) {}

    send = (method: string, params?: Record<string, unknown>) => this.conn.send(method, params);
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

    deleteCookie(name: string, domain: string, path = "/") {
        return this.conn.send("Network.deleteCookies", { name, domain, path });
    }

    /** Delete every cookie matching the predicate; returns what was deleted. */
    async deleteCookiesMatching(pred: (c: CdpCookie) => boolean): Promise<string[]> {
        const victims = (await this.cookies()).filter(pred);

        for (const c of victims) {
            await this.deleteCookie(c.name, c.domain, c.path);
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

export async function targets(port = 9222, opts: { signal?: AbortSignal } = {}): Promise<Target[]> {
    const signal = opts.signal ?? AbortSignal.timeout(TARGETS_TIMEOUT_MS);
    const r = await fetch(`http://127.0.0.1:${port}/json/list`, { signal });

    return (await r.json()) as Target[];
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

/** Pick a page target. A given `url` must hit; never fall back to the first tab. */
export function pickPageTarget<T extends { type?: string; title?: string; url: string }>(
    list: T[],
    opts: { url?: string; index?: number; port?: number } = {}
): T {
    const pages = list.filter((t) => t.type === "page" || t.type === undefined);
    const wanted = opts.url;

    if (wanted) {
        const matches = makeMatcher(wanted);
        const t = pages.find((x) => matches(x.url) || matches(x.title ?? ""));
        if (!t) {
            throw new NoMatchingTabError(wanted, closeTabCandidates(pages, wanted));
        }

        return t;
    }

    const t = pages[opts.index ?? 0];
    if (!t) {
        throw new Error(`no page target on port ${opts.port ?? "?"}`);
    }

    return t;
}

/** Attach to a page (url substring must match when given; otherwise first page). */
export async function attach(opts: { port?: number; url?: string; index?: number } = {}): Promise<Page> {
    const port = opts.port ?? 9222;
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
    const r = await fetch(`http://127.0.0.1:${port}/json/new?${url}`, {
        method: "PUT",
        signal: AbortSignal.timeout(TARGETS_TIMEOUT_MS),
    });

    if (!r.ok) {
        throw new Error(`could not open a tab on ${port}: ${r.status} ${await r.text()}`);
    }

    return (await r.json()) as Target;
}

/** Browser-level connection (cookies across all domains). */
export async function browser(port = 9222): Promise<Browser> {
    const v = (await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()) as {
        webSocketDebuggerUrl: string;
    };

    return new Browser(new Conn(v.webSocketDebuggerUrl), port);
}
