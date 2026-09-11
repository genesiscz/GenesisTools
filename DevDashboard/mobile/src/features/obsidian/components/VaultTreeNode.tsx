import { Feather } from "@expo/vector-icons";
import type { VaultEntry } from "@dd/contract";
import { memo } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { useThemeColors } from "@/theme/colors";

interface Props {
    entry: VaultEntry;
    depth: number;
    selected: string | null;
    expandedDirs: ReadonlySet<string>;
    forceOpen: boolean;
    onSelect: (relativePath: string) => void;
    onFolderToggle: (dir: string, expanded: boolean) => void;
}

function VaultTreeNodeImpl({ entry, depth, selected, expandedDirs, forceOpen, onSelect, onFolderToggle }: Props) {
    const c = useThemeColors();
    const indent = { paddingLeft: 8 + depth * 14 };

    if (entry.isDirectory) {
        const expanded = forceOpen || expandedDirs.has(entry.relativePath);

        return (
            <View>
                <Pressable
                    testID={`obsidian-folder-${entry.relativePath}`}
                    accessibilityLabel={`folder ${entry.name}`}
                    accessibilityRole="button"
                    style={[styles.row, indent]}
                    onPress={() => onFolderToggle(entry.relativePath, !expanded)}
                >
                    <Feather name={expanded ? "chevron-down" : "chevron-right"} size={14} color={c.textSecondary} />
                    <Feather name="folder" size={14} color={c.textSecondary} />
                    <Text style={[styles.label, { color: c.textSecondary }]} numberOfLines={1}>
                        {entry.name}
                    </Text>
                </Pressable>
                {expanded
                    ? (entry.children ?? []).map((child) => (
                          <VaultTreeNode
                              key={child.relativePath}
                              entry={child}
                              depth={depth + 1}
                              selected={selected}
                              expandedDirs={expandedDirs}
                              forceOpen={forceOpen}
                              onSelect={onSelect}
                              onFolderToggle={onFolderToggle}
                          />
                      ))
                    : null}
            </View>
        );
    }

    const isActive = selected === entry.relativePath;

    return (
        <Pressable
            testID={`obsidian-note-${entry.relativePath}`}
            accessibilityLabel={`note ${entry.name}`}
            accessibilityRole="button"
            style={[styles.row, indent, isActive && { backgroundColor: c.accent, borderRadius: 6 }]}
            onPress={() => onSelect(entry.relativePath)}
        >
            <View style={styles.fileSpacer} />
            <Feather name="file-text" size={14} color={isActive ? c.bgBase : c.textSecondary} />
            <Text
                style={[styles.label, { color: isActive ? c.bgBase : c.textSecondary }, isActive && styles.activeLabel]}
                numberOfLines={1}
            >
                {entry.name}
            </Text>
        </Pressable>
    );
}

export const VaultTreeNode = memo(VaultTreeNodeImpl);

const styles = StyleSheet.create({
    row: { flexDirection: "row", alignItems: "center", gap: 6, paddingVertical: 6, paddingRight: 8 },
    label: { flex: 1, fontFamily: "monospace", fontSize: 12 },
    activeLabel: { fontWeight: "600" },
    fileSpacer: { width: 14 },
});
