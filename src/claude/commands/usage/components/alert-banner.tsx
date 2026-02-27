import { Box, Text } from "ink";
import React, { useEffect, useState } from "react";
import type { UsageAlert } from "@app/claude/lib/usage/notification-manager";

interface AlertBannerProps {
    alerts: UsageAlert[];
    onDismiss: () => void;
}

export function AlertBanner({ alerts, onDismiss }: AlertBannerProps) {
    const [visible, setVisible] = useState(true);

    useEffect(() => {
        if (alerts.length === 0) {
            return;
        }

        const blink = setInterval(() => setVisible((v) => !v), 500);
        return () => clearInterval(blink);
    }, [alerts.length]);

    if (alerts.length === 0) {
        return null;
    }

    const latest = alerts[alerts.length - 1];
    const bgColor = latest.severity === "critical" ? "red" : "yellow";

    return (
        <Box paddingX={1}>
            <Text
                backgroundColor={visible ? bgColor : undefined}
                color={visible ? "white" : bgColor}
                bold
            >
                {` ▲ ${latest.message} `}
            </Text>
            {alerts.length > 1 && (
                <Text dimColor>{` (+${alerts.length - 1} more)`}</Text>
            )}
            <Text dimColor>{" [x] dismiss"}</Text>
        </Box>
    );
}
