/**
 * Dev builds only, inside an extension's service worker: connects to `dev-reload/server.ts` and does
 * the reload each message names. Browser-side: uses the `chrome` global and nothing from Bun.
 */

interface DevReloadChrome {
    tabs: { query(info: { url: string }): Promise<{ id?: number }[]> };
    scripting: { executeScript(injection: { target: { tabId: number }; files: string[] }): Promise<unknown> };
    runtime: { reload(): void };
}

declare const chrome: DevReloadChrome;

export interface DevReloadOptions {
    /** `ws://127.0.0.1:<port>/reload`. */
    url: string;
    /** Tabs whose content script is re-injected, as a match pattern (`https://www.youtube.com/*`). */
    tabs: string;
    /** The content script files to inject again. */
    files: string[];
    /** Prefix for console lines. */
    label: string;
}

const RECONNECT_MS = 2000;
/** Chrome 116+ keeps an MV3 worker alive while its WebSocket has traffic. */
const KEEPALIVE_MS = 20_000;

/**
 * Re-injects the content script into every matching tab. `executeScript({ files })` reads the file
 * from disk each time, so it is the fresh build; the old copy should clean itself up when the new one
 * starts (the YouTube panel calls `window.__genesisYtCleanup()` first).
 */
async function reinject(options: DevReloadOptions): Promise<void> {
    const tabs = await chrome.tabs.query({ url: options.tabs });

    await Promise.all(
        tabs.map(async (tab) => {
            if (!tab.id) {
                return;
            }

            try {
                await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: options.files });
            } catch (error) {
                console.error(`[${options.label}] re-inject into tab ${tab.id} failed`, error);
            }
        })
    );
}

export function startDevReload(options: DevReloadOptions): void {
    let socket: WebSocket | null = null;
    let reconnect: ReturnType<typeof setTimeout> | null = null;
    let keepalive: ReturnType<typeof setInterval> | null = null;

    const schedule = () => {
        if (reconnect === null) {
            reconnect = setTimeout(() => {
                reconnect = null;
                connect();
            }, RECONNECT_MS);
        }
    };

    function connect(): void {
        if (socket) {
            return;
        }

        try {
            socket = new WebSocket(options.url);
        } catch (error) {
            console.debug(`[${options.label}] WebSocket failed, retrying`, error);
            schedule();
            return;
        }

        socket.onopen = () => {
            // After a runtime reload, content scripts already in tabs belong to the old worker and
            // throw "Extension context invalidated": re-inject once so they attach to this one.
            void reinject(options);

            if (keepalive !== null) {
                clearInterval(keepalive);
            }

            keepalive = setInterval(() => socket?.send("ping"), KEEPALIVE_MS);
        };
        socket.onmessage = (event) => {
            const target = typeof event.data === "string" ? event.data : "runtime";

            if (target === "tabs") {
                void reinject(options);
            } else if (target === "runtime") {
                void reinject(options).then(() => chrome.runtime.reload());
            }
        };
        socket.onclose = () => {
            socket = null;

            if (keepalive !== null) {
                clearInterval(keepalive);
                keepalive = null;
            }

            schedule();
        };
        socket.onerror = () => socket?.close();
    }

    connect();
}
