import { Box, Text } from "ink";
import { useEffect, useState } from "react";

interface StatusBarProps {
    lastRefresh: Date | null;
    nextRefresh: Date | null;
    paused: boolean;
    pollingLabel: string | null;
    pollInterval: number;
    /** Shown only when the Overview tab is active — the `s` toggle is scoped to it. */
    sortMode?: "config" | "urgency";
}

function formatTime(date: Date): string {
    return date.toLocaleTimeString("en-US", {
        hour12: false,
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
    });
}

const SHORTCUTS: Array<[string, string]> = [
    ["q", "quit"],
    ["r", "refresh"],
    ["p", "pause"],
    ["i", "interval"],
    ["s", "sort"],
    ["?", "help"],
];

export function StatusBar({ lastRefresh, nextRefresh, paused, pollingLabel, pollInterval, sortMode }: StatusBarProps) {
    const [, setTick] = useState(0);

    useEffect(() => {
        const timer = setInterval(() => setTick((t) => t + 1), 1000);
        return () => clearInterval(timer);
    }, []);

    const countdown = nextRefresh ? Math.max(0, Math.round((nextRefresh.getTime() - Date.now()) / 1000)) : null;

    return (
        <Box
            flexDirection="column"
            flexShrink={0}
            borderStyle="single"
            borderTop
            borderBottom={false}
            borderLeft={false}
            borderRight={false}
            paddingX={1}
        >
            <Box>
                {lastRefresh && (
                    <Text dimColor>
                        {"last "}
                        <Text color="white">{formatTime(lastRefresh)}</Text>
                    </Text>
                )}
                {nextRefresh && !paused && (
                    <Text dimColor>{` · next ${countdown !== null ? `${countdown}s` : "—"}`}</Text>
                )}
                <Text dimColor>{` · every ${pollInterval}s`}</Text>
                {pollingLabel && <Text color="yellow">{`  ● polling ${pollingLabel}`}</Text>}
                {paused && <Text color="red">{"  ⏸ paused"}</Text>}
                {sortMode && <Text dimColor>{`  · sort ${sortMode === "urgency" ? "urgency" : "config"}`}</Text>}
            </Box>
            <Box>
                {SHORTCUTS.map(([key, label]) => (
                    <Text key={key}>
                        <Text color="cyan">{key}</Text>
                        <Text dimColor>{` ${label}   `}</Text>
                    </Text>
                ))}
            </Box>
        </Box>
    );
}
