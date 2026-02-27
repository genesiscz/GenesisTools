import { Box, Text } from "ink";
import React, { useEffect, useState } from "react";

interface StatusBarProps {
    lastRefresh: Date | null;
    nextRefresh: Date | null;
    paused: boolean;
    isPolling: boolean;
}

function formatTime(date: Date): string {
    return date.toLocaleTimeString("en-US", {
        hour12: false,
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
    });
}

export function StatusBar({ lastRefresh, nextRefresh, paused, isPolling }: StatusBarProps) {
    const [, setTick] = useState(0);

    useEffect(() => {
        const timer = setInterval(() => setTick((t) => t + 1), 1000);
        return () => clearInterval(timer);
    }, []);

    const countdown = nextRefresh
        ? Math.max(0, Math.round((nextRefresh.getTime() - Date.now()) / 1000))
        : null;

    return (
        <Box borderStyle="single" borderTop borderBottom={false} borderLeft={false} borderRight={false} paddingX={1}>
            <Box flexGrow={1}>
                {lastRefresh && (
                    <Text dimColor>
                        Last: {formatTime(lastRefresh)}
                    </Text>
                )}
                {nextRefresh && !paused && (
                    <Text dimColor>
                        {" • Next: "}
                        {countdown !== null ? `${countdown}s` : "—"}
                    </Text>
                )}
                {isPolling && <Text color="yellow">{" ● Polling"}</Text>}
                {paused && <Text color="red">{" ⏸ Paused"}</Text>}
            </Box>
            <Text dimColor>
                {"[q]uit [r]efresh [p]ause [?]help"}
            </Text>
        </Box>
    );
}
