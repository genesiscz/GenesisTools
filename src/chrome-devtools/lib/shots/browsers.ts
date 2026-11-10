/**
 * The browser a shot book runs in: one interface, one implementation per kind, and an exhaustive table, so a third
 * kind (Playwright in a project, a remote browser) is one more entry and no runner change.
 *
 * - headless: a fresh headless Chrome; the same pixels every run. Login cookies are copied in memory.
 * - attach: your running browser (Brave or Chrome with a debug port), in a new background tab or the current one.
 */
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { browser, type CdpCookie, Conn, localDebuggerUrl, Page, targets } from "../cdp.ts";
import { cdpLikeOf } from "../cdp-like-adapter.ts";
import { launchHeadlessChrome } from "../headless.ts";
import { chooseCdpPort } from "../page-capture.ts";
import type { BrowserKind, BrowserSettings, CookieSource, ShotTab } from "./book.ts";

const { log } = logger.scoped("chrome-devtools:shots");

export interface ShotBrowser {
    /** False when the user's own profile draws into the page (extensions, zoom, theme). */
    reproducible: boolean;
    openTab(): Promise<ShotTab>;
    close(): Promise<void>;
}

export interface OpenContext {
    base?: string;
    /** --port: the browser to attach to, or the one to copy cookies from. */
    port?: number;
}

export interface ShotBrowserSource<K extends BrowserKind> {
    readonly kind: K;
    open(settings: BrowserSettings[K], context: OpenContext): Promise<ShotBrowser>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A new tab that does not take focus, on the browser at `port`; closing it closes the tab. */
async function backgroundTab(port: number): Promise<ShotTab> {
    const root = await browser(port);
    const reply = await root.send("Target.createTarget", { url: "about:blank", background: true });
    const targetId = isRecord(reply) && typeof reply.targetId === "string" ? reply.targetId : undefined;
    const target = (await targets(port)).find((candidate) => candidate.id === targetId);
    if (!targetId || !target) {
        root.close();
        throw new Error(`could not open a background tab on port ${port}`);
    }

    const page = new Page(new Conn(localDebuggerUrl(target, port)), target);
    // a background tab may get no frames; focus emulation makes it render and answer screenshots
    await page.send("Emulation.setFocusEmulationEnabled", { enabled: true }).catch((error: unknown) => {
        log.debug({ error }, "focus emulation unavailable");
    });

    return {
        cdp: cdpLikeOf(page),
        shared: false,
        async close() {
            page.close();
            await root.send("Target.closeTarget", { targetId }).catch(() => undefined);
            root.close();
        },
    };
}

/** Cookies a request to `base` would carry: the host's own and its parent domains'. */
function cookiesFor(all: readonly CdpCookie[], base: string): CdpCookie[] {
    const host = new URL(base).hostname;
    return all.filter((cookie) => {
        const domain = cookie.domain.replace(/^\./, "");
        return host === domain || host.endsWith(`.${domain}`);
    });
}

function isCookie(value: unknown): value is CdpCookie {
    return (
        isRecord(value) &&
        typeof value.name === "string" &&
        typeof value.value === "string" &&
        typeof value.domain === "string" &&
        typeof value.path === "string"
    );
}

function cookieArray(stdout: string): CdpCookie[] {
    const start = stdout.indexOf("[");
    const end = stdout.lastIndexOf("]");
    if (start < 0 || end < start) {
        throw new Error("the cookie command printed no JSON array");
    }

    const parsed: unknown = SafeJSON.parse(stdout.slice(start, end + 1), { strict: true });
    if (!Array.isArray(parsed) || !parsed.every(isCookie)) {
        throw new Error("the cookie command's JSON is not a cookie array");
    }

    return parsed;
}

/** A cookie command that waits on a prompt (a keychain dialog, a password) must not hold the run forever. */
export const COOKIE_COMMAND_TIMEOUT_MS = 30_000;

/** Runs a cookie command and reads its cookie array; a command still running at `timeoutMs` is killed. */
export async function cookiesFromCommand(
    argv: readonly string[],
    timeoutMs = COOKIE_COMMAND_TIMEOUT_MS
): Promise<CdpCookie[]> {
    const child = Bun.spawn([...argv], { stdout: "pipe", stderr: "pipe", timeout: timeoutMs });
    const [stdout, stderr] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
    const code = await child.exited;
    if (child.signalCode !== null) {
        throw new Error(`the cookie command ${argv[0]} did not finish within ${timeoutMs} ms`);
    }

    if (code !== 0) {
        throw new Error(`the cookie command ${argv[0]} failed: ${stderr.trim().split("\n").at(-1) ?? ""}`);
    }

    return cookieArray(stdout);
}

/** Login cookies for the headless browser, never written to disk or to the log. */
async function loginCookies(source: CookieSource, context: OpenContext): Promise<CdpCookie[]> {
    if (source.from === "none" || !context.base) {
        return [];
    }

    if (source.from === "command") {
        return cookiesFromCommand(source.argv.map((arg) => arg.replaceAll("{base}", context.base ?? "")));
    }

    let port: number;
    try {
        port = source.port ?? context.port ?? (await chooseCdpPort({ pageUrl: context.base })).port;
    } catch (error) {
        log.warn({ error }, "no running browser to copy login cookies from; the headless browser starts logged out");
        return [];
    }

    const running = await browser(port);
    try {
        return cookiesFor(await running.cookies(), context.base);
    } finally {
        running.close();
    }
}

const headlessSource: ShotBrowserSource<"headless"> = {
    kind: "headless",
    async open(settings, context) {
        const cookies = await loginCookies(settings.cookies, context);
        const chrome = await launchHeadlessChrome(settings.binary ? { binary: settings.binary } : {});
        if (cookies.length > 0) {
            // no ShotBrowser exists yet, so nobody else would close this Chrome and its profile on a failure here
            try {
                const root = await browser(chrome.port);
                try {
                    await root.setCookies(cookies);
                } finally {
                    root.close();
                }
            } catch (error) {
                await chrome.close();
                throw error;
            }
        }

        log.info({ port: chrome.port, cookies: cookies.length }, "headless browser for shots");
        return {
            reproducible: true,
            openTab: () => backgroundTab(chrome.port),
            close: () => chrome.close(),
        };
    },
};

const attachSource: ShotBrowserSource<"attach"> = {
    kind: "attach",
    async open(settings, context) {
        const port =
            context.port ?? settings.port ?? (await chooseCdpPort({ pageUrl: context.base ?? "about:blank" })).port;
        log.info({ port, tab: settings.tab }, "attached browser for shots");
        return {
            reproducible: false,
            async openTab() {
                if (settings.tab === "new") {
                    return backgroundTab(port);
                }

                const pages = (await targets(port)).filter((target) => target.type === "page");
                const current = pages.find((target) => context.base && target.url.startsWith(context.base)) ?? pages[0];
                if (!current) {
                    throw new Error(`no tab open on port ${port}`);
                }

                const page = new Page(new Conn(localDebuggerUrl(current, port)), current);
                return {
                    cdp: cdpLikeOf(page),
                    shared: true,
                    async close() {
                        page.close();
                    },
                };
            },
            async close() {},
        };
    },
};

export const BROWSER_SOURCES: { [K in BrowserKind]: ShotBrowserSource<K> } = {
    headless: headlessSource,
    attach: attachSource,
};

/** Opens the book's browser kind through the table; the caller never branches on the kind. */
export function openShotBrowser<K extends BrowserKind>(
    kind: K,
    settings: BrowserSettings,
    context: OpenContext
): Promise<ShotBrowser> {
    const source: ShotBrowserSource<K> = BROWSER_SOURCES[kind];
    return source.open(settings[kind], context);
}
