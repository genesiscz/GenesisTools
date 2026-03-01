import type { UsageAlert } from "@app/claude/lib/usage/notification-manager";
import { Box, Text, useInput } from "ink";
import { useEffect, useRef, useState } from "react";

interface AlertBannerProps {
    alerts: UsageAlert[];
    onDismiss: () => void;
}

export function AlertBanner({ alerts, onDismiss }: AlertBannerProps) {
    const [flash, setFlash] = useState(false);
    const prevCountRef = useRef(alerts.length);

    useInput((input) => {
        if (alerts.length > 0 && (input === "x" || input === "X")) {
            onDismiss();
        }
    });

    useEffect(() => {
        if (alerts.length > prevCountRef.current) {
            setFlash(true);
            let count = 0;
            const blink = setInterval(() => {
                count++;
                setFlash((v) => !v);

                if (count >= 6) {
                    clearInterval(blink);
                    setFlash(false);
                }
            }, 300);

            return () => clearInterval(blink);
        }

        prevCountRef.current = alerts.length;
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
                        <Text backgroundColor={flash ? undefined : bgColor} color={flash ? bgColor : "white"} bold>
                            {` ▲ ${alert.message} `}
                        </Text>
                        {isLast && <Text dimColor>{"[x] dismiss"}</Text>}
                    </Box>
                );
            })}
        </Box>
    );
}
