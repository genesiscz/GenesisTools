import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
    browser,
    browserVersion,
    Conn,
    localDebuggerUrl,
    Page,
    type Target,
    targets,
} from "@app/chrome-devtools/lib/cdp";
import { closeTab } from "@app/chrome-devtools/lib/tabs";
import { toolCommand } from "@genesiscz/utils/cli/tool-command";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { BROWSER_DEVTOOLS_PORT } from "@genesiscz/utils/net/ports";
import { toolDataDir } from "@genesiscz/utils/storage/root";

const { log } = logger.scoped("waze-session");

/** The live map page whose scripts mint the reCAPTCHA token every `/live-map/api/*` call needs. */
export const LIVE_MAP_URL = "https://www.waze.com/cs/live-map/";
/** reCAPTCHA Enterprise site key and action, read from `livemap-*.js` on 2026-11-01. */
export const RECAPTCHA_SITE_KEY = "6Lf4WdUqAAAAAEUYUvzyLYIkO3PoFAqi8ZHGiDLW";
export const RECAPTCHA_ACTION = "api";
/** A token is reused for this long inside the page; reCAPTCHA tokens expire after two minutes. */
const TOKEN_REUSE_MS = 90_000;
/**
 * Waze accepts one token for five requests and answers the sixth with 429 (measured 2026-11-01: five 200s, then 429
 * whether the requests came 0.3 s or 2.5 s apart; a fresh token answered 200 at once).
 */
export const TOKEN_MAX_USES = 5;
const READY_TIMEOUT_MS = 30_000;
const READY_POLL_MS = 250;
const REQUEST_TIMEOUT_MS = 60_000;

export interface WazeRequest {
    /** A path under https://www.waze.com, e.g. `/live-map/api/georss?...`. */
    path: string;
    method?: "GET" | "POST";
    body?: unknown;
}

export interface WazeResponse {
    status: number;
    body: string;
    /** True when the first token was refused and the request was sent again with a fresh one. */
    retried: boolean;
    /** The `Retry-After` header of a 429, when Waze sends one. */
    retryAfter?: string;
}

export interface TransportInfo {
    kind: "browser-tab";
    port: number;
    browser: string;
    tabId: string;
    /** True when the tab was kept by an earlier `--keep-tab` run and reused. */
    reused: boolean;
    keepTab: boolean;
    /**
     * The live map's own config flag `hideUserReportsAndWazers`, read from the page. True since at least 2026-11-01:
     * georss then answers road closures only, never police, accidents or hazards. Undefined when the page has no flag.
     */
    userReportsHidden?: boolean;
}

/**
 * Sends a request to the Waze live-map API. One implementation today (a live-map tab in the user's browser); a future
 * official feed would be a second one behind the same interface.
 */
export interface WazeTransport {
    request(req: WazeRequest): Promise<WazeResponse>;
    info(): TransportInfo;
    close(): Promise<void>;
}

export class WazeBrowserUnavailableError extends Error {
    constructor(readonly port: number) {
        super(
            `No browser answers CDP on 127.0.0.1:${port}. Start Brave with remote debugging: ` +
                `${toolCommand("chrome-devtools restart", "--browser", "brave", "--port", String(port))}`
        );
    }
}

interface KeptTab {
    port: number;
    targetId: string;
}

function keptTabPath(): string {
    return toolDataDir("waze", "tab.json");
}

function readKeptTab(port: number): KeptTab | undefined {
    const path = keptTabPath();
    if (!existsSync(path)) {
        return undefined;
    }

    try {
        const parsed: unknown = SafeJSON.parse(readFileSync(path, "utf8"), { strict: true });
        if (
            typeof parsed === "object" &&
            parsed !== null &&
            "targetId" in parsed &&
            typeof parsed.targetId === "string" &&
            "port" in parsed &&
            parsed.port === port
        ) {
            return { port, targetId: parsed.targetId };
        }
    } catch (error) {
        log.debug({ error, path }, "kept tab file unreadable");
    }

    return undefined;
}

function writeKeptTab(tab: KeptTab | undefined): void {
    const path = keptTabPath();
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, SafeJSON.stringify(tab ?? {}, null, 2));
}

/** The in-page request runner. It caches one token per page and mints a fresh one after a 403. */
function pageRequestSource(req: WazeRequest): string {
    const payload = SafeJSON.stringify({
        path: req.path,
        method: req.method ?? "GET",
        body: req.body === undefined ? undefined : SafeJSON.stringify(req.body),
        key: RECAPTCHA_SITE_KEY,
        action: RECAPTCHA_ACTION,
        reuseMs: TOKEN_REUSE_MS,
        maxUses: TOKEN_MAX_USES,
    });
    return `async () => {
        const req = ${payload};
        const cache = (window.__gtWazeToken ??= { promise: null, at: 0, uses: 0 });
        const token = (fresh) => {
            if (fresh || !cache.promise || cache.uses >= req.maxUses || Date.now() - cache.at > req.reuseMs) {
                cache.at = Date.now();
                cache.uses = 0;
                cache.promise = new Promise((resolve) => grecaptcha.enterprise.ready(resolve)).then(() =>
                    grecaptcha.enterprise.execute(req.key, { action: req.action })
                );
                cache.promise.catch(() => { cache.promise = null; });
            }
            cache.uses++;
            return cache.promise;
        };
        const send = async (fresh) => {
            const headers = { "X-Recaptcha-Token": await token(fresh) };
            if (req.body !== undefined) {
                headers["Content-Type"] = "application/json; charset=UTF-8";
            }
            const response = await fetch(req.path, { method: req.method, headers, body: req.body, credentials: "include" });
            return {
                status: response.status,
                body: await response.text(),
                retryAfter: response.headers.get("retry-after") ?? undefined,
            };
        };
        let result = await send(false);
        let retried = false;
        // 403: the token was refused (the first one in a fresh tab often is); 429: it was used up.
        if (result.status === 403 || result.status === 429) {
            retried = true;
            result = await send(true);
        }
        return { ...result, retried };
    }`;
}

function isResponse(value: unknown): value is WazeResponse {
    return (
        typeof value === "object" &&
        value !== null &&
        "status" in value &&
        typeof value.status === "number" &&
        "body" in value &&
        typeof value.body === "string"
    );
}

/** A Waze live-map tab of our own in the user's browser, driven over CDP. */
export class BrowserTabTransport implements WazeTransport {
    private constructor(
        private readonly page: Page,
        private details: TransportInfo
    ) {}

    /**
     * Opens (or reuses a kept) background tab on the live map and waits until its reCAPTCHA script can mint tokens.
     * Never touches another tab. `persistKeptTab: false` (doctor) never writes the kept-tab file.
     */
    static async open(
        opts: { port?: number; keepTab?: boolean; persistKeptTab?: boolean } = {}
    ): Promise<BrowserTabTransport> {
        const port = opts.port ?? BROWSER_DEVTOOLS_PORT;
        const version = await browserVersion(port, { signal: AbortSignal.timeout(3000) });
        if (version === null) {
            throw new WazeBrowserUnavailableError(port);
        }

        const kept = readKeptTab(port);
        let target: Target | undefined;
        let reused = false;
        if (kept) {
            target = (await targets(port)).find(
                (candidate) => candidate.id === kept.targetId && candidate.url.startsWith("https://www.waze.com/")
            );
            reused = target !== undefined;
            log.debug({ port, targetId: kept.targetId, reused }, "kept waze tab lookup");
        }

        if (!target) {
            target = await createBackgroundTab(port);
        }

        const page = new Page(new Conn(localDebuggerUrl(target, port)), target);
        const transport = new BrowserTabTransport(page, {
            kind: "browser-tab",
            port,
            browser: version,
            tabId: target.id,
            reused,
            keepTab: opts.keepTab === true,
        });
        try {
            await transport.waitUntilReady();
        } catch (error) {
            await transport.close({ persist: false });
            throw error;
        }

        if (opts.keepTab && opts.persistKeptTab !== false) {
            writeKeptTab({ port, targetId: target.id });
        }

        return transport;
    }

    info(): TransportInfo {
        return { ...this.details };
    }

    private async waitUntilReady(): Promise<void> {
        const deadline = Date.now() + READY_TIMEOUT_MS;
        let lastError: unknown;
        while (Date.now() < deadline) {
            try {
                const ready = await this.page.evaluate(
                    "location.href.startsWith('https://www.waze.com/') && typeof window.grecaptcha?.enterprise?.execute === 'function'",
                    { timeoutMs: 5000 }
                );
                if (ready === true) {
                    this.details.userReportsHidden = await this.readUserReportsHidden();
                    log.debug(
                        { tabId: this.details.tabId, userReportsHidden: this.details.userReportsHidden },
                        "waze live map ready"
                    );
                    return;
                }
            } catch (error) {
                // The first evaluations race the navigation from about:blank; a destroyed context is expected here.
                lastError = error;
                log.debug({ error }, "waze tab not ready yet");
            }

            await Bun.sleep(Math.min(READY_POLL_MS, Math.max(0, deadline - Date.now())));
        }

        throw new Error(
            `The Waze live map did not load its reCAPTCHA script within ${READY_TIMEOUT_MS / 1000} s${lastError instanceof Error ? ` (${lastError.message})` : ""}`
        );
    }

    /** The page config's `hideUserReportsAndWazers` (server-rendered into the HTML), or undefined when absent. */
    private async readUserReportsHidden(): Promise<boolean | undefined> {
        const value = await this.page.evaluate(
            `() => {
                const match = document.documentElement.outerHTML.match(/"hideUserReportsAndWazers":(true|false)/);
                return match ? match[1] === "true" : null;
            }`,
            { timeoutMs: 5000 }
        );
        return typeof value === "boolean" ? value : undefined;
    }

    /** Mints one fresh token (doctor): its length and how long the mint took. The token itself is not returned. */
    async mintToken(): Promise<{ length: number; ms: number }> {
        const started = performance.now();
        const length = await this.page.evaluate(
            `async () => {
                await new Promise((resolve) => grecaptcha.enterprise.ready(resolve));
                const token = await grecaptcha.enterprise.execute(${SafeJSON.stringify(RECAPTCHA_SITE_KEY)}, { action: ${SafeJSON.stringify(RECAPTCHA_ACTION)} });
                return typeof token === "string" ? token.length : 0;
            }`,
            { timeoutMs: 20_000 }
        );
        return { length: typeof length === "number" ? length : 0, ms: Math.round(performance.now() - started) };
    }

    async request(req: WazeRequest): Promise<WazeResponse> {
        const started = performance.now();
        const value = await this.page.evaluate(pageRequestSource(req), { timeoutMs: REQUEST_TIMEOUT_MS });
        if (!isResponse(value)) {
            throw new Error(`The Waze tab returned no response for ${req.path}`);
        }

        log.debug(
            {
                path: req.path.split("?")[0],
                status: value.status,
                retried: value.retried,
                bytes: value.body.length,
                ms: Math.round(performance.now() - started),
            },
            "waze request"
        );
        return value;
    }

    async close(opts: { persist?: boolean } = {}): Promise<void> {
        this.page.close();
        if (this.details.keepTab && opts.persist !== false) {
            log.debug({ tabId: this.details.tabId }, "waze tab kept");
            return;
        }

        try {
            await closeTab(this.details.port, this.details.tabId);
            log.debug({ tabId: this.details.tabId }, "waze tab closed");
        } catch (error) {
            log.warn({ error, tabId: this.details.tabId }, "could not close the waze tab");
        }

        if (this.details.reused) {
            writeKeptTab(undefined);
        }
    }
}

/** `Target.createTarget` with `background: true`, so the user's focused tab stays in front. */
async function createBackgroundTab(port: number): Promise<Target> {
    const connection = await browser(port);
    try {
        const created = await connection.send("Target.createTarget", { url: LIVE_MAP_URL, background: true });
        const targetId =
            typeof created === "object" && created !== null && "targetId" in created ? created.targetId : undefined;
        if (typeof targetId !== "string") {
            throw new Error("The browser did not return a target id for the new Waze tab");
        }

        log.debug({ port, targetId }, "waze tab opened");
        for (let attempt = 0; attempt < 20; attempt++) {
            const target = (await targets(port)).find((candidate) => candidate.id === targetId);
            if (target) {
                return target;
            }

            await Bun.sleep(150);
        }

        throw new Error(`The new Waze tab ${targetId} never appeared in the target list`);
    } finally {
        connection.close();
    }
}
