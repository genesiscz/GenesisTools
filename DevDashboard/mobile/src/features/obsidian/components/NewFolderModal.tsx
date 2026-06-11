import { useState } from "react";
import { Modal, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { useThemeColors } from "@/theme/colors";

interface Props {
    visible: boolean;
    /** The folder the new dir is created under ("" = vault root). */
    parentDir: string;
    submitting: boolean;
    onClose: () => void;
    onCreate: (relativeDir: string) => void;
}

export function NewFolderModal({ visible, parentDir, submitting, onClose, onCreate }: Props) {
    const c = useThemeColors();
    const [name, setName] = useState("");

    const submit = (): void => {
        const trimmed = name.trim();

        if (!trimmed) {
            return;
        }

        const relativeDir = parentDir ? `${parentDir}/${trimmed}` : trimmed;
        onCreate(relativeDir);
        setName("");
    };

    return (
        <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
            <Pressable style={styles.backdrop} onPress={onClose}>
                <Pressable
                    style={[styles.card, { backgroundColor: c.bgPanel, borderColor: c.border }]}
                    onPress={(event) => event.stopPropagation()}
                >
                    <Text style={[styles.title, { color: c.textPrimary }]}>New folder</Text>
                    {parentDir ? <Text style={[styles.parent, { color: c.textMuted }]}>{`in ${parentDir}`}</Text> : null}
                    <TextInput
                        testID="obsidian-new-folder-input"
                        accessibilityLabel="new folder name"
                        placeholder="folder-name"
                        placeholderTextColor={c.textMuted}
                        value={name}
                        onChangeText={setName}
                        autoFocus
                        autoCapitalize="none"
                        autoCorrect={false}
                        style={[styles.input, { borderColor: c.border, color: c.textPrimary }]}
                        onSubmitEditing={submit}
                    />
                    <View style={styles.actions}>
                        <Pressable testID="obsidian-new-folder-cancel" style={styles.btn} onPress={onClose}>
                            <Text style={[styles.btnText, { color: c.textSecondary }]}>Cancel</Text>
                        </Pressable>
                        <Pressable
                            testID="obsidian-new-folder-create"
                            accessibilityLabel="create folder"
                            style={[styles.btn, { backgroundColor: c.accent }]}
                            disabled={submitting || !name.trim()}
                            onPress={submit}
                        >
                            <Text style={[styles.btnText, { color: c.bgBase }]}>
                                {submitting ? "Creating..." : "Create"}
                            </Text>
                        </Pressable>
                    </View>
                </Pressable>
            </Pressable>
        </Modal>
    );
}

const styles = StyleSheet.create({
    backdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.6)", justifyContent: "center", padding: 24 },
    card: { borderRadius: 12, borderWidth: 1, padding: 16, gap: 10 },
    title: { fontSize: 15, fontWeight: "600" },
    parent: { fontSize: 12, fontFamily: "monospace" },
    input: {
        height: 40,
        paddingHorizontal: 10,
        borderRadius: 8,
        borderWidth: 1,
        backgroundColor: "rgba(0,0,0,0.25)",
    },
    actions: { flexDirection: "row", justifyContent: "flex-end", gap: 8 },
    btn: { paddingVertical: 8, paddingHorizontal: 14, borderRadius: 8 },
    btnText: { fontWeight: "600" },
});
