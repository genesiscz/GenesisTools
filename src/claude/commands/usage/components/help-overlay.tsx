import { Box, Text, useInput } from "ink";

interface HelpOverlayProps {
    onClose: () => void;
}

const KEYBINDINGS = [
    ["q", "Quit dashboard"],
    ["←/→", "Navigate tabs"],
    ["1-4", "Jump to tab"],
    ["r", "Force refresh now"],
    ["p", "Pause/resume polling"],
    ["?", "Toggle this help"],
    ["", ""],
    ["", "Timeline tab:"],
    ["+/-", "Zoom time range"],
    ["↑/↓", "Switch bucket"],
    ["a", "Toggle all-accounts overlay"],
    ["", ""],
    ["", "Rates tab:"],
    ["↑/↓", "Switch account"],
    ["b", "Switch bucket focus"],
    ["", ""],
    ["", "History tab:"],
    ["j/k", "Scroll up/down"],
    ["g/G", "Top/bottom"],
    ["Ctrl+d/u", "Page down/up"],
    ["l", "Toggle stacked/side-by-side"],
    ["f", "Cycle time range filter"],
    ["", ""],
    ["x", "Dismiss alert banner"],
];

export function HelpOverlay({ onClose }: HelpOverlayProps) {
    useInput((input, key) => {
        if (input === "?" || key.escape) {
            onClose();
        }
    });

    return (
        <Box
            flexDirection="column"
            borderStyle="double"
            borderColor="cyan"
            paddingX={2}
            paddingY={1}
        >
            <Text bold color="cyan">{"  Keybindings"}</Text>
            <Text>{""}</Text>
            {KEYBINDINGS.map(([key, desc], i) => {
                if (!key && !desc) {
                    return <Text key={i}>{""}</Text>;
                }

                if (!key) {
                    return (
                        <Text key={i} bold underline>
                            {desc}
                        </Text>
                    );
                }

                return (
                    <Box key={i}>
                        <Text bold color="yellow">{key.padEnd(12)}</Text>
                        <Text>{desc}</Text>
                    </Box>
                );
            })}
            <Text>{""}</Text>
            <Text dimColor>{"Press ? or Esc to close"}</Text>
        </Box>
    );
}
