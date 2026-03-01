/**
 * Banner — ASCII art header for the FixIt DevOps Hub.
 *
 * Renders a block-font "FixIt" with ink-gradient (blue to orange).
 * Falls back to plain colored text if gradient rendering fails.
 *
 * Usage:
 *   <Banner subtitle="Release Wizard" />
 */

import { Box, Text } from "ink";
import type React from "react";
import { theme } from "../lib/theme.js";

// Block font ASCII art for "FixIt"
const ASCII_ART = `
 ███████╗ ██╗ ██╗  ██╗ ██╗ ████████╗
 ██╔════╝ ██║ ╚██╗██╔╝ ██║ ╚══██╔══╝
 █████╗   ██║  ╚███╔╝  ██║    ██║
 ██╔══╝   ██║  ██╔██╗  ██║    ██║
 ██║      ██║ ██╔╝ ██╗ ██║    ██║
 ╚═╝      ╚═╝ ╚═╝  ╚═╝ ╚═╝    ╚═╝
`.trimEnd();

interface BannerProps {
    subtitle?: string;
}

let Gradient: React.ComponentType<{ name?: string; children: React.ReactNode }> | null = null;

try {
    // ink-gradient is optional — graceful fallback if unavailable
    Gradient = (await import("ink-gradient")).default;
} catch {
    // Fallback handled in render
}

export function Banner({ subtitle }: BannerProps) {
    const lines = ASCII_ART.split("\n").filter(Boolean);

    return (
        <Box flexDirection="column" marginBottom={1}>
            {Gradient ? (
                <Gradient name="cristal">
                    {lines.map((line, i) => (
                        // biome-ignore lint/suspicious/noArrayIndexKey: static list rendering
                        <Text key={i}>{line}</Text>
                    ))}
                </Gradient>
            ) : (
                lines.map((line, i) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: static list rendering
                    <Text key={i} color={theme.primary} bold>
                        {line}
                    </Text>
                ))
            )}

            <Box marginTop={0}>
                <Text dimColor> DevOps Hub</Text>
                <Text dimColor> v1.0.0</Text>
                {subtitle && (
                    <>
                        <Text dimColor> {" \u2500 "}</Text>
                        <Text color={theme.accent}>{subtitle}</Text>
                    </>
                )}
            </Box>
        </Box>
    );
}
