import { colorForPct } from "@app/claude/lib/usage/constants";
import { Text } from "ink";

interface UsageBarProps {
    utilization: number;
    width?: number;
    color?: string;
}

const BLOCK_FULL = "\u2588";

export function UsageBar({ utilization, width = 30, color: colorOverride }: UsageBarProps) {
    const pct = Math.max(0, Math.min(utilization, 100));
    // Full cells only. The old half-block boundary cell (\u258C) painted its right
    // half in the terminal's DEFAULT background \u2014 an opaque black notch against
    // the track, and on transparent terminals the \u2591 track itself let the
    // window behind bleed through, reading as misaligned bars. Solid full
    // blocks are opaque glyphs edge to edge.
    // Round, then nudge off the boundaries: a small non-zero pct must still
    // show at least one filled cell (else it reads as 0%), and anything
    // short of 100% must leave at least one empty cell (else it reads as
    // full).
    let filled = Math.round((pct / 100) * width);

    if (pct > 0 && filled === 0) {
        filled = 1;
    }

    if (pct < 100 && filled >= width) {
        filled = width - 1;
    }

    const color = colorOverride ?? colorForPct(pct);

    return (
        <Text>
            <Text color={color}>{BLOCK_FULL.repeat(filled)}</Text>
            <Text color="gray" dimColor>
                {BLOCK_FULL.repeat(Math.max(0, width - filled))}
            </Text>
        </Text>
    );
}
