import { useEffect } from "react";
import { Text, View } from "react-native";
import Animated, {
    Easing,
    useAnimatedStyle,
    useSharedValue,
    withRepeat,
    withSequence,
    withTiming,
} from "react-native-reanimated";
import { useThemeColors } from "@/theme/colors";

/**
 * Full-screen boot splash in the "Obsidian Terminal" design (mesh-orb emerald/violet glow on the
 * near-black base, mono eyebrow). Shown while the connection store rehydrates at launch so the app
 * never flashes the /connect screen before boot-restore resolves (the relaunch-drops-to-/connect
 * fix). Purely presentational; the caller decides when to unmount it.
 */
export function ScreenLoader({ label = "Restoring session" }: { label?: string }) {
    const c = useThemeColors();
    const pulse = useSharedValue(0.4);

    useEffect(() => {
        pulse.value = withRepeat(
            withSequence(
                withTiming(1, { duration: 720, easing: Easing.inOut(Easing.ease) }),
                withTiming(0.4, { duration: 720, easing: Easing.inOut(Easing.ease) }),
            ),
            -1,
            false,
        );
    }, [pulse]);

    const dotStyle = useAnimatedStyle(() => ({ opacity: pulse.value }));

    return (
        <View testID="screen-loader" className="flex-1 items-center justify-center" style={{ backgroundColor: c.bgBase }}>
            <View pointerEvents="none" className="absolute inset-0 overflow-hidden">
                <View
                    className="absolute h-80 w-80 rounded-full opacity-[0.18]"
                    style={{ backgroundColor: c.accent, top: -120, left: -90 }}
                />
                <View
                    className="absolute h-72 w-72 rounded-full opacity-[0.14]"
                    style={{ backgroundColor: "#8b5cf6", top: "38%", right: -110 }}
                />
                <View
                    className="absolute h-64 w-64 rounded-full opacity-[0.10]"
                    style={{ backgroundColor: c.accent, bottom: -110, left: "22%" }}
                />
            </View>

            <View className="items-center gap-4">
                <Animated.View
                    style={[dotStyle, { backgroundColor: c.accent, boxShadow: `0 0 16px ${c.accentGlow}` }]}
                    className="h-3 w-3 rounded-full"
                />
                <Text
                    className="text-[11px] font-bold uppercase tracking-[0.25em]"
                    style={{ color: c.accent, fontFamily: "monospace" }}
                >
                    {label}
                </Text>
            </View>
        </View>
    );
}
