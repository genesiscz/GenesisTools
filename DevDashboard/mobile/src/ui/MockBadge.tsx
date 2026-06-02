import { useIsMockClient } from "@/api/client-provider";
import { StatusPill } from "@/ui/StatusPill";

/**
 * A small pill shown on any screen while the mock client is active (no device connected), so the
 * fixtures are never mistaken for live data. Renders nothing once a real transport is connected.
 * Shared across all feature screens — drop it near a screen header.
 */
export function MockBadge() {
    const isMock = useIsMockClient();

    if (!isMock) {
        return null;
    }

    return <StatusPill testID="mock-data-badge" label="Mock data" tone="accent" dot />;
}
