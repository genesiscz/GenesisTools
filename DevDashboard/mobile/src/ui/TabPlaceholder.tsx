import { Text } from "react-native";

import { useConnection } from "@/state/connection";
import { Card } from "@/ui/Card";
import { Screen } from "@/ui/Screen";

interface TabPlaceholderProps {
    title: string;
    testID: string;
}

/**
 * Placeholder body for the foundation tab screens. Shows the tab title + a live
 * "connection: <status>" debug line so the shell is visibly wired before feature plans
 * 05–09 replace each screen. The `testID`/`accessibilityLabel` on the Screen root is the
 * Appium locator (`screen-pulse`, …); native tab-bar buttons are located by their Label.
 */
export function TabPlaceholder({ title, testID }: TabPlaceholderProps) {
    const status = useConnection((s) => s.status);
    const baseUrl = useConnection((s) => s.baseUrl);

    return (
        <Screen testID={testID}>
            <Text className="text-2xl font-semibold text-dd-text-primary">{title}</Text>
            <Card>
                <Text className="text-sm text-dd-text-secondary">connection: {status}</Text>
                <Text className="text-xs text-dd-text-muted">{baseUrl ?? "no endpoint"}</Text>
            </Card>
        </Screen>
    );
}
