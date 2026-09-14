import { Stack } from "expo-router";
import { View } from "react-native";
import { Timeline } from "@/features/activity-timeline/components/Timeline";

/**
 * Activity Timeline screen — the unified "today on this machine" feed (daemon runs + agent Q&A +
 * terminal launches), grouped by hour. Composes the `Timeline` feature component off the D32
 * `useTimeline` hook. Route auto-registered by `(more)/_layout.tsx`; reachable as `/activity-timeline`
 * and via the deep link `devdashboard://activity-timeline`.
 */
export default function ActivityTimelineScreen() {
    return (
        <>
            <Stack.Screen options={{ title: "Activity" }} />
            <View
                testID="screen-activity-timeline"
                accessibilityLabel="screen-activity-timeline"
                className="flex-1 bg-dd-bg-base"
            >
                <Timeline />
            </View>
        </>
    );
}
