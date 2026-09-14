import { Feather } from "@expo/vector-icons";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useCallback, useMemo, useState } from "react";
import { Modal, Pressable, StyleSheet, Text, View, useWindowDimensions } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { NewFolderModal } from "@/features/obsidian/components/NewFolderModal";
import { NoteReader } from "@/features/obsidian/components/NoteReader";
import { VaultTree } from "@/features/obsidian/components/VaultTree";
import {
    expandedDirsForFolderToggle,
    expandedDirsForNote,
    parseOpenDirs,
    serializeOpenDirs,
} from "@/features/obsidian/expanded-dirs";
import { useMkdir, useVaultTree } from "@/features/obsidian/hooks";
import { MockBadge } from "@/ui/MockBadge";
import { useThemeColors } from "@/theme/colors";

/**
 * Obsidian feature route — a vault tree browser + a note reader, mirroring the web `/obsidian` route.
 * State (selected note, expanded folders) syncs through expo-router params (`note`, `open`) — exact
 * parity with the web TanStack-Router `?note=&open=` search params, so a tab switch or deep link
 * restores the view. Responsive: a side-by-side split on wide screens, a bottom-sheet vault browser
 * on phones. Data flows only through the D32 hooks (`useVaultTree`/`useNote`/mutations) — no raw
 * `useQuery` and no hardcoded `/api/...` strings (see `features/obsidian/{queries,hooks}.ts`).
 */
export default function ObsidianScreen() {
    const c = useThemeColors();
    const router = useRouter();
    const insets = useSafeAreaInsets();
    const params = useLocalSearchParams<{ note?: string; open?: string }>();
    const { width } = useWindowDimensions();
    const isWide = width >= 768;

    const note = typeof params.note === "string" ? params.note : null;
    const openParam = typeof params.open === "string" ? params.open : undefined;

    const { data, error } = useVaultTree();
    const mkdir = useMkdir();

    const [browserOpen, setBrowserOpen] = useState(false);
    const [newFolderOpen, setNewFolderOpen] = useState(false);

    const openDirs = useMemo(() => parseOpenDirs(openParam), [openParam]);
    const displayOpenDirs = useMemo(() => {
        if (!note) {
            return openDirs;
        }

        return expandedDirsForNote(note, openDirs);
    }, [note, openDirs]);

    const pushSearch = useCallback(
        (next: { note?: string | null; open?: Set<string> }) => {
            const nextNote = next.note !== undefined ? next.note : note;
            const nextOpen = serializeOpenDirs(next.open ?? openDirs);
            router.setParams({
                note: nextNote ?? undefined,
                open: nextOpen || undefined,
            });
        },
        [note, openDirs, router],
    );

    const onFolderToggle = useCallback(
        (dir: string, expanded: boolean) => {
            pushSearch({ open: expandedDirsForFolderToggle(dir, expanded, openDirs) });
        },
        [openDirs, pushSearch],
    );

    const onSelectNote = useCallback(
        (path: string) => {
            pushSearch({ note: path, open: expandedDirsForNote(path, openDirs) });

            if (!isWide) {
                setBrowserOpen(false);
            }
        },
        [isWide, openDirs, pushSearch],
    );

    const tree = data ? (
        <VaultTree
            entries={data.entries}
            selected={note}
            expandedDirs={displayOpenDirs}
            onSelect={onSelectNote}
            onFolderToggle={onFolderToggle}
        />
    ) : (
        <Text style={[styles.muted, { color: c.textMuted }]} testID="obsidian-tree-status">
            {error instanceof Error ? error.message : "Loading vault..."}
        </Text>
    );

    const reader = note ? (
        <NoteReader path={note} onOpenNote={onSelectNote} />
    ) : (
        <View style={styles.placeholder} testID="obsidian-empty">
            <Text style={[styles.muted, { color: c.textMuted }]}>
                {isWide ? "Pick a note on the left." : "Pick a note below to start reading."}
            </Text>
        </View>
    );

    const newFolderModal = (
        <NewFolderModal
            visible={newFolderOpen}
            parentDir=""
            submitting={mkdir.isPending}
            onClose={() => setNewFolderOpen(false)}
            onCreate={(relativeDir) =>
                mkdir.mutate(relativeDir, {
                    onSuccess: () => setNewFolderOpen(false),
                })
            }
        />
    );

    if (isWide) {
        return (
            <View
                style={[styles.wide, { backgroundColor: c.bgBase, paddingTop: insets.top + 8 }]}
                testID="screen-obsidian"
                accessibilityLabel="screen-obsidian"
            >
                <View style={[styles.sidebar, { backgroundColor: c.bgPanel, borderColor: c.border }]}>
                    <View style={styles.sidebarHeader}>
                        <Text style={[styles.sidebarTitle, { color: c.textPrimary }]}>Vault</Text>
                        <Pressable
                            testID="obsidian-add-folder"
                            accessibilityLabel="new folder"
                            onPress={() => setNewFolderOpen(true)}
                        >
                            <Feather name="folder-plus" size={16} color={c.textSecondary} />
                        </Pressable>
                    </View>
                    <MockBadge />
                    {tree}
                </View>
                <View style={[styles.main, { backgroundColor: c.bgPanel, borderColor: c.border }]}>{reader}</View>
                {newFolderModal}
            </View>
        );
    }

    return (
        <View
            style={[styles.narrow, { backgroundColor: c.bgBase, paddingTop: insets.top + 8 }]}
            testID="screen-obsidian"
            accessibilityLabel="screen-obsidian"
        >
            <View style={[styles.bar, { backgroundColor: c.bgPanel, borderColor: c.border }]}>
                <Pressable
                    testID="obsidian-open-browser"
                    accessibilityLabel="open vault browser"
                    accessibilityState={{ expanded: browserOpen }}
                    style={styles.barBtn}
                    onPress={() => setBrowserOpen(true)}
                >
                    <Feather name="folder" size={14} color={c.textSecondary} />
                    <Text style={[styles.barLabel, { color: c.textPrimary }]}>Vault</Text>
                </Pressable>
                <Text style={[styles.barNote, { color: c.textMuted }]} numberOfLines={1}>
                    {note ? note.split("/").pop() : "No note selected"}
                </Text>
                {note ? (
                    <Pressable
                        testID="obsidian-add-folder"
                        accessibilityLabel="new folder"
                        onPress={() => setNewFolderOpen(true)}
                    >
                        <Feather name="folder-plus" size={16} color={c.textSecondary} />
                    </Pressable>
                ) : null}
            </View>
            {/*
             * Discovery fix: when no note is selected on a phone, render the vault tree INLINE in the
             * body (the primary way to find a note) instead of an empty "open the browser" placeholder
             * — that placeholder made the screen look like it had loaded nothing. The modal browser
             * (obsidian-open-browser) stays as the way to switch notes once one is open.
             */}
            <View style={[styles.main, { backgroundColor: c.bgPanel, borderColor: c.border }]}>
                {note ? (
                    reader
                ) : browserOpen ? (
                    <View style={styles.placeholder} testID="obsidian-empty">
                        <Text style={[styles.muted, { color: c.textMuted }]}>Pick a note in the browser.</Text>
                    </View>
                ) : (
                    <View style={styles.inlineTree}>
                        <MockBadge />
                        {tree}
                    </View>
                )}
            </View>

            <Modal
                visible={browserOpen}
                animationType="slide"
                transparent
                onRequestClose={() => setBrowserOpen(false)}
            >
                <View style={styles.sheetBackdrop}>
                    <View
                        style={[styles.sheet, { backgroundColor: c.bgPanel, borderColor: c.border }]}
                        testID="obsidian-vault-browser"
                    >
                        <View style={styles.sheetHeader}>
                            <Text style={[styles.sidebarTitle, { color: c.textPrimary }]}>Browse vault</Text>
                            <View style={styles.headerRow}>
                                <Pressable
                                    testID="obsidian-add-folder"
                                    accessibilityLabel="new folder"
                                    onPress={() => setNewFolderOpen(true)}
                                >
                                    <Feather name="folder-plus" size={16} color={c.textSecondary} />
                                </Pressable>
                                <Pressable
                                    testID="obsidian-close-browser"
                                    accessibilityLabel="close vault browser"
                                    onPress={() => setBrowserOpen(false)}
                                >
                                    <Feather name="x" size={16} color={c.textSecondary} />
                                </Pressable>
                            </View>
                        </View>
                        <MockBadge />
                        <View style={styles.sheetBody}>{tree}</View>
                    </View>
                </View>
            </Modal>
            {newFolderModal}
        </View>
    );
}

const styles = StyleSheet.create({
    wide: { flex: 1, flexDirection: "row", padding: 8, gap: 8 },
    sidebar: { width: 260, borderRadius: 10, borderWidth: 1, padding: 8 },
    sidebarHeader: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 8 },
    sidebarTitle: { fontSize: 13, fontWeight: "600" },
    main: { flex: 1, borderRadius: 10, overflow: "hidden", borderWidth: 1 },
    narrow: { flex: 1, padding: 8, gap: 8 },
    bar: {
        flexDirection: "row",
        alignItems: "center",
        gap: 10,
        borderRadius: 10,
        borderWidth: 1,
        paddingHorizontal: 10,
        paddingVertical: 8,
    },
    barBtn: { flexDirection: "row", alignItems: "center", gap: 6 },
    barLabel: { fontSize: 13, fontWeight: "600" },
    barNote: { flex: 1, fontFamily: "monospace", fontSize: 11 },
    placeholder: { flex: 1, alignItems: "center", justifyContent: "center", padding: 16 },
    inlineTree: { flex: 1, padding: 8, gap: 8 },
    muted: { fontFamily: "monospace", fontSize: 12 },
    sheetBackdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.55)", justifyContent: "flex-end" },
    sheet: {
        maxHeight: "80%",
        borderTopLeftRadius: 16,
        borderTopRightRadius: 16,
        borderWidth: 1,
        padding: 12,
    },
    sheetHeader: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 8 },
    headerRow: { flexDirection: "row", alignItems: "center", gap: 14 },
    sheetBody: { flex: 1, minHeight: 240 },
});
