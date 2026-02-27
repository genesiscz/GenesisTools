import { Box, Text } from "ink";
import React from "react";

interface UsageBarProps {
    utilization: number;
    width?: number;
    projectedPct?: number | null;
}

const BLOCK_FULL = "\u2588";
const BLOCK_HALF = "\u258C";

function colorForPct(pct: number): string {
    if (pct >= 80) {
        return "red";
    }

    if (pct >= 50) {
        return "yellow";
    }

    return "green";
}

export function UsageBar({ utilization, width = 40, projectedPct }: UsageBarProps) {
    const pct = Math.max(0, Math.min(utilization, 100));
    const filled = Math.floor((pct / 100) * width);
    const hasHalf = pct > 0 && filled < width && ((pct / 100) * width) % 1 >= 0.25;
    const emptyCount = width - filled - (hasHalf ? 1 : 0);
    const color = colorForPct(pct);

    return (
        <Box>
            <Text color={color}>
                {BLOCK_FULL.repeat(filled)}
                {hasHalf ? BLOCK_HALF : ""}
            </Text>
            <Text dimColor>
                {"\u2591".repeat(emptyCount)}
            </Text>
            <Text bold>{`  ${Math.round(pct)}%`}</Text>
            {projectedPct !== null && projectedPct !== undefined && (
                <Text dimColor color={colorForPct(projectedPct)}>
                    {`  ~${Math.round(projectedPct)}% proj`}
                </Text>
            )}
        </Box>
    );
}
