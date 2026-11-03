import type { AttentionItem as AttentionItemModel, WaitingSessionDto } from "@dd/contract";
import type { ReactElement, ReactNode } from "react";
import { SectionList, View } from "react-native";
import { AttentionItem } from "@/features/needs-input-inbox/components/AttentionItem";
import { type InboxRow, type InboxSection, inboxRowKey, inboxSections } from "@/features/needs-input-inbox/select";
import { Empty } from "@/ui/Empty";
import { MockBadge } from "@/ui/MockBadge";
import { SectionHeader } from "@/ui/SectionHeader";
import { StatusPill } from "@/ui/StatusPill";

interface AttentionListProps {
    items: AttentionItemModel[];
    onResolve: (qaId: string) => void;
    /** The answer queue's header (count, receipts), above its session rows in the same list. */
    header?: ReactNode;
    /** The answer queue's sessions: rows of the list, so only the cards on screen mount. */
    sessions?: readonly WaitingSessionDto[];
    renderSession?: (session: WaitingSessionDto) => ReactElement;
    /** Shown in place of the "All clear" state while the attention list loads or after it failed. */
    status?: ReactElement;
}

/**
 * The Needs Input list: one `SectionList`, the answer queue's session cards first, then the bezel `AttentionItem`
 * cards with their header (section title, mock badge, and a count pill) and an `Empty` "All clear" state. Every card
 * is a row, never part of a list header, so a long queue mounts only what is on screen; a card's typed edits survive
 * its unmount (`KeptEdits`). The count pill exposes the queue size for the Appium assertion.
 */
export function AttentionList({ items, onResolve, header, sessions = [], renderSession, status }: AttentionListProps) {
    const sections = inboxSections({ sessions, items });

    const renderRow = ({ item: row }: { item: InboxRow }) => {
        if (row.kind === "session") {
            return renderSession ? renderSession(row.session) : null;
        }

        if (row.kind === "attention") {
            return <AttentionItem item={row.item} onResolve={onResolve} />;
        }

        return (
            status ?? (
                <Empty
                    testID="needs-input-inbox-empty"
                    title="All clear"
                    hint="No agent questions or live agent sessions need you."
                />
            )
        );
    };

    const renderSectionHeader = ({ section }: { section: InboxSection }) =>
        section.key === "queue" ? (
            <View>{header}</View>
        ) : (
            <View className="gap-2 pb-1 pt-3">
                <View className="flex-row items-center justify-between">
                    <SectionHeader title="Needs input" />
                    <StatusPill testID="needs-input-inbox-count" label={`${items.length}`} tone="accent" normalCase />
                </View>
                <MockBadge />
            </View>
        );

    return (
        <SectionList<InboxRow, InboxSection>
            testID="needs-input-inbox-list"
            accessibilityLabel="needs-input-inbox-list"
            // The queue's cards hold text fields: a tap on Send must not only close the keyboard.
            keyboardShouldPersistTaps="handled"
            sections={sections}
            keyExtractor={inboxRowKey}
            // The headers scroll with their rows, as the list header did before the queue became rows.
            stickySectionHeadersEnabled={false}
            contentContainerStyle={{ gap: 12, paddingBottom: 32, paddingHorizontal: 16 }}
            renderSectionHeader={renderSectionHeader}
            renderItem={renderRow}
        />
    );
}
