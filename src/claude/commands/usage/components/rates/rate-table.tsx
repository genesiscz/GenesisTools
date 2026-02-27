import { Box, Text } from "ink";
import type { RollingRates } from "@app/claude/lib/usage/rate-math";
import { formatDuration } from "@app/claude/lib/usage/rate-math";

interface RateTableProps {
    rates: RollingRates;
    projections: Record<string, number | null>;
    currentUtilization: number;
}

const WINDOWS = ["1min", "5min", "10min", "30min"] as const;
const WINDOW_LABELS: Record<string, string> = {
    "1min": "Last 1 min",
    "5min": "Last 5 min",
    "10min": "Last 10 min",
    "30min": "Last 30 min",
};

function formatRate(rate: number | null): string {
    if (rate === null) {
        return "—";
    }

    const sign = rate >= 0 ? "+" : "";
    return `${sign}${rate.toFixed(2)}/min`;
}

function formatProjection(minutes: number | null): string {
    if (minutes === null) {
        return "—";
    }

    if (minutes === 0) {
        return "at limit";
    }

    return formatDuration(minutes);
}

function formatDelta(rate: number | null, windowMinutes: number): string {
    if (rate === null) {
        return "—";
    }

    const delta = rate * windowMinutes;
    const sign = delta >= 0 ? "+" : "";
    return `${sign}${delta.toFixed(1)}%`;
}

const WINDOW_MINUTES: Record<string, number> = {
    "1min": 1,
    "5min": 5,
    "10min": 10,
    "30min": 30,
};

export function RateTable({ rates, projections }: RateTableProps) {
    return (
        <Box flexDirection="column">
            <Box>
                <Text bold>{`${"Window".padEnd(16)}${"Δ%".padEnd(10)}${"Rate/min".padEnd(12)}Proj. limit`}</Text>
            </Box>
            <Text dimColor>{"─".repeat(50)}</Text>
            {WINDOWS.map((w) => {
                const rate = rates[w];
                const proj = projections[w] ?? null;
                const windowMin = WINDOW_MINUTES[w];

                return (
                    <Box key={w}>
                        <Text>{WINDOW_LABELS[w].padEnd(16)}</Text>
                        <Text color={rate !== null && rate > 0 ? "yellow" : "green"}>
                            {formatDelta(rate, windowMin).padEnd(10)}
                        </Text>
                        <Text>{formatRate(rate).padEnd(12)}</Text>
                        <Text dimColor>{formatProjection(proj)}</Text>
                    </Box>
                );
            })}
        </Box>
    );
}
