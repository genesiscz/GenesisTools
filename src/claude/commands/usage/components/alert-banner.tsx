import { Box, Text, useInput } from "ink";
import { useEffect, useState } from "react";
import type { UsageAlert } from "@app/claude/lib/usage/notification-manager";

interface AlertBannerProps {
    alerts: UsageAlert[];
    onDismiss: () => void;
}

export function AlertBanner({ alerts, onDismiss }: AlertBannerProps) {
    const [visible, setVisible] = useState(true);

    useInput((input) => {
        if (alerts.length > 0 && (input === "x" || input === "X")) {
            onDismiss();
        }
    });

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

    return (
        <Box flexDirection="column" paddingX={1}>
            {alerts.map((alert, i) => {
                const bgColor = alert.severity === "critical" ? "red" : "yellow";
                const isLast = i === alerts.length - 1;

                return (
                    <Box key={alert.id} gap={1}>
                        <Text
                            backgroundColor={visible ? bgColor : undefined}
                            color={visible ? "white" : bgColor}
                            bold
                        >
                            {` ▲ ${alert.message} `}
                        </Text>
                        {isLast && <Text dimColor>{"[x] dismiss"}</Text>}
                    </Box>
                );
            })}
        </Box>
    );
}
