import { Box, Text, useInput } from "ink";

interface HelpOverlayProps {
    onClose: () => void;
}

const KEYBINDINGS = [
    ["q", "Quit dashboard"],
    ["←/→", "Navigate tabs"],
    ["1-5", "Jump to tab"],
    ["r", "Force refresh now"],
    ["p", "Pause/resume polling"],
    ["i", "Cycle poll interval (5/10/15/30/60s)"],
    ["?", "Toggle this help"],
    ["", ""],
    ["", "Timeline tab:"],
    ["+/-", "Zoom time range"],
    ["a", "Toggle all-accounts overlay"],
    ["g", "Cycle graph style (line/bar/sparkline)"],
    ["", ""],
    ["", "History tab:"],
    ["j/k", "Scroll up/down"],
    ["g/G", "Top/bottom"],
    ["Ctrl+d/u", "Page down/up"],
    ["l", "Toggle stacked/side-by-side"],
    ["f", "Cycle time range filter"],
    ["", ""],
    ["", ""],
    ["", "Sessions tab:"],
    ["↑/↓", "Select session"],
    ["Enter", "Open action menu (ping / resume)"],
    ["f", "Cycle time filter (1h/6h/24h/7d/all)"],
    ["j/k", "Scroll list"],
    ["g/G", "Top/bottom"],
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
        <Box flexDirection="column" borderStyle="double" borderColor="cyan" paddingX={2} paddingY={1}>
            <Text bold color="cyan">
                {"  Keybindings"}
            </Text>
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
                        <Text bold color="yellow">
                            {key.padEnd(12)}
                        </Text>
                        <Text>{desc}</Text>
                    </Box>
                );
            })}
            <Text>{""}</Text>
            <Text dimColor>{"Press ? or Esc to close"}</Text>
        </Box>
    );
}
