import { forwardRef, useCallback, useImperativeHandle, useRef, useState } from "react";
import { View } from "react-native";
import { WebView, type WebViewMessageEvent } from "react-native-webview";
import {
    injectKey,
    injectText,
    injectTtydFocus,
    injectTtydScroll,
    injectTtydScrollPage,
} from "@/features/terminals/inject";
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
import { useConnection } from "@/state/connection";
import { useThemeColors } from "@/theme/colors";

/**
 * Driver A (D12): a `<WebView>` pointed at the Agent's existing `/ttyd/<id>/` URL. ttyd renders the
 * live xterm.js terminal server-side; we drive keys/scroll by injecting JS against the page's own
 * `.xterm-helper-textarea` (see `inject.ts`) and inherit the server's `injectTtydMobileShell`
 * scroll helpers.
 *
 * #3863 mitigation (the iOS New-Arch `source`-prop-not-forwarded bug): we use the plan-06
 * **remount-via-key** strategy — `attach()` bumps a `mountKey`, forcing a FRESH WebView mount (the
 * bug only bites the update path, not initial mount). The native `#3880` patch (see
 * `patches/react-native-webview@13.16.0.patch`) belt-and-suspenders the update path too.
 *
 * Auth: ttyd's WS is normally gated by the `dd_session` cookie. The plan called for
 * `@react-native-cookies/cookies` to plant it natively — that is a NEW native lib (D20: ask first),
 * so it is NOT added here. Best-effort cookie plant uses `sharedCookiesEnabled` + an
 * `injectedJavaScriptBeforeContentLoaded` `document.cookie` write (works for a non-HttpOnly cookie /
 * shared cookie store). If cold-launch cookie auth fails on device, **Driver B is the robust
 * fallback** (token in the WS subprotocol, no cookie) — flip the in-app switcher. Flagged in the
 * terminals notes as device-only + the cookie-module deferral.
 */

const WEBVIEW_PROPS = {
    keyboardDisplayRequiresUserAction: false,
    hideKeyboardAccessoryView: true,
    sharedCookiesEnabled: true,
    thirdPartyCookiesEnabled: true,
    domStorageEnabled: true,
    originWhitelist: ["*"],
    bounces: false,
    overScrollMode: "never" as const,
    automaticallyAdjustContentInsets: false,
    contentInsetAdjustmentBehavior: "never" as const,
    javaScriptEnabled: true,
};

function ttydUrl(baseUrl: string, sessionId: string): string {
    return `${baseUrl.replace(/\/$/, "")}/ttyd/${sessionId}/`;
}

/** Best-effort, non-native cookie plant: write `dd_session` before content loads (non-HttpOnly only). */
function cookiePlantJs(cookie: string | null): string {
    if (!cookie) {
        return "true;";
    }

    return `document.cookie=${JSON.stringify(`dd_session=${cookie}; path=/`)};true;`;
}

export const WebViewTtydRenderer = forwardRef<TerminalRenderer, TerminalDriverProps>(
    function WebViewTtydRenderer({ session, callbacks }, ref) {
        const c = useThemeColors();
        const baseUrl = useConnection((s) => s.baseUrl);
        const webRef = useRef<WebView>(null);
        const cbRef = useRef<TerminalCallbacks>(callbacks);
        cbRef.current = callbacks;

        const [mountKey, setMountKey] = useState(0);
        const [active, setActive] = useState<TerminalSession | null>(session);
        const statusRef = useRef<TerminalStatus>("idle");

        const setStatus = useCallback((next: TerminalStatus, detail?: string) => {
            statusRef.current = next;
            cbRef.current.onStatus?.(next, detail);
        }, []);

        const run = useCallback((js: string) => {
            webRef.current?.injectJavaScript(js);
        }, []);

        useImperativeHandle(
            ref,
            (): TerminalRenderer => ({
                get status() {
                    return statusRef.current;
                },
                async attach(next, cb) {
                    cbRef.current = cb;
                    setActive(next);
                    setStatus("connecting");
                    // Remount-via-key: a fresh initial mount sidesteps the #3863 update-path bug.
                    setMountKey((k) => k + 1);
                },
                async detach() {
                    setActive(null);
                    setStatus("idle");
                },
                sendInput(text) {
                    run(injectText(text));
                },
                sendKey(key: TerminalKey, mods?: TerminalKeyMods) {
                    run(injectKey(key, mods));
                },
                paste(text) {
                    run(injectText(text));
                },
                scroll(lines) {
                    run(injectTtydScroll(lines));
                },
                scrollPage(direction) {
                    run(injectTtydScrollPage(direction));
                },
                fit() {
                    // ttyd fits itself to its viewport; nothing to do for Driver A.
                },
                resize() {
                    // ttyd handles its own resize via the WS; no-op here.
                },
                focus() {
                    run(injectTtydFocus());
                },
            }),
            [run, setStatus],
        );

        const handleMessage = useCallback((event: WebViewMessageEvent) => {
            // ttyd doesn't post selection back by default; reserved for future selection capture.
            void event.nativeEvent.data;
        }, []);

        // NON-FUNCTIONAL AUTH (flagged): the real `dd_session` cookie is minted HttpOnly by the
        // proxy, so it can't be set from JS, and `injectedJavaScriptBeforeContentLoaded` runs after
        // navigation begins anyway — too late for the initial WS handshake. Planting it properly
        // needs either `@react-native-cookies/cookies` (a NEW native lib, D20: ask first) or the
        // RNCWebView `basicAuthCredential` prop (no new lib — device follow-up). Until then Driver A
        // has no working cold-launch auth; Driver B (cookie-free WS subprotocol) is the robust path.
        const authCookie: string | null = null;

        if (!active || !baseUrl) {
            return <View testID="ttyd-idle" style={{ flex: 1, backgroundColor: c.bgBase }} />;
        }

        return (
            <WebView
                key={mountKey}
                testID="ttyd-webview"
                ref={webRef}
                source={{ uri: ttydUrl(baseUrl, active.id) }}
                injectedJavaScriptBeforeContentLoaded={cookiePlantJs(authCookie)}
                onLoadEnd={() => setStatus("connected")}
                onError={() => setStatus("error", "WebView failed to load ttyd")}
                onContentProcessDidTerminate={() => {
                    cbRef.current.onExit?.("crash");
                    setStatus("disconnected", "content process crashed");
                    setMountKey((k) => k + 1); // auto-remount + reload re-attaches the ttyd session
                }}
                onMessage={handleMessage}
                style={{ flex: 1, backgroundColor: c.bgBase }}
                {...WEBVIEW_PROPS}
            />
        );
    },
);

registerDriver({
    id: "webview-ttyd",
    label: "ttyd (WebView)",
    blurb: "Loads the agent's ttyd page directly. Lowest setup; inherits the server's mobile shell.",
    component: WebViewTtydRenderer,
});
