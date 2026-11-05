import { Stack } from "expo-router";
import { useState } from "react";
import { Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { useClipLink } from "@/features/vault/hooks";
import { looksLikeLink } from "@/features/vault/queries";
import { MockBadge } from "@/ui/MockBadge";
import { SectionHeader } from "@/ui/SectionHeader";
import { useThemeColors } from "@/theme/colors";

/**
 * Send to my vault (F25): paste a link and the Mac files it into the vault's inbox note of the day, a page as clean
 * Markdown with its source, a video queued for transcription. Saving a Q→A answer is on each card of the QA tab.
 */
export default function VaultScreen() {
    const c = useThemeColors();
    const [url, setUrl] = useState("");
    const [note, setNote] = useState("");
    const clip = useClipLink();
    const ready = looksLikeLink(url) && !clip.isPending;
    const input = { color: c.textPrimary, backgroundColor: c.bgPanel, borderWidth: 1, borderColor: c.border } as const;

    return (
        <>
            <Stack.Screen options={{ title: "Send to vault" }} />
            <ScrollView
                testID="screen-vault"
                accessibilityLabel="screen-vault"
                className="flex-1 bg-dd-bg-base"
                contentInsetAdjustmentBehavior="automatic"
                keyboardShouldPersistTaps="handled"
                contentContainerClassName="gap-4 p-4"
            >
                <MockBadge />
                <View className="gap-2">
                    <SectionHeader title="Link" />
                    <TextInput
                        testID="vault-url"
                        value={url}
                        onChangeText={setUrl}
                        placeholder="https://…"
                        placeholderTextColor={c.textMuted}
                        autoCapitalize="none"
                        autoCorrect={false}
                        keyboardType="url"
                        className="rounded-xl px-3 py-2.5"
                        style={input}
                    />
                </View>
                <View className="gap-2">
                    <SectionHeader title="Note" />
                    <TextInput
                        testID="vault-note"
                        value={note}
                        onChangeText={setNote}
                        placeholder="Optional: why you keep it"
                        placeholderTextColor={c.textMuted}
                        multiline
                        className="min-h-16 rounded-xl px-3 py-2.5"
                        style={{ ...input, textAlignVertical: "top" }}
                    />
                </View>
                <Pressable
                    testID="vault-clip"
                    accessibilityRole="button"
                    disabled={!ready}
                    onPress={() => clip.mutate({ url: url.trim(), note: note.trim() || undefined })}
                    className="items-center rounded-xl py-3"
                    style={{ backgroundColor: c.accent, opacity: ready ? 1 : 0.4 }}
                >
                    <Text style={{ color: c.bgBase, fontWeight: "700" }}>{clip.isPending ? "Clipping…" : "Clip to the vault"}</Text>
                </Pressable>
                {clip.data ? (
                    <Text testID="vault-receipt" style={{ color: clip.data.error ? c.danger : c.accent, fontSize: 13 }}>
                        {clip.data.error ??
                            `${clip.data.kind === "video" ? "Video queued" : `Clipped ${clip.data.title ?? "the page"}`} into ${clip.data.note}`}
                    </Text>
                ) : null}
                {clip.isError ? <Text style={{ color: c.danger }}>{String(clip.error)}</Text> : null}
            </ScrollView>
        </>
    );
}
