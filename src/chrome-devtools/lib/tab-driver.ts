import { withTimeout } from "@genesiscz/utils/async";
import { logger } from "@genesiscz/utils/logger";
import { CdpDeadlineError, type CdpEventListener, Conn, evaluationExpression, localDebuggerUrl, newTab } from "./cdp";
import { listTabs, type TabInfo, tabTarget } from "./tabs";

const { log } = logger.scoped("chrome-devtools-tab-driver");

const EVALUATE_DEADLINE_MS = 30_000;
/** A noisy tab sends hundreds of requests a minute; the wait keeps a bounded sample of their urls. */
const MAX_SEEN_URLS = 500;
const LOAD_DEADLINE_MS = 20_000;

export interface CapturedRequest {
    url: string;
    method: string;
    /** Header names are lower-cased. */
    headers: Record<string, string>;
}

export interface RequestWait {
    /** The first request `matches` accepted, or null when the deadline came first. */
    request: CapturedRequest | null;
    /** The request urls the tab sent during the wait, in order, up to the first 500. */
    seen: string[];
}

/**
 * One browser's tabs, addressed by target id. A caller that must stay on one tab keeps its id: there
 * is no selected page that follows the user from tab to tab, which is how chrome-devtools-mcp drove
 * a page where nothing had been installed once the user switched tabs.
 */
export interface TabDriver {
    /** Page tabs in the browser's target order. */
    tabs(): Promise<TabInfo[]>;
    /**
     * Runs `source`, a function source or an expression, in the page's own world (the page's globals
     * are visible) and returns its value. A promise is awaited; a thrown error is rethrown here.
     */
    evaluate(tabId: string, source: string, options?: { deadlineMs?: number }): Promise<unknown>;
    /** Navigates the tab. True when its load event fired before the deadline. */
    navigate(tabId: string, url: string): Promise<boolean>;
    /** Opens a new tab and waits for its load event or the deadline. */
    open(url: string): Promise<TabInfo>;
    /**
     * Waits for the tab to send a request that `matches` accepts. Only requests sent after the call
     * are seen; `cause` reloads or navigates the tab once the wait listens, to make the page send one.
     */
    waitForRequest(tabId: string, options: RequestWaitOptions): Promise<RequestWait>;
    close(): void;
}

export interface RequestWaitOptions {
    matches: (request: CapturedRequest) => boolean;
    timeoutMs: number;
    cause?: "reload" | { navigate: string };
}

export class TabGoneError extends Error {
    override name = "TabGoneError";

    constructor(readonly tabId: string) {
        super(`The tab ${tabId} is closed`);
    }
}

interface EvaluateReply {
    result?: { value?: unknown };
    exceptionDetails?: { text: string; exception?: { description?: string } };
}

/** Resolves true when `method` fires, false at the deadline, on cancel or when the socket closes. */
function eventWaiter(conn: Conn, method: string, timeoutMs: number): { done: Promise<boolean>; cancel: () => void } {
    let cancel = () => {};
    const done = new Promise<boolean>((resolve) => {
        const finish = (fired: boolean) => {
            clearTimeout(timer);
            conn.off(listener);
            resolve(fired);
        };
        const listener: CdpEventListener = (event) => {
            if (event === method) {
                finish(true);
            }
        };
        const timer = setTimeout(() => finish(false), timeoutMs);
        conn.on(listener);
        void conn.closed.then(() => finish(false));
        cancel = () => finish(false);
    });
    return { done, cancel };
}

function lowerCased(headers: Record<string, unknown> | undefined): Record<string, string> {
    return Object.fromEntries(
        Object.entries(headers ?? {}).map(([name, value]) => [name.toLowerCase(), String(value)])
    );
}

class CdpTabDriver implements TabDriver {
    private readonly connections = new Map<string, Promise<Conn>>();
    /**
     * Callers still waiting on an attachment in flight. The attachment is aborted only when every
     * one of them has given up: the first caller's short deadline must not fail a second caller
     * with a longer one, and a hung attachment nobody waits for must not stay open.
     */
    private readonly attaching = new Map<string, { controller: AbortController; waiting: number }>();
    /** Request waits running per connection: Network stays enabled until the last one ends. */
    private readonly networkWaits = new Map<Conn, number>();

    constructor(private readonly port: number) {}

    tabs(): Promise<TabInfo[]> {
        return listTabs(this.port);
    }

    private connect(tabId: string, signal?: AbortSignal): Promise<Conn> {
        const known = this.connections.get(tabId);
        if (known) {
            this.wait(tabId, signal);
            return known;
        }

        const controller = new AbortController();
        this.attaching.set(tabId, { controller, waiting: 0 });
        this.wait(tabId, signal);
        const pending = this.attach(tabId, controller.signal);
        const forget = () => {
            if (this.connections.get(tabId) === pending) {
                this.connections.delete(tabId);
            }
        };
        const settled = () => {
            if (this.attaching.get(tabId)?.controller === controller) {
                this.attaching.delete(tabId);
            }
        };
        void pending.then(settled, settled);
        this.connections.set(tabId, pending);
        void pending.then(
            (conn) => conn.closed.then(forget),
            (error: unknown) => {
                log.debug({ tabId, error }, "attaching to the tab failed");
                forget();
            }
        );
        return pending;
    }

    /** Counts a caller on the attachment in flight; a caller without a signal never gives up. */
    private wait(tabId: string, signal?: AbortSignal): void {
        const state = this.attaching.get(tabId);
        if (!state || signal?.aborted) {
            return;
        }

        state.waiting++;
        signal?.addEventListener(
            "abort",
            () => {
                state.waiting--;
                if (state.waiting === 0 && this.attaching.get(tabId) === state) {
                    state.controller.abort(signal.reason);
                }
            },
            { once: true }
        );
    }

    private async attach(tabId: string, signal?: AbortSignal): Promise<Conn> {
        const target = await tabTarget(this.port, tabId, { signal });
        if (!target) {
            throw new TabGoneError(tabId);
        }

        const conn = new Conn(localDebuggerUrl(target, this.port), { signal });
        try {
            await conn.send("Page.enable", {}, undefined, { signal });
            log.debug({ port: this.port, tabId, url: target.url }, "attached to tab");
            return conn;
        } catch (error) {
            conn.close();
            throw error;
        }
    }

    /** A call failed: a tab that no longer exists says so, anything else is rethrown as it is. */
    private async failed(tabId: string, error: unknown, signal?: AbortSignal): Promise<never> {
        if (signal?.aborted || error instanceof CdpDeadlineError) {
            throw error;
        }

        const target = await tabTarget(this.port, tabId, { signal }).catch((lookup: unknown) => {
            log.debug({ tabId, lookup }, "tab lookup after a failed call failed too");
            return undefined;
        });
        if (signal?.aborted) {
            throw signal.reason;
        }

        if (!target) {
            throw new TabGoneError(tabId);
        }

        throw error;
    }

    async evaluate(tabId: string, source: string, options: { deadlineMs?: number } = {}): Promise<unknown> {
        const deadlineMs = options.deadlineMs ?? EVALUATE_DEADLINE_MS;
        const controller = new AbortController();
        const expired = new CdpDeadlineError(`The page did not answer within ${deadlineMs} ms`);
        const timer = setTimeout(() => controller.abort(expired), deadlineMs);
        try {
            const conn = await withTimeout(this.connect(tabId, controller.signal), deadlineMs, expired);
            const reply = (await conn
                .send(
                    "Runtime.evaluate",
                    {
                        expression: evaluationExpression(source),
                        awaitPromise: true,
                        returnByValue: true,
                    },
                    undefined,
                    { timeoutMs: deadlineMs, signal: controller.signal }
                )
                .catch((error: unknown) => this.failed(tabId, error, controller.signal))) as EvaluateReply;
            if (reply.exceptionDetails) {
                throw new Error(
                    `${reply.exceptionDetails.text} ${reply.exceptionDetails.exception?.description ?? ""}`.trim()
                );
            }

            return reply.result?.value;
        } finally {
            clearTimeout(timer);
        }
    }

    async navigate(tabId: string, url: string): Promise<boolean> {
        const conn = await this.connect(tabId);
        const load = eventWaiter(conn, "Page.loadEventFired", LOAD_DEADLINE_MS);
        const sent = withTimeout(
            conn.send("Page.navigate", { url }),
            LOAD_DEADLINE_MS,
            new Error(`Page.navigate did not answer within ${LOAD_DEADLINE_MS} ms`)
        );
        const reply = (await sent.catch((error: unknown) => {
            load.cancel();
            return this.failed(tabId, error);
        })) as { errorText?: string };
        if (reply.errorText) {
            load.cancel();
            throw new Error(`Navigating to ${url} failed: ${reply.errorText}`);
        }

        const loaded = await load.done;
        log.debug({ tabId, url, loaded }, "tab navigated");
        return loaded;
    }

    async open(url: string): Promise<TabInfo> {
        const target = await newTab(this.port, url);
        const conn = await this.connect(target.id);
        // The load can finish before Page.enable, and then no event comes; the ready state says so.
        const load = eventWaiter(conn, "Page.loadEventFired", LOAD_DEADLINE_MS);
        const state = await this.evaluate(target.id, "document.readyState").catch((error: unknown) => {
            log.debug({ tabId: target.id, error }, "ready state read failed in a new tab");
            return undefined;
        });
        if (state === "complete") {
            load.cancel();
        } else {
            await load.done;
        }

        const fresh = (await tabTarget(this.port, target.id)) ?? target;
        log.debug({ tabId: target.id, url: fresh.url }, "opened a tab");
        return { id: target.id, url: fresh.url || url, title: fresh.title };
    }

    async waitForRequest(tabId: string, options: RequestWaitOptions): Promise<RequestWait> {
        const conn = await this.connect(tabId);
        const seen: string[] = [];
        let timer: ReturnType<typeof setTimeout> | undefined;
        let listener: CdpEventListener | undefined;
        const found = new Promise<CapturedRequest | null>((resolve) => {
            timer = setTimeout(() => resolve(null), options.timeoutMs);
            listener = (method, params) => {
                if (method !== "Network.requestWillBeSent") {
                    return;
                }

                const request = params.request as { url: string; method: string; headers?: Record<string, unknown> };
                if (seen.length < MAX_SEEN_URLS) {
                    seen.push(request.url);
                }

                const captured = { url: request.url, method: request.method, headers: lowerCased(request.headers) };
                if (options.matches(captured)) {
                    resolve(captured);
                }
            };
            conn.on(listener);
            void conn.closed.then(() => resolve(null));
        });

        this.networkWaits.set(conn, (this.networkWaits.get(conn) ?? 0) + 1);
        try {
            await conn.send("Network.enable").catch((error: unknown) => this.failed(tabId, error));
            if (options.cause) {
                const cause =
                    options.cause === "reload"
                        ? conn.send("Page.reload")
                        : conn.send("Page.navigate", { url: options.cause.navigate });
                await withTimeout(
                    cause,
                    LOAD_DEADLINE_MS,
                    new Error(`the request wait's cause did not answer within ${LOAD_DEADLINE_MS} ms`)
                ).catch((error: unknown) => this.failed(tabId, error));
            }

            const request = await found;
            log.debug(
                { tabId, found: request !== null, seen: seen.length, cause: options.cause ?? null },
                "request wait finished"
            );
            return { request, seen };
        } finally {
            clearTimeout(timer);
            if (listener) {
                conn.off(listener);
            }

            const running = (this.networkWaits.get(conn) ?? 1) - 1;
            if (running > 0) {
                this.networkWaits.set(conn, running);
            } else {
                this.networkWaits.delete(conn);
                await conn.send("Network.disable").catch((error: unknown) => {
                    log.debug({ tabId, error }, "Network.disable failed after a request wait");
                });
            }
        }
    }

    close(): void {
        for (const [tabId, pending] of this.connections) {
            pending
                .then((conn) => conn.close())
                .catch((error: unknown) => log.debug({ tabId, error }, "closing a tab connection failed"));
        }

        this.connections.clear();
    }
}

/** A driver for the browser whose CDP port is `port` on this machine. */
export function createTabDriver(port: number): TabDriver {
    return new CdpTabDriver(port);
}
