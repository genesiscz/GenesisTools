import { Box, Text, useInput } from "ink";

export type HelpLine = [key: string, description: string];

interface HelpOverlayProps {
    onClose: () => void;
    /** Tabs this dashboard actually has, so the digit range is not a guess. */
    tabCount: number;
    /** `P` is bound only when there is more than one provider to cycle through. */
    canCycleProvider: boolean;
    /** Appended under the shared bindings; a provider presenter supplies its own. */
    extraLines?: HelpLine[];
}

export interface ShellHelpOptions {
    tabCount: number;
    canCycleProvider: boolean;
}

/**
 * The shell's own bindings, as THIS dashboard binds them. It is built per dashboard rather
 * than kept as a constant because `tools ai usage` has two tabs and `tools claude usage`
 * three, and `P` does nothing when only one provider is pinned. An overlay that advertises
 * a key nothing answers is worse than no overlay.
 */
export function shellHelpLines({ tabCount, canCycleProvider }: ShellHelpOptions): HelpLine[] {
    const providerLines: HelpLine[] = canCycleProvider ? [["P", "Cycle provider filter"]] : [];

    return [
        ["q", "Quit dashboard"],
        ["←/→", "Navigate tabs"],
        [tabCount > 1 ? `1-${tabCount}` : "1", "Jump to tab"],
        ["r", "Force refresh now"],
        ["p", "Pause/resume polling"],
        ["i", "Cycle poll interval (5/10/15/30/60s)"],
        ["s", "Overview: urgency ↔ config order"],
        ...providerLines,
        ["a", "Account filter checklist"],
        ["?", "Toggle this help"],
        ["", ""],
        ["", "History tab:"],
        ["j/k", "Jump account (grouped) · scroll (flat)"],
        ["g/G", "Top/bottom"],
        ["Ctrl+d/u", "Page down/up"],
        ["l", "Toggle grouped/flat list"],
        ["f", "Cycle time range filter"],
        ["", ""],
        ["x", "Dismiss alert banner"],
    ];
}

export function HelpOverlay({ onClose, tabCount, canCycleProvider, extraLines }: HelpOverlayProps) {
    const shell = shellHelpLines({ tabCount, canCycleProvider });
    const KEYBINDINGS: HelpLine[] = extraLines ? [...shell, ["", ""], ...extraLines] : shell;

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
