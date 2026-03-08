import { Box, Text } from "ink";

export interface SystemLine {
    text: string;
    type: "info" | "error" | "suggestion" | "assistant";
}

interface SystemOutputProps {
    lines: SystemLine[];
}

const colorMap = {
    info: "gray",
    error: "red",
    suggestion: "magenta",
    assistant: "cyan",
} as const;

export function SystemOutput({ lines }: SystemOutputProps) {
    if (lines.length === 0) {
        return null;
    }

    return (
        <Box
            flexDirection="column"
            borderStyle="round"
            borderColor="gray"
            paddingLeft={1}
            marginTop={1}
            marginBottom={1}
        >
            {lines.map((line, i) => (
                <Text key={`sys-${i}-${line.type}`} color={colorMap[line.type]}>
                    {line.text}
                </Text>
            ))}
        </Box>
    );
}
