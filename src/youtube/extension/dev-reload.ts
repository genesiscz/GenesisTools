// Dev-only: connects to a local WebSocket broadcasted by
// `tools youtube extension dev`. Any inbound message triggers a full reload:
// reloads open youtube.com tabs (so freshly-built content-script re-injects)
// and then reloads the extension itself. Gated by a build-time flag so
// production bundles don't try to connect.

const WS_URL = "ws://127.0.0.1:9877/reload";
const RECONNECT_MS = 2000;
// Chrome 116+ keeps the MV3 service worker alive as long as there's active
// WebSocket traffic. Ping every 20s so a dev session with no rebuilds still
// keeps the SW warm.
const KEEPALIVE_MS = 20_000;

let socket: WebSocket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let keepaliveTimer: ReturnType<typeof setInterval> | null = null;

async function reloadYouTubeTabs(): Promise<void> {
    // Panel-only hot-swap: re-inject content-script.js into each tab. Old
    // instance's `window.__genesisYtCleanup()` (set on prior mount) is
    // invoked at the top of the fresh script, which unmounts DOM +
    // listeners before the new mount runs. Video and page state preserved.
    //
    // `executeScript({files:["content-script.js"]})` reads the file from
    // disk on every call — fresh bytes, no browser cache to fight, no CSP
    // issues (MV3 SW forbids `new Function()`).
    try {
        const tabs = await chrome.tabs.query({ url: "https://www.youtube.com/*" });
        console.log(`[genesis-yt dev-reload] found ${tabs.length} YT tab(s)`);
        await Promise.all(
            tabs.map(async (t) => {
                if (!t.id) {
                    return;
                }

                try {
                    await chrome.scripting.executeScript({
                        target: { tabId: t.id },
                        files: ["content-script.js"],
                    });
                    console.log(`[genesis-yt dev-reload] re-injected tab=${t.id}`);
                } catch (error) {
                    console.error(`[genesis-yt dev-reload] executeScript tab=${t.id} failed:`, error);
                }
            })
        );
    } catch (error) {
        console.error("[genesis-yt dev-reload] reloadYouTubeTabs threw:", error);
    }
}

async function reloadTabsThenSelf(): Promise<void> {
    await reloadYouTubeTabs();
    chrome.runtime.reload();
}

function connect(): void {
    if (socket) {
        return;
    }
    try {
        socket = new WebSocket(WS_URL);
    } catch {
        scheduleReconnect();
        return;
    }
    socket.onopen = () => {
        console.log("[genesis-yt dev-reload] connected");
        // On fresh SW boot (post runtime.reload), any content-scripts already
        // running in YT tabs are orphaned — their sendMessage calls now throw
        // "Extension context invalidated". Re-inject once so they re-attach
        // to this SW.
        void reloadYouTubeTabs();
        if (keepaliveTimer !== null) {
            clearInterval(keepaliveTimer);
        }
        keepaliveTimer = setInterval(() => {
            try {
                socket?.send("ping");
            } catch (error) {
                console.debug("[genesis-yt dev-reload] keepalive ping failed", error);
            }
        }, KEEPALIVE_MS);
    };
    socket.onmessage = (event) => {
        const target = typeof event.data === "string" ? event.data : "runtime";
        if (target === "ping" || target === "pong") {
            return;
        }
        if (target === "tabs") {
            console.log("[genesis-yt dev-reload] content-script changed → re-injecting into YT tabs");
            void reloadYouTubeTabs();
        } else {
            console.log("[genesis-yt dev-reload] background changed → reloading extension");
            void reloadTabsThenSelf();
        }
    };
    socket.onclose = () => {
        socket = null;
        if (keepaliveTimer !== null) {
            clearInterval(keepaliveTimer);
            keepaliveTimer = null;
        }
        scheduleReconnect();
    };
    socket.onerror = () => {
        try {
            socket?.close();
        } catch (error) {
            console.debug("[genesis-yt dev-reload] socket close threw", error);
        }
    };
}

function scheduleReconnect(): void {
    if (reconnectTimer !== null) {
        return;
    }
    reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        connect();
    }, RECONNECT_MS);
}

export function startDevReload(): void {
    connect();
}
