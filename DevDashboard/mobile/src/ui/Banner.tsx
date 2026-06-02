import { Text, View } from "react-native";

import type { ConnStatus } from "@/state/connection";

const STATUS_LABEL: Record<ConnStatus, string> = {
    disconnected: "Disconnected",
    connecting: "Connecting…",
    connected: "Connected",
    error: "Connection error",
};

// Maps connection status to a foreground token class. `connected` uses the accent;
// `error` the danger token; the rest stay muted.
const STATUS_CLASS: Record<ConnStatus, string> = {
    disconnected: "text-dd-text-muted",
    connecting: "text-dd-text-secondary",
    connected: "text-dd-accent-to",
    error: "text-dd-danger",
};

interface BannerProps {
    status: ConnStatus;
    testID?: string;
}

/** Thin connection-status banner driven by the connection store. */
export function Banner({ status, testID = "connection-banner" }: BannerProps) {
    return (
        <View
            testID={testID}
            accessibilityLabel={testID}
            className="border-b border-dd-border bg-dd-bg-panel px-4 py-2"
        >
            <Text className={`text-xs font-medium ${STATUS_CLASS[status]}`}>{STATUS_LABEL[status]}</Text>
        </View>
    );
}
