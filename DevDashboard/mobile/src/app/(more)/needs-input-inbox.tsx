import { Stack } from "expo-router";
import { NeedsInputInboxScreen } from "@/features/needs-input-inbox";

/**
 * Thin route wrapper for the Needs-Input Inbox. The screen body lives in the feature
 * (`@/features/needs-input-inbox`); this file only registers the route under the `(more)` Stack
 * (inheriting the dark themed header) and sets the nav title. Keep it thin — no logic here.
 */
export default function NeedsInputInboxRoute() {
    return (
        <>
            <Stack.Screen options={{ title: "Needs Input" }} />
            <NeedsInputInboxScreen />
        </>
    );
}
