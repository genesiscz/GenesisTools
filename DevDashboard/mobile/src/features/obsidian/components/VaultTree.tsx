import type { VaultEntry } from "@dd/contract";
import { useMemo, useState } from "react";
import { FlatList, StyleSheet, TextInput, View } from "react-native";
import { VaultTreeNode } from "@/features/obsidian/components/VaultTreeNode";
import { filterVaultEntries } from "@/features/obsidian/vault-filter";
import { useThemeColors } from "@/theme/colors";

interface Props {
    entries: VaultEntry[];
    selected: string | null;
    expandedDirs: ReadonlySet<string>;
    onSelect: (relativePath: string) => void;
    onFolderToggle: (dir: string, expanded: boolean) => void;
}

/**
 * Recursive vault tree browser. The FlatList renders only top-level entries; each `VaultTreeNode`
 * renders its expanded children recursively (a plain View tree, matching the web `<ul>` recursion).
 * A personal vault is dozens-to-hundreds of nodes, so this is fine; a future task can flatten to a
 * single virtualized list if a vault ever gets huge. Typing in the search box force-opens every
 * folder so matches are visible (web parity).
 */
export function VaultTree({ entries, selected, expandedDirs, onSelect, onFolderToggle }: Props) {
    const c = useThemeColors();
    const [query, setQuery] = useState("");
    const filtered = useMemo(() => filterVaultEntries(entries, query), [entries, query]);
    const forceOpen = query.trim().length > 0;

    return (
        <View style={styles.fill}>
            <TextInput
                testID="obsidian-tree-search"
                accessibilityLabel="search notes"
                placeholder="Search notes"
                placeholderTextColor={c.textMuted}
                value={query}
                onChangeText={setQuery}
                style={[styles.search, { borderColor: c.border, color: c.textPrimary }]}
                autoCapitalize="none"
                autoCorrect={false}
            />
            <FlatList
                testID="obsidian-tree-list"
                data={filtered}
                keyExtractor={(item) => item.relativePath}
                renderItem={({ item }) => (
                    <VaultTreeNode
                        entry={item}
                        depth={0}
                        selected={selected}
                        expandedDirs={expandedDirs}
                        forceOpen={forceOpen}
                        onSelect={onSelect}
                        onFolderToggle={onFolderToggle}
                    />
                )}
                keyboardShouldPersistTaps="handled"
                style={styles.fill}
            />
        </View>
    );
}

const styles = StyleSheet.create({
    fill: { flex: 1 },
    search: {
        height: 36,
        marginBottom: 8,
        paddingHorizontal: 10,
        borderRadius: 8,
        borderWidth: 1,
        backgroundColor: "rgba(0,0,0,0.2)",
        fontSize: 13,
    },
});
