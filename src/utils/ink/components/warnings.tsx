/**
 * Warnings — Bullet-pointed warning list
 */

import { Box, Text } from "ink";
import { colors, symbols } from "../lib/theme.js";

export interface WarningsProps {
    warnings: string[];
    title?: string;
}

export function Warnings({ warnings, title = "Warnings" }: WarningsProps) {
    if (warnings.length === 0) {
        return null;
    }

    return (
        <Box flexDirection="column" marginTop={1}>
            <Text color={colors.warning} bold>
                {symbols.warning} {title}:
            </Text>
            {warnings.map((warning, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: static list rendering
                <Text key={i} color={colors.warning}>
                    {"  "}
                    {symbols.bullet} {warning}
                </Text>
            ))}
        </Box>
    );
}
