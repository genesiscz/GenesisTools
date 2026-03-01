/**
 * Spinner — ink-spinner wrapper with contextual colors
 */

import { Box, Text } from "ink";
import InkSpinner from "ink-spinner";
import { useCLI } from "../context/cli-context.js";
import { colors } from "../lib/theme.js";

export interface SpinnerProps {
    label: string;
    color?: string;
    progress?: [current: number, total: number];
}

export function Spinner({ label, color = colors.info, progress }: SpinnerProps) {
    const { isCI, isJSON } = useCLI();

    if (isJSON) {
        return null;
    }

    const progressText = progress ? ` ${progress[0]}/${progress[1]}` : "";
    const displayLabel = `${label}${progressText}...`;

    if (isCI) {
        return (
            <Text>
                <Text color={colors.muted}>{"\u25CC"} </Text>
                {displayLabel}
            </Text>
        );
    }

    return (
        <Box>
            <Text color={color}>
                <InkSpinner type="dots" />
            </Text>
            <Text> {displayLabel}</Text>
        </Box>
    );
}
