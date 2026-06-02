import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import { View } from "react-native";
import { WebView, type WebViewMessageEvent } from "react-native-webview";
import {
    injectBytes,
    injectFit,
    injectFocus,
    injectScroll,
    injectScrollPage,
    parseBridgeMsg,
} from "@/features/terminals/bridge";
import { keyToBytes } from "@/features/terminals/keymap";
import { registerDriver } from "@/features/terminals/registry";
import type { TerminalDriverProps } from "@/features/terminals/registry";
import type {
    TerminalCallbacks,
    TerminalKey,
    TerminalKeyMods,
    TerminalRenderer,
    TerminalSession,
    TerminalStatus,
} from "@/features/terminals/TerminalRenderer";
import { XTERM_HOST_HTML } from "@/features/terminals/xterm-host.generated";
import { useConnectionStore } from "@/state/connection-store";
import { useThemeColors } from "@/theme/colors";
import type { TerminalTransport } from "@/transport/Transport";

/**
 * Driver B (D12): a self-contained xterm.js host page (`XTERM_HOST_HTML`, generated build-time) +
 * a self-opened ttyd WebSocket. The renderer owns the socket via the foundation's
 * `transport.openTerminal(sessionId)` (plan-02 `terminal-ws.ts` — `tty` subprotocol, heartbeat,
 * AppState reconnect already built; we do NOT hand-roll a socket). The token rides the WS
 * subprotocol on the transport side, so Driver B needs NO cookie (the reason it's the robust path
 * when Driver A's cookie auth can't be planted without a native cookie module).
 *
 * Data path: WS frame → base64 → `injectBytes` → page `term.write`; page `term.onData` →
 * `postMessage({t:"data",payload:base64})` → `transport.send`. Output is base64-coalesced through
 * the bridge so binary survives the string-only injection channel. xterm.js paints with its own
 * (non-WebGL — WKWebView WebGL is flaky, research 06) canvas renderer.
 *
 * Bytes from ttyd arrive as ArrayBuffer/string; we forward each frame as base64 so the page's
 * `atob` path reconstructs the exact bytes (no rAF batching here — xterm's own write buffer
 * coalesces; the plan's 8 KB coalescer is a device-tuning follow-up noted in the terminals notes).
 */

/**
 * Encode a ttyd frame to base64 for the bridge. CRITICAL: the host page's `b64ToStr` decodes with
 * `decodeURIComponent(escape(atob(b)))` — i.e. it expects the base64 to wrap the *UTF-8 encoding* of
 * the byte-string. So BOTH branches must `unescape(encodeURIComponent(...))` (latin1 → UTF-8) before
 * `btoa`. The previous ArrayBuffer branch base64'd the raw latin1 bytes directly, which made the
 * host's `decodeURIComponent` throw `URIError: URI malformed` on the first multi-byte/8-bit sequence
 * (constant for any colored TUI) — that swallowed throw is exactly why Driver B errored on device.
 * Round-trip verified: `decodeURIComponent(escape(atob(btoa(unescape(encodeURIComponent(s)))))) === s`.
 */
function bufToBase64(data: string | ArrayBuffer): string {
    if (typeof data === "string") {
        return globalThis.btoa(unescape(encodeURIComponent(data)));
    }

    const bytes = new Uint8Array(data);
    let binary = "";
    for (let i = 0; i < bytes.length; i++) {
        binary += String.fromCharCode(bytes[i]);
    }

    return globalThis.btoa(unescape(encodeURIComponent(binary)));
}

function base64ToBytes(b64: string): Uint8Array {
    const binary = globalThis.atob(b64);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
        out[i] = binary.charCodeAt(i);
    }

    return out;
}

export const WebViewHtmlRenderer = forwardRef<TerminalRenderer, TerminalDriverProps>(
    function WebViewHtmlRenderer({ session, callbacks }, ref) {
        const c = useThemeColors();
        const transport = useConnectionStore((s) => s.transport);
        const webRef = useRef<WebView>(null);
        const cbRef = useRef<TerminalCallbacks>(callbacks);
        cbRef.current = callbacks;

        const wsRef = useRef<TerminalTransport | null>(null);
        const readyRef = useRef(false);
        const [mountKey, setMountKey] = useState(0);
        const [active, setActive] = useState<TerminalSession | null>(session);
        const statusRef = useRef<TerminalStatus>("idle");

        const setStatus = useCallback((next: TerminalStatus, detail?: string) => {
            statusRef.current = next;
            cbRef.current.onStatus?.(next, detail);
        }, []);

        // Close the ttyd WS on unmount — important on a DRIVER SWITCH: the screen unmounts this
        // component and mounts the other driver, so without this the old socket would leak (the
        // parent attaches the new ref but can't detach the unmounted one).
        useEffect(() => {
            return () => {
                wsRef.current?.close();
                wsRef.current = null;
            };
        }, []);

        const run = useCallback((js: string) => {
            webRef.current?.injectJavaScript(js);
        }, []);

        const openSocket = useCallback(
            (sessionId: string) => {
                wsRef.current?.close();
                readyRef.current = false;

                if (!transport) {
                    setStatus("error", "no transport connected");
                    return;
                }

                setStatus("connecting");
                const ws = transport.openTerminal(sessionId);
                wsRef.current = ws;

                ws.onStatus((s) => {
                    if (s === "open") {
                        setStatus("connected");
                    } else if (s === "reconnecting") {
                        setStatus("connecting", "reconnecting");
                    } else if (s === "closed") {
                        setStatus("disconnected");
                    }
                });

                ws.onMessage((data) => {
                    const chunk = typeof data === "string" ? data : new Uint8Array(data);
                    if (chunk instanceof Uint8Array) {
                        cbRef.current.onData?.(chunk);
                    }

                    run(injectBytes(bufToBase64(data)));
                });
            },
            [transport, run, setStatus],
        );

        useImperativeHandle(
            ref,
            (): TerminalRenderer => ({
                get status() {
                    return statusRef.current;
                },
                async attach(next) {
                    setActive(next);
                    setMountKey((k) => k + 1); // fresh page; openSocket fires on the page's "ready"
                },
                async detach() {
                    wsRef.current?.close();
                    wsRef.current = null;
                    setActive(null);
                    setStatus("idle");
                },
                sendInput(text) {
                    wsRef.current?.send(text);
                },
                sendKey(key: TerminalKey, mods?: TerminalKeyMods) {
                    wsRef.current?.send(keyToBytes(key, mods));
                },
                paste(text) {
                    wsRef.current?.send(text);
                },
                scroll(lines) {
                    run(injectScroll(lines));
                },
                scrollPage(direction) {
                    run(injectScrollPage(direction));
                },
                fit() {
                    run(injectFit());
                },
                resize() {
                    run(injectFit());
                },
                focus() {
                    run(injectFocus());
                },
            }),
            [run, setStatus],
        );

        const handleMessage = useCallback(
            (event: WebViewMessageEvent) => {
                const msg = parseBridgeMsg(event.nativeEvent.data);
                if (!msg) {
                    return;
                }

                if (msg.t === "ready") {
                    readyRef.current = true;
                    if (active) {
                        openSocket(active.id);
                    }

                    return;
                }

                if (msg.t === "data" && msg.payload) {
                    // Page → ttyd: user keystrokes (base64) decoded back to bytes for the WS.
                    wsRef.current?.send(base64ToBytes(msg.payload).buffer as ArrayBuffer);
                    return;
                }

                if (msg.t === "selection" && msg.payload) {
                    cbRef.current.onSelection?.(msg.payload);
                }
            },
            [active, openSocket],
        );

        if (!active) {
            return <View testID="html-idle" style={{ flex: 1, backgroundColor: c.bgBase }} />;
        }

        return (
            <WebView
                key={mountKey}
                testID="html-webview"
                ref={webRef}
                source={{ html: XTERM_HOST_HTML }}
                originWhitelist={["*"]}
                javaScriptEnabled
                domStorageEnabled
                keyboardDisplayRequiresUserAction={false}
                hideKeyboardAccessoryView
                bounces={false}
                overScrollMode="never"
                automaticallyAdjustContentInsets={false}
                contentInsetAdjustmentBehavior="never"
                onError={() => setStatus("error", "WebView failed to load host page")}
                onContentProcessDidTerminate={() => {
                    cbRef.current.onExit?.("crash");
                    setStatus("disconnected", "content process crashed");
                    setMountKey((k) => k + 1); // remount → "ready" fires → openSocket re-attaches
                }}
                onMessage={handleMessage}
                style={{ flex: 1, backgroundColor: c.bgBase }}
            />
        );
    },
);

registerDriver({
    id: "webview-html",
    label: "xterm.js (WebView)",
    blurb: "Local xterm.js page + its own ttyd WebSocket (token in the subprotocol — no cookie needed).",
    component: WebViewHtmlRenderer,
});
