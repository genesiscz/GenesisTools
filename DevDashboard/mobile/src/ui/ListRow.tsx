import type { ReactNode } from "react";
import { Pressable, Text, View } from "react-native";
import { useThemeColors } from "@/theme/colors";

interface ListRowProps {
    /** Primary text (truncated to one line, flexes to fill). */
    primary: string;
    /** Optional right-aligned trailing text (e.g. a size, count, time). */
    trailing?: string;
    /** Optional custom trailing node (overrides `trailing`). */
    trailingNode?: ReactNode;
    onPress?: () => void;
    testID?: string;
}

/**
 * Shared one-line list row: truncated primary text on the left, optional trailing value/node on the
 * right; pressable when `onPress` is given. Tier-1 primitive (the generic form of Pulse's process
 * rows; reuse for session/terminal/note lists).
 */
export function ListRow({ primary, trailing, trailingNode, onPress, testID }: ListRowProps) {
    const c = useThemeColors();

    const content = (
        <View className="flex-row items-center justify-between">
            <Text numberOfLines={1} className="flex-1 pr-2" style={{ color: c.textSecondary, fontFamily: "monospace" }}>
                {primary}
            </Text>
            {trailingNode ?? (trailing ? (
                <Text style={{ color: c.textPrimary, fontFamily: "monospace" }}>{trailing}</Text>
            ) : null)}
        </View>
    );

    if (onPress) {
        return (
            <Pressable testID={testID} accessibilityLabel={testID} accessibilityRole="button" onPress={onPress}>
                {content}
            </Pressable>
        );
    }

    return (
        <View testID={testID} accessibilityLabel={testID}>{content}</View>
    );
}
