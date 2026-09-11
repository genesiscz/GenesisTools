import { useEffect, useMemo, useRef } from "react";
import { StyleSheet, View } from "react-native";
import { WebView, type WebViewMessageEvent } from "react-native-webview";
import {
    buildNoteDocument,
    NOTE_ASSET_URLS,
    type NoteMessage,
    parseNoteMessage,
} from "@/features/obsidian/note-html";
import { useThemeColors } from "@/theme/colors";

export interface NoteRendererProps {
    /** Server-rendered, sanitized HTML fragment (RenderedNote.html). */
    html: string;
    /** Transport base URL — so relative image/asset paths resolve and links can open. */
    baseUrl: string;
    /** Tapped a `data-obsidian-note` wikilink — route to that note. */
    onOpenNote: (path: string) => void;
    /** Tapped an external http(s) link — open in the system browser. */
    onOpenExternal: (url: string) => void;
}

/**
 * NoteRenderer contract: render a note for reading. v1 ships the WebView driver only — it renders the
 * server's already-rendered `html` (path (a) of the renderer decision; no native markdown re-parse,
 * no new markdown lib). A future native driver (e.g. react-native-enriched-markdown) can implement the
 * same `NoteRendererProps` without touching the screen.
 */
export function WebViewNoteRenderer({ html, baseUrl, onOpenNote, onOpenExternal }: NoteRendererProps) {
    const c = useThemeColors();
    const document = useMemo(() => buildNoteDocument(html), [html]);
    // The first navigation is the HTML-string load itself. On iOS `loadHTMLString:baseURL:` sets that
    // navigation's URL to `baseUrl` (an http URL) — NOT `about:blank` — so we cannot key the
    // allow-decision off the URL. Instead we allow exactly the first load, then intercept the rest.
    const firstLoadConsumed = useRef(false);

    // Reset per document. A new `html` prop starts a new main-frame load, and without this the ref is
    // still consumed from the previous one, so the renderer blocks its own reload and shows a blank
    // WebView. The `key={path}` at the NoteReader call site worked around it from the outside.
    useEffect(() => {
        firstLoadConsumed.current = false;
    }, [document]);

    const onMessage = (event: WebViewMessageEvent): void => {
        const message: NoteMessage | null = parseNoteMessage(event.nativeEvent.data);

        if (!message) {
            return;
        }

        if (message.type === "note") {
            onOpenNote(message.path);
            return;
        }

        onOpenExternal(message.url);
    };

    return (
        <View style={[styles.fill, { backgroundColor: c.bgBase }]} testID="obsidian-note-webview-wrap">
            <WebView
                testID="obsidian-note-webview"
                originWhitelist={["*"]}
                source={{ html: document, baseUrl }}
                onMessage={onMessage}
                onShouldStartLoadWithRequest={(request) => {
                    // Allow the initial HTML-string load (its URL is the baseUrl on iOS) exactly once.
                    if (!firstLoadConsumed.current) {
                        firstLoadConsumed.current = true;
                        return true;
                    }

                    // The three pinned subresources (katex.css / hljs theme / mermaid module) must load
                    // too — matched exactly, so the rest of the CDN host stays blocked.
                    if (NOTE_ASSET_URLS.has(request.url)) {
                        return true;
                    }

                    // Everything else is a link click — the in-page bridge already preventDefault'd it
                    // and posted to native; block the WebView from navigating away.
                    return false;
                }}
                scrollEnabled
                showsVerticalScrollIndicator
                javaScriptEnabled
                domStorageEnabled={false}
                setSupportMultipleWindows={false}
                style={[styles.fill, { backgroundColor: c.bgBase }]}
            />
        </View>
    );
}

const styles = StyleSheet.create({
    fill: { flex: 1 },
});
