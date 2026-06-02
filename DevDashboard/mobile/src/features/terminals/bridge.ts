import { SafeJSON } from "@app/utils/json";

/**
 * RN ↔ WebView message protocol for Driver B (the local xterm.js host page). Cribbed from the
 * `@fressh/react-native-xtermjs-webview` pattern (MIT) — we copy the shape, not the dependency (its
 * peer pins conflict with SDK 55; see the terminals notes). Two directions:
 *
 *   RN → WebView: `injectBytes(b64)` dispatches a synthetic "message" event the host page listens
 *                 for and writes (base64) to `term.write`. WS frames are base64'd so binary survives
 *                 the string-only `injectJavaScript` bridge.
 *   WebView → RN: the host page posts a `BridgeMsg` via `window.ReactNativeWebView.postMessage`; the
 *                 renderer parses it in `onMessage`.
 */

export type BridgeMsgType = "data" | "ready" | "selection" | "resize";

export interface BridgeMsg {
    t: BridgeMsgType;
    /** base64 input bytes (t="data") or selected text (t="selection"). */
    payload?: string;
    /** terminal dimensions on t="resize"/"ready". */
    cols?: number;
    rows?: number;
}

/** RN → WebView: hand a base64 chunk of ttyd output to the host page's message listener. */
export function injectBytes(base64: string): string {
    return `window.dispatchEvent(new MessageEvent("message",{data:${SafeJSON.stringify(base64)}}));true;`;
}

/** RN → WebView: ask the host page to refit the terminal to the WebView's current size. */
export function injectFit(): string {
    return "window.__ddFit&&window.__ddFit();true;";
}

/** RN → WebView: scroll the host terminal's scrollback by `lines` (negative = older). */
export function injectScroll(lines: number): string {
    return `window.__ddScroll&&window.__ddScroll(${Math.trunc(lines)});true;`;
}

/** RN → WebView: scroll one visible page up (-1) or down (1). */
export function injectScrollPage(direction: -1 | 1): string {
    return `window.__ddScrollPage&&window.__ddScrollPage(${direction});true;`;
}

/** RN → WebView: focus the terminal so the iOS keyboard rises. */
export function injectFocus(): string {
    return "window.__ddFocus&&window.__ddFocus();true;";
}

/** Parse a WebView→RN message string into a typed `BridgeMsg` (null on malformed input). */
export function parseBridgeMsg(raw: string): BridgeMsg | null {
    try {
        const parsed = SafeJSON.parse(raw, { strict: true }) as Partial<BridgeMsg>;

        if (parsed && typeof parsed.t === "string") {
            return parsed as BridgeMsg;
        }

        return null;
    } catch {
        return null;
    }
}
