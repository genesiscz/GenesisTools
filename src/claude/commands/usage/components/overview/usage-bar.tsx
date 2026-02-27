import { Text } from "ink";
import { colorForPct } from "@app/claude/lib/usage/constants";

interface UsageBarProps {
    utilization: number;
    width?: number;
}

const BLOCK_FULL = "\u2588";
const BLOCK_HALF = "\u258C";

export function UsageBar({ utilization, width = 30 }: UsageBarProps) {
    const pct = Math.max(0, Math.min(utilization, 100));
    const filled = Math.floor((pct / 100) * width);
    const hasHalf = pct > 0 && filled < width && ((pct / 100) * width) % 1 >= 0.25;
    const emptyCount = width - filled - (hasHalf ? 1 : 0);
    const color = colorForPct(pct);

    return (
        <Text>
            <Text color={color}>
                {BLOCK_FULL.repeat(filled)}
                {hasHalf ? BLOCK_HALF : ""}
            </Text>
            <Text dimColor>
                {"\u2591".repeat(Math.max(0, emptyCount))}
            </Text>
        </Text>
    );
}
