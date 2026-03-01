/**
 * Header — Command title with optional subtitle
 */

import { Box, Text } from "ink";
import { symbols } from "../lib/theme.js";

export interface HeaderProps {
    title: string;
    subtitle?: string;
    emoji?: string;
}

export function Header({ title, subtitle, emoji = symbols.seed }: HeaderProps) {
    return (
        <Box flexDirection="column">
            <Text>
                {emoji}{" "}
                <Text bold color="white">
                    {title}
                </Text>
            </Text>
            {subtitle && (
                <Text dimColor>
                    {"  "}
                    {subtitle}
                </Text>
            )}
        </Box>
    );
}
