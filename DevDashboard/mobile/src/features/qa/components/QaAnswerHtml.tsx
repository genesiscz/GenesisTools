import { SafeJSON } from "@app/utils/json";
import { useMemo, useState } from "react";
import { StyleSheet, View } from "react-native";
import { WebView, type WebViewMessageEvent } from "react-native-webview";
import { buildNoteDocument } from "@/features/obsidian/note-html";
import { useThemeColors } from "@/theme/colors";

interface QaAnswerHtmlProps {
    /** Server-enriched answer HTML (`QaRow.answerHtml`) — the SAME fragment the web mirror renders. */
    html: string;
    /** Stable id for the `qa-answer-<id>` testID (parity with the plain-text answer). */
    testID: string;
}

/**
 * Renders a Q&A answer as rich, web-parity HTML inside a `WebView`, reusing `buildNoteDocument` so the
 * dark "Obsidian Terminal" theme + highlight.js / KaTeX / mermaid render identically to the web
 * dashboard — with zero new dependencies (react-native-webview already powers the Obsidian note
 * viewer). A WebView is heavy, so `QaCard` mounts this ONLY when the card is expanded; collapsed cards
 * stay a plain-text preview.
 *
 * The view is sized to its content: a reporter posts `document.body.scrollHeight` after load and on
 * resize, and we grow the container to that height so the answer lays out inside the FlatList card
 * (the WebView itself never scrolls). Mirrors the WebView conventions of `NoteRenderer`.
 */

const HEIGHT_REPORTER = `
(function () {
    function report() {
        var h = Math.ceil(
            Math.max(
                document.body ? document.body.scrollHeight : 0,
                document.documentElement ? document.documentElement.scrollHeight : 0,
            ),
        );
        if (window.ReactNativeWebView && window.ReactNativeWebView.postMessage) {
            window.ReactNativeWebView.postMessage(JSON.stringify({ type: "qa-height", height: h }));
        }
    }
    report();
    window.addEventListener("load", report);
    if (window.ResizeObserver) {
        new ResizeObserver(report).observe(document.body);
    }
    // Re-measure after async assets (hljs / katex / mermaid) settle.
    setTimeout(report, 300);
    setTimeout(report, 1200);
    true;
})();
`;

const MIN_HEIGHT = 36;

/** Narrows the bridge's `{ type: "qa-height", height }` payload without an `as` cast. */
function parseHeight(raw: string): number | null {
    let data: unknown;

    try {
        data = SafeJSON.parse(raw, { strict: true });
    } catch {
        return null;
    }

    if (typeof data !== "object" || data === null) {
        return null;
    }

    const obj = data as Record<string, unknown>;

    if (obj.type === "qa-height" && typeof obj.height === "number" && obj.height > 0) {
        return obj.height;
    }

    return null;
}

export function QaAnswerHtml({ html, testID }: QaAnswerHtmlProps) {
    const c = useThemeColors();
    const [height, setHeight] = useState(MIN_HEIGHT);

    const source = useMemo(() => ({ html: buildNoteDocument(html) }), [html]);

    const onMessage = useMemo(
        () => (event: WebViewMessageEvent) => {
            const reported = parseHeight(event.nativeEvent.data);
            if (reported === null) {
                return;
            }

            setHeight(Math.max(MIN_HEIGHT, Math.ceil(reported)));
        },
        [],
    );

    return (
        <View testID={testID} accessibilityLabel={testID} style={[styles.container, { height }]}>
            <WebView
                testID={`${testID}-webview`}
                originWhitelist={["*"]}
                source={source}
                injectedJavaScript={HEIGHT_REPORTER}
                onMessage={onMessage}
                javaScriptEnabled
                domStorageEnabled={false}
                scrollEnabled={false}
                showsVerticalScrollIndicator={false}
                setBuiltInZoomControls={false}
                style={[styles.webview, { backgroundColor: c.bgBase }]}
                containerStyle={{ backgroundColor: c.bgBase }}
            />
        </View>
    );
}

const styles = StyleSheet.create({
    container: { overflow: "hidden" },
    webview: { flex: 1, backgroundColor: "transparent" },
});
