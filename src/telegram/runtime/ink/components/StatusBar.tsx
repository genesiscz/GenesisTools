import { Box, Text } from "ink";
import type { TelegramContactV2 } from "../../../lib/types";

interface StatusBarProps {
    contact: TelegramContactV2;
    messageCount: number;
    inputMode: string;
    systemMessage?: string;
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

export function StatusBar({ contact, messageCount, inputMode, systemMessage }: StatusBarProps) {
    const icon = chatTypeIcon(contact.chatType);

    return (
        <Box borderStyle="single" borderColor="blue" justifyContent="space-between" paddingLeft={1} paddingRight={1}>
            <Text color="blue" bold>
                {icon} {contact.displayName}
                {contact.username ? ` (@${contact.username})` : ""}
            </Text>
            <Box gap={2}>
                {systemMessage && <Text color="yellow">{systemMessage}</Text>}
                <Text dimColor>{messageCount} msgs</Text>
                <Text dimColor>mode: {inputMode}</Text>
                <Text dimColor>Tab: contacts</Text>
            </Box>
        </Box>
    );
}
