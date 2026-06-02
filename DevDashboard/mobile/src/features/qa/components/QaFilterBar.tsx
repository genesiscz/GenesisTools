import { Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { useThemeColors } from "@/theme/colors";

interface QaFilterBarProps {
    projects: string[];
    tags: string[];
    /** Currently-selected project names (multi-select). Empty = no project filter ("all"). */
    selectedProjects: string[];
    /** Currently-selected tags (multi-select). Empty = no tag filter ("all"). */
    selectedTags: string[];
    text: string;
    onToggleProject: (project: string) => void;
    onToggleTag: (tag: string) => void;
    onClearProjects: () => void;
    onClearTags: () => void;
    onText: (text: string) => void;
}

interface ChipProps {
    label: string;
    active: boolean;
    onPress: () => void;
    testID: string;
}

function Chip({ label, active, onPress, testID }: ChipProps) {
    const c = useThemeColors();

    return (
        <Pressable
            testID={testID}
            accessibilityLabel={testID}
            accessibilityRole="button"
            accessibilityState={{ selected: active }}
            onPress={onPress}
            className="rounded-full px-3 py-1"
            style={{
                backgroundColor: active ? c.accentMuted : "transparent",
                borderWidth: 1,
                borderColor: active ? c.accent : c.border,
            }}
        >
            <Text
                className="text-xs"
                style={{ color: active ? c.accent : c.textMuted, fontFamily: "monospace" }}
            >
                {label}
            </Text>
        </Pressable>
    );
}

/**
 * QA feed filters: a debounce-free search input (filtering is cheap, in-memory) plus two chip rows
 * for project + tag. Project and tag are MULTI-SELECT — tapping a chip toggles its membership, and
 * the pinned "all" chip (outside the horizontal scroll) clears the facet. Every chip carries a
 * stable accessibility id for the Appium spec.
 */
export function QaFilterBar({
    projects,
    tags,
    selectedProjects,
    selectedTags,
    text,
    onToggleProject,
    onToggleTag,
    onClearProjects,
    onClearTags,
    onText,
}: QaFilterBarProps) {
    const c = useThemeColors();

    return (
        <View className="gap-2">
            <TextInput
                testID="qa-search"
                accessibilityLabel="qa-search"
                value={text}
                onChangeText={onText}
                placeholder="Search Q&A…"
                placeholderTextColor={c.textMuted}
                autoCapitalize="none"
                autoCorrect={false}
                className="rounded-xl px-3 py-2 text-sm"
                style={{
                    color: c.textPrimary,
                    backgroundColor: c.bgPanel,
                    borderWidth: 1,
                    borderColor: c.border,
                    fontFamily: "monospace",
                }}
            />

            {tags.length > 0 ? (
                <View className="flex-row items-center gap-2">
                    <Chip
                        label="all tags"
                        active={selectedTags.length === 0}
                        onPress={onClearTags}
                        testID="qa-tag-all"
                    />
                    <ScrollView
                        horizontal
                        showsHorizontalScrollIndicator={false}
                        contentContainerStyle={{ gap: 8 }}
                    >
                        {tags.map((t) => (
                            <Chip
                                key={t}
                                label={t}
                                active={selectedTags.includes(t)}
                                onPress={() => onToggleTag(t)}
                                testID={`qa-tag-${t}`}
                            />
                        ))}
                    </ScrollView>
                </View>
            ) : null}

            {projects.length > 1 ? (
                <View className="flex-row items-center gap-2">
                    <Chip
                        label="all projects"
                        active={selectedProjects.length === 0}
                        onPress={onClearProjects}
                        testID="qa-project-all"
                    />
                    <ScrollView
                        horizontal
                        showsHorizontalScrollIndicator={false}
                        contentContainerStyle={{ gap: 8 }}
                    >
                        {projects.map((p) => (
                            <Chip
                                key={p}
                                label={p}
                                active={selectedProjects.includes(p)}
                                onPress={() => onToggleProject(p)}
                                testID={`qa-project-${p}`}
                            />
                        ))}
                    </ScrollView>
                </View>
            ) : null}
        </View>
    );
}
