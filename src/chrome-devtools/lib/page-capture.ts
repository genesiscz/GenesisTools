/**
 * Records one page's network traffic as a HAR, iframes included: a player embedded from another site runs in its own
 * process (an out-of-process iframe), whose requests a page-level `Network.enable` never sees. Each such frame is
 * auto-attached as a flat session and gets its own `Network.enable`.
 */
import { toolCommand } from "@genesiscz/utils/cli/tool-command";
import { logger } from "@genesiscz/utils/logger";
import { BROWSER_DEVTOOLS_PORT } from "@genesiscz/utils/net/ports";
import { Conn, localDebuggerUrl, newTab, type Target, targets } from "./cdp.ts";
import { harFromMessages } from "./har/build.ts";
import type { CdpMessage, HarFile } from "./har/types.ts";
import { discoverListeningCdpPorts } from "./resolve-attach.ts";

const log = logger.child({ component: "chrome-devtools:page-capture" });

const NETWORK_BUFFERS = {
    maxTotalBufferSize: 100_000_000,
    maxResourceBufferSize: 50_000_000,
    maxPostDataSize: 1_000_000,
};
const AUTO_ATTACH = { autoAttach: true, waitForDebuggerOnStart: true, flatten: true };

/** The URL without its fragment and trailing slash, so `https://a.example/x/` matches `https://a.example/x#top`. */
function comparableUrl(url: string): string {
    try {
        const parsed = new URL(url);
        parsed.hash = "";
        return parsed.toString().replace(/\/$/, "");
    } catch {
        return url.replace(/#.*$/, "").replace(/\/$/, "");
    }
}

export interface CdpPortChoice {
    port: number;
    /** How the port was chosen, for the log and the user. */
    reason: string;
}

/**
 * The browser to use: `port` when given, else the one browser with a debug port that has the page open, else the only
 * debug port, else the default port 9222. Several browsers and none with the page open is refused only when 9222 is
 * not among them.
 */
export async function chooseCdpPort({ pageUrl, port }: { pageUrl: string; port?: number }): Promise<CdpPortChoice> {
    if (port !== undefined) {
        return { port, reason: "--chrome-cdp-port" };
    }

    const ports = discoverListeningCdpPorts();

    if (ports.length === 0) {
        const restart = toolCommand(
            "chrome-devtools",
            "restart",
            "--browser",
            "brave",
            "--port",
            String(BROWSER_DEVTOOLS_PORT)
        );
        throw new Error(`No browser listens on a debug port. Restart it with one: ${restart}`);
    }

    const wanted = comparableUrl(pageUrl);
    const withPage: number[] = [];

    for (const candidate of ports) {
        const pages = await targets(candidate).catch((error: unknown) => {
            log.debug({ error, port: candidate }, "Debug port did not list its targets");
            return [];
        });

        if (pages.some((target) => target.type === "page" && comparableUrl(target.url) === wanted)) {
            withPage.push(candidate);
        }
    }

    if (withPage.length === 1) {
        return { port: withPage[0], reason: "the browser that has the page open" };
    }

    if (ports.length === 1) {
        return { port: ports[0], reason: "the only browser with a debug port" };
    }

    if (ports.includes(BROWSER_DEVTOOLS_PORT)) {
        return { port: BROWSER_DEVTOOLS_PORT, reason: `the default debug port among ${ports.join(", ")}` };
    }

    throw new Error(`Several browsers have a debug port (${ports.join(", ")}). Pass --chrome-cdp-port <n>.`);
}

export interface PageCaptureOptions {
    pageUrl: string;
    port: number;
    /** Stop early once responses matching this have stopped coming for `settleSeconds` (a page loads several players). */
    until?: (url: string, mimeType: string) => boolean;
    maxSeconds: number;
    settleSeconds?: number;
    /** Which response bodies to read into the HAR (playlists, small JSON); the rest stay out. */
    wantBody: (url: string, mimeType: string) => boolean;
    signal?: AbortSignal;
}

export interface PageCaptureResult {
    har: HarFile;
    tab: { id: string; url: string; opened: boolean };
    /** How many responses matched `until`. */
    matches: number;
    sessions: number;
}

/**
 * Reloads the open tab of `pageUrl` (or opens a new one), records the traffic of the page and of every frame and worker
 * it attaches, and returns it as a HAR with the wanted bodies. A tab this function opened is closed afterwards.
 */
export async function capturePageTraffic(options: PageCaptureOptions): Promise<PageCaptureResult> {
    const wanted = comparableUrl(options.pageUrl);
    const open = (await targets(options.port)).filter(
        (target) => target.type === "page" && comparableUrl(target.url) === wanted
    );
    const opened = open.length === 0;
    const target: Target = open[0] ?? (await newTab(options.port, "about:blank"));
    log.debug({ port: options.port, tab: target.id, opened, page: options.pageUrl }, "Page capture tab");

    const conn = new Conn(localDebuggerUrl(target, options.port), { signal: options.signal });
    const messages: CdpMessage[] = [];
    const sessions = new Set<string>();
    let matchedAt: number | null = null;
    let matches = 0;

    conn.on((method, params, sessionId) => {
        if (method.startsWith("Network.") || method.startsWith("Page.")) {
            messages.push({ method, params, sessionId });
        }

        if (method === "Network.responseReceived" && options.until) {
            const response = params.response as { url?: string; mimeType?: string } | undefined;

            if (response?.url && options.until(response.url, response.mimeType ?? "")) {
                matchedAt = Date.now();
                matches++;
            }
        }

        if (method === "Target.attachedToTarget") {
            const child = String(params.sessionId);
            sessions.add(child);
            void attachChild(conn, child).catch((error: unknown) => {
                log.debug({ error, session: child }, "Could not record an attached frame");
            });
        }
    });

    try {
        await conn.send("Page.enable");
        await conn.send("Network.enable", NETWORK_BUFFERS);
        await conn.send("Target.setAutoAttach", AUTO_ATTACH);

        if (opened) {
            await conn.send("Page.navigate", { url: options.pageUrl });
        } else {
            await conn.send("Page.reload", { ignoreCache: true });
        }

        const started = Date.now();
        const settleMs = (options.settleSeconds ?? 8) * 1000;

        while (!options.signal?.aborted) {
            const now = Date.now();

            if (now - started >= options.maxSeconds * 1000) {
                break;
            }

            if (matchedAt !== null && now - matchedAt >= settleMs) {
                break;
            }

            await Bun.sleep(250);
        }

        const bodies = await readBodies(conn, messages, options.wantBody);
        log.debug({ messages: messages.length, sessions: sessions.size, bodies, matches }, "Page capture finished");
        const har = harFromMessages(messages, { includeTextFromResponseBody: true });
        return { har, tab: { id: target.id, url: target.url, opened }, matches, sessions: sessions.size };
    } finally {
        if (opened) {
            await conn.send("Page.close").catch((error: unknown) => log.debug({ error }, "Could not close the tab"));
        }

        conn.close();
    }
}

async function attachChild(conn: Conn, sessionId: string): Promise<void> {
    await conn.send("Network.enable", NETWORK_BUFFERS, sessionId).catch((error: unknown) => {
        log.debug({ error, sessionId }, "Network.enable failed on an attached target");
    });
    await conn.send("Target.setAutoAttach", AUTO_ATTACH, sessionId).catch((error: unknown) => {
        log.debug({ error, sessionId }, "Nested auto-attach failed");
    });
    await conn.send("Runtime.runIfWaitingForDebugger", {}, sessionId);
}

/** Reads the wanted response bodies into their `responseReceived` events, where the HAR builder takes them from. */
async function readBodies(
    conn: Conn,
    messages: CdpMessage[],
    wantBody: PageCaptureOptions["wantBody"]
): Promise<number> {
    let read = 0;

    for (const message of messages) {
        if (message.method !== "Network.responseReceived") {
            continue;
        }

        const response = message.params.response as { url?: string; mimeType?: string; body?: string } | undefined;

        if (!response?.url || !wantBody(response.url, response.mimeType ?? "")) {
            continue;
        }

        try {
            const result = (await conn.send(
                "Network.getResponseBody",
                { requestId: message.params.requestId },
                message.sessionId
            )) as { body?: string; base64Encoded?: boolean };

            if (typeof result.body === "string") {
                response.body = result.base64Encoded
                    ? Buffer.from(result.body, "base64").toString("utf8")
                    : result.body;
                read++;
            }
        } catch (error) {
            log.debug({ error, url: response.url }, "Response body not available");
        }
    }

    return read;
}
