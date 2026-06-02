import type { ReactNode } from "react";
import { ScrollView, View } from "react-native";

interface ScreenProps {
    children: ReactNode;
    /** Appium / a11y locator on the screen root (e.g. "screen-pulse"). */
    testID?: string;
    /** When false, render a non-scrolling flex container (e.g. for a full-bleed terminal). */
    scroll?: boolean;
}

/**
 * Shell screen wrapper: themed background + safe-area-aware scroll. Safe area is handled
 * via `contentInsetAdjustmentBehavior="automatic"` (building-native-ui guidance) rather
 * than a SafeAreaView. The `testID` doubles as the `accessibilityLabel` for Appium.
 */
export function Screen({ children, testID, scroll = true }: ScreenProps) {
    if (!scroll) {
        return (
            <View testID={testID} accessibilityLabel={testID} className="flex-1 bg-dd-bg-base">
                {children}
            </View>
        );
    }

    return (
        <ScrollView
            testID={testID}
            accessibilityLabel={testID}
            className="flex-1 bg-dd-bg-base"
            contentContainerClassName="grow p-4 gap-4"
            contentInsetAdjustmentBehavior="automatic"
        >
            {children}
        </ScrollView>
    );
}
