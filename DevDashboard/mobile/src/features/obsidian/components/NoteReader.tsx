import { Feather } from "@expo/vector-icons";
import { openBrowserAsync } from "expo-web-browser";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import { WebViewNoteRenderer } from "@/features/obsidian/components/NoteRenderer";
import { useNote, usePublishNote, useUnpublishNote } from "@/features/obsidian/hooks";
import { shareUrl } from "@/features/obsidian/note-html";
import { useConnection } from "@/state/connection";
import { useThemeColors } from "@/theme/colors";

interface Props {
    path: string;
    onOpenNote: (path: string) => void;
}

/**
 * Note reader: a header (note path, publish/unpublish, share-slug surface) + the WebView body. When
 * `publishedSlug` is set the header shows the public `<baseUrl>/share/<slug>` (tap to open in the
 * system browser; long-press the URL text to copy) + an unpublish control; otherwise it shows a
 * publish control. Mutations invalidate the note query so the controls flip after publish/unpublish.
 *
 * Clipboard note: one-tap copy would want `expo-clipboard` (a NEW lib — flagged in the impl notes,
 * not added unilaterally per D20). v1 ships the URL as selectable text (long-press → copy) which is
 * zero new deps; promote to `Clipboard.setStringAsync` once the lib is approved.
 */
export function NoteReader({ path, onOpenNote }: Props) {
    const c = useThemeColors();
    const baseUrl = useConnection((s) => s.baseUrl);
    const { data, isPending, isError } = useNote(path);
    const publish = usePublishNote(path);
    const unpublish = useUnpublishNote(path);

    if (isPending) {
        return (
            <View style={[styles.center, { backgroundColor: c.bgBase }]} testID="obsidian-reader-loading">
                <ActivityIndicator color={c.accent} />
            </View>
        );
    }

    if (isError || !data) {
        return (
            <View style={[styles.center, { backgroundColor: c.bgBase }]} testID="obsidian-reader-error">
                <Text style={{ color: c.textMuted, fontFamily: "monospace" }}>Failed to load note.</Text>
            </View>
        );
    }

    const url = shareUrl(baseUrl ?? "", data.publishedSlug);

    return (
        <View style={[styles.fill, { backgroundColor: c.bgBase }]} testID="obsidian-reader">
            <View style={[styles.header, { borderBottomColor: c.border }]}>
                <Text style={[styles.path, { color: c.textSecondary }]} numberOfLines={1} testID="obsidian-reader-path">
                    {path}
                </Text>
                {url ? (
                    <View style={styles.headerActions}>
                        <Pressable
                            testID="obsidian-share-open"
                            accessibilityLabel="open share link"
                            style={[styles.iconBtn, { borderColor: c.border }]}
                            onPress={() => {
                                openBrowserAsync(url).catch((err) => {
                                    // User dismissed the in-app browser, or the scheme is unsupported.
                                    // Not an app error — the URL stays visible/selectable for manual copy.
                                    console.warn("obsidian: open share link failed", err);
                                });
                            }}
                        >
                            <Feather name="globe" size={13} color={c.textSecondary} />
                            <Text
                                testID="obsidian-share-url"
                                selectable
                                style={[styles.btnLabel, { color: c.textSecondary }]}
                                numberOfLines={1}
                            >
                                {url}
                            </Text>
                        </Pressable>
                        <Pressable
                            testID="obsidian-unpublish"
                            accessibilityLabel="unpublish note"
                            style={[styles.iconBtn, { borderColor: c.border }]}
                            disabled={unpublish.isPending}
                            onPress={() => {
                                if (data.publishedSlug) {
                                    unpublish.mutate(data.publishedSlug);
                                }
                            }}
                        >
                            <Feather name="lock" size={13} color={c.textSecondary} />
                            <Text style={[styles.btnLabel, { color: c.textSecondary }]}>
                                {unpublish.isPending ? "..." : "unpublish"}
                            </Text>
                        </Pressable>
                    </View>
                ) : (
                    <Pressable
                        testID="obsidian-publish"
                        accessibilityLabel="publish note"
                        style={[styles.iconBtn, { borderColor: c.border }]}
                        disabled={publish.isPending}
                        onPress={() => publish.mutate()}
                    >
                        <Feather name="globe" size={13} color={c.textSecondary} />
                        <Text style={[styles.btnLabel, { color: c.textSecondary }]}>
                            {publish.isPending ? "..." : "publish"}
                        </Text>
                    </Pressable>
                )}
            </View>
            <WebViewNoteRenderer
                // Force a fresh renderer per note: the WebView's `firstLoadConsumed` ref persists across
                // a bare `html`-prop change, which would make `onShouldStartLoadWithRequest` block every
                // note after the first (the reload isn't the "first load" anymore). Re-keying on `path`
                // resets that ref and discards stale WKWebView internal state.
                key={path}
                html={data.html}
                baseUrl={baseUrl ?? ""}
                onOpenNote={onOpenNote}
                onOpenExternal={(externalUrl) => {
                    openBrowserAsync(externalUrl).catch((err) => {
                        // Cancelled or unsupported scheme — safe to ignore visually, but log it.
                        console.warn("obsidian: open external link failed", err);
                    });
                }}
            />
        </View>
    );
}

const styles = StyleSheet.create({
    fill: { flex: 1 },
    center: { flex: 1, alignItems: "center", justifyContent: "center" },
    header: {
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 8,
        paddingHorizontal: 12,
        paddingVertical: 8,
        borderBottomWidth: 1,
    },
    path: { flex: 1, fontFamily: "monospace", fontSize: 11 },
    headerActions: { flexDirection: "row", alignItems: "center", gap: 8, flexShrink: 1 },
    iconBtn: {
        flexDirection: "row",
        alignItems: "center",
        gap: 5,
        paddingVertical: 5,
        paddingHorizontal: 9,
        borderRadius: 7,
        borderWidth: 1,
        flexShrink: 1,
    },
    btnLabel: { fontSize: 11, flexShrink: 1 },
});
