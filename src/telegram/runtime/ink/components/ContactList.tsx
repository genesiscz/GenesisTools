import { Box, Text, useInput } from "ink";
import SelectInput from "ink-select-input";
import type { TelegramContactV2 } from "../../../lib/types";

interface ContactListProps {
    contacts: TelegramContactV2[];
    currentContactId: string;
    unreadCounts: Map<string, number>;
    onSelect: (contact: TelegramContactV2) => void;
    onBack: () => void;
}

function chatTypeIcon(chatType: string): string {
    if (chatType === "group") {
        return "[group]";
    }

    if (chatType === "channel") {
        return "[channel]";
    }

    return "[user]";
}

export function ContactList({ contacts, currentContactId, unreadCounts, onSelect, onBack }: ContactListProps) {
    useInput((_input, key) => {
        if (key.tab) {
            onBack();
        }
    });

    const items = contacts.map((c) => {
        const icon = chatTypeIcon(c.chatType);
        const current = c.userId === currentContactId ? " <" : "";
        const unread = unreadCounts.get(c.userId) ?? 0;
        const badge = unread > 0 ? ` (${unread})` : "";
        return {
            label: `${icon} ${c.displayName}${badge}${current}`,
            value: c.userId,
        };
    });

    const handleSelect = (item: { value: string }) => {
        const contact = contacts.find((c) => c.userId === item.value);

        if (contact) {
            onSelect(contact);
        }
    };

    return (
        <Box flexDirection="column" padding={1}>
            <Text bold color="blue">
                Select a contact (Tab to go back):
            </Text>
            <Box marginTop={1}>
                <SelectInput items={items} onSelect={handleSelect} />
            </Box>
        </Box>
    );
}
