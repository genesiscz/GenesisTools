import { Stack } from "expo-router";
import { QuickCommandsScreen } from "@/features/quick-commands";

/** Thin route wrapper — registers /quick-commands under the dark-themed (more) Stack. Keep it thin. */
export default function QuickCommandsRoute() {
    return (
        <>
            <Stack.Screen options={{ title: "Quick Commands" }} />
            <QuickCommandsScreen />
        </>
    );
}
