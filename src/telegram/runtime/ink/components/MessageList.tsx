import { Box, Text } from "ink";
import type { WatchMessage } from "../../shared/WatchSession";

interface MessageListProps {
    messages: WatchMessage[];
}

export function MessageList({ messages }: MessageListProps) {
    if (messages.length === 0) {
        return (
            <Box flexDirection="column" padding={1}>
                <Text dimColor>No messages yet. Start typing to send a message.</Text>
            </Box>
        );
    }

    return (
        <Box flexDirection="column">
            {messages.map((msg) => (
                <MessageBubble key={msg.id} message={msg} />
            ))}
        </Box>
    );
}

function MessageBubble({ message }: { message: WatchMessage }) {
    const time = formatTime(message.date);
    const prefix = message.isOutgoing ? ">" : "<";
    const nameColor = message.isOutgoing ? "cyan" : "green";

    return (
        <Box>
            <Text dimColor>{time} </Text>
            <Text color={nameColor}>
                {prefix} {message.senderName}:{" "}
            </Text>
            <Text>{message.text}</Text>
            {message.mediaDesc && <Text dimColor> [{message.mediaDesc}]</Text>}
        </Box>
    );
}

function formatTime(date: Date): string {
    const hours = String(date.getHours()).padStart(2, "0");
    const minutes = String(date.getMinutes()).padStart(2, "0");
    return `${hours}:${minutes}`;
}
