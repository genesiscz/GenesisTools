import type { QaRow } from "@dd/contract";
import { FlatList, Text, View } from "react-native";
import { QaCard } from "@/features/qa/components/QaCard";
import { isUnread } from "@/features/qa/units";
import { Empty } from "@/ui/Empty";
import { useThemeColors } from "@/theme/colors";

interface QaFeedProps {
    rows: QaRow[];
    /** Ids the user toggled unread locally this session (override the server's readAt). */
    locallyUnread: Set<string>;
    /** Ids the user toggled read locally this session (override the server's readAt). */
    locallyRead: Set<string>;
    totalCount: number;
    onToggleRead: (id: string, nextUnread: boolean) => void;
}

/** Resolves the effective unread state: a local toggle wins over the server's `readAt`. */
function resolveUnread(row: QaRow, locallyUnread: Set<string>, locallyRead: Set<string>): boolean {
    const id = row.id ?? "";

    if (locallyRead.has(id)) {
        return false;
    }

    if (locallyUnread.has(id)) {
        return true;
    }

    return isUnread(row);
}

/**
 * The live Q&A feed list. Renders an `Empty` state distinguishing "nothing recorded" from "no
 * matches for the current filter"; otherwise a `FlatList` of `QaCard`s (keyed by entry id). Effective
 * read/unread merges the server `readAt` with the user's optimistic session toggles.
 */
export function QaFeed({ rows, locallyUnread, locallyRead, totalCount, onToggleRead }: QaFeedProps) {
    const c = useThemeColors();

    if (rows.length === 0) {
        return (
            <Empty
                testID="qa-empty"
                title={totalCount === 0 ? "No questions recorded yet." : "No matches for your filter."}
                hint={totalCount === 0 ? "Recorded Q&A from your agents will stream in here." : undefined}
            />
        );
    }

    return (
        <FlatList
            testID="qa-list"
            accessibilityLabel="qa-list"
            data={rows}
            keyExtractor={(r, i) => r.id ?? `qa-${i}`}
            contentContainerStyle={{ gap: 12, paddingBottom: 32 }}
            ListHeaderComponent={
                <View className="pb-1">
                    <Text testID="qa-count" className="text-xs" style={{ color: c.textMuted, fontFamily: "monospace" }}>
                        {rows.length} of {totalCount}
                    </Text>
                </View>
            }
            renderItem={({ item }) => (
                <QaCard
                    entry={item}
                    unread={resolveUnread(item, locallyUnread, locallyRead)}
                    onToggleRead={onToggleRead}
                />
            )}
        />
    );
}
