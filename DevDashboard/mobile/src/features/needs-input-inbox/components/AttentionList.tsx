import type { AttentionItem as AttentionItemModel } from "@dd/contract";
import { FlatList, View } from "react-native";
import { AttentionItem } from "@/features/needs-input-inbox/components/AttentionItem";
import { Empty } from "@/ui/Empty";
import { MockBadge } from "@/ui/MockBadge";
import { SectionHeader } from "@/ui/SectionHeader";
import { StatusPill } from "@/ui/StatusPill";

interface AttentionListProps {
    items: AttentionItemModel[];
    onResolve: (qaId: string) => void;
}

/**
 * The attention queue list. A `FlatList` of bezel `AttentionItem` cards with a header (section title,
 * mock badge, and a count pill) and an `Empty` "All clear" state. Mirrors the QA feed's FlatList
 * shape; the count pill exposes the queue size for the Appium assertion.
 */
export function AttentionList({ items, onResolve }: AttentionListProps) {
    return (
        <FlatList
            testID="needs-input-inbox-list"
            accessibilityLabel="needs-input-inbox-list"
            data={items}
            keyExtractor={(item) => item.id}
            contentContainerStyle={{ gap: 12, paddingBottom: 32, paddingHorizontal: 16 }}
            ListHeaderComponent={
                <View className="gap-2 pb-1">
                    <View className="flex-row items-center justify-between">
                        <SectionHeader title="Needs input" />
                        <StatusPill
                            testID="needs-input-inbox-count"
                            label={`${items.length}`}
                            tone="accent"
                            normalCase
                        />
                    </View>
                    <MockBadge />
                </View>
            }
            ListEmptyComponent={
                <Empty
                    testID="needs-input-inbox-empty"
                    title="All clear"
                    hint="No agent questions or live agent sessions need you."
                />
            }
            renderItem={({ item }) => <AttentionItem item={item} onResolve={onResolve} />}
        />
    );
}
