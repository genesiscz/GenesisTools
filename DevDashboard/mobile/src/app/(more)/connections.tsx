import { Stack } from "expo-router";
import { ConnectionsScreen } from "@/features/connections";

/**
 * Thin route wrapper for the Connections / Configuration screen. The actual UI (`ConnectionsScreen`)
 * is owned and built by the connections feature agent and exported from `@/features/connections`;
 * this file only registers the route under the `(more)` Stack (so it inherits the dark themed header)
 * and sets the nav title. Keep it thin — do not put connections logic here.
 *
 * If `@/features/connections` is not yet present in this worktree, this import resolves once the
 * orchestrator merges the connections branch; the route + the `more-link-connections` link are
 * intentionally shipped here so the wiring is ready on merge.
 */
export default function ConnectionsRoute() {
    return (
        <>
            <Stack.Screen options={{ title: "Connections" }} />
            <ConnectionsScreen />
        </>
    );
}
