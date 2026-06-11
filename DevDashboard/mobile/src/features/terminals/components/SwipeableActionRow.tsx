import type { ReactNode } from "react";
import { useRef } from "react";
import { Pressable, Text, View } from "react-native";
import { Swipeable } from "react-native-gesture-handler";
import { useThemeColors } from "@/theme/colors";

/**
 * A list row with a right-to-left swipe that reveals contextual action buttons (the iOS
 * "swipe to reveal Kill/Rename" gesture). The row content is whatever the caller renders; the
 * revealed actions are described declaratively so each can keep a STABLE `testID` even while
 * hidden — Appium can still find and tap `btn-kill-<id>` without performing the gesture (a hidden
 * `Pressable` is still in the tree). The swipe is pure progressive disclosure / affordance.
 *
 * Requires a `GestureHandlerRootView` ancestor. The mobile app root (`app/_layout.tsx`, a
 * DO-NOT-TOUCH shared file) does not yet mount one, so this component mounts its own per-row
 * `GestureHandlerRootView`-free `Swipeable`; if the gesture proves inert on device the fix is to
 * wrap the tab subtree in `GestureHandlerRootView` at the root (flagged to the orchestrator).
 */

export interface SwipeAction {
    label: string;
    onPress: () => void;
    testID: string;
    tone?: "accent" | "danger";
}

interface SwipeableActionRowProps {
    children: ReactNode;
    actions: SwipeAction[];
    /** Row container testID (kept stable for Appium). */
    testID?: string;
}

export function SwipeableActionRow({ children, actions, testID }: SwipeableActionRowProps) {
    const c = useThemeColors();
    const ref = useRef<Swipeable>(null);

    const renderActions = () => (
        <View style={{ flexDirection: "row", alignItems: "stretch" }}>
            {actions.map((a) => {
                const fg = a.tone === "danger" ? c.danger : c.accent;

                return (
                    <Pressable
                        key={a.testID}
                        testID={a.testID}
                        accessibilityLabel={a.testID}
                        accessibilityRole="button"
                        onPress={() => {
                            ref.current?.close();
                            a.onPress();
                        }}
                        style={{
                            justifyContent: "center",
                            alignItems: "center",
                            paddingHorizontal: 18,
                            backgroundColor: c.bgPanel,
                            borderLeftWidth: 1,
                            borderLeftColor: c.border,
                        }}
                    >
                        <Text style={{ color: fg, fontFamily: "monospace", fontSize: 12, fontWeight: "600" }}>
                            {a.label}
                        </Text>
                    </Pressable>
                );
            })}
        </View>
    );

    return (
        <Swipeable
            ref={ref}
            testID={testID}
            renderRightActions={renderActions}
            overshootRight={false}
            friction={2}
            rightThreshold={36}
        >
            {children}
        </Swipeable>
    );
}
