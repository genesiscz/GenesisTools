import type { WeatherSnapshot } from "@dd/contract";
import { Text, View } from "react-native";
import { clock, DASH, temp } from "@/features/weather/units";
import { Card } from "@/ui/Card";
import { SectionHeader } from "@/ui/SectionHeader";
import { StatusPill } from "@/ui/StatusPill";
import { useThemeColors } from "@/theme/colors";

interface WeatherCardProps {
    /** The snapshot, or null while loading / on a failed fetch. */
    snapshot: WeatherSnapshot | null;
    /** True while the first fetch is in flight (drives the loading pill). */
    loading?: boolean;
}

/**
 * Compact weather card (feature-local Tier-2 component). Presentational only — it takes a resolved
 * `WeatherSnapshot` and renders the temp, description, label, and sunrise/sunset. Feature-local
 * (NOT the pulse `WeatherCard`, which is owned by the pulse feature) so this feature stays
 * self-contained. testID `weather-card` is the Appium locator.
 */
export function WeatherCard({ snapshot, loading = false }: WeatherCardProps) {
    const c = useThemeColors();
    const unavailable = snapshot != null && snapshot.error != null;

    return (
        <Card testID="weather-card" className="gap-2">
            <View className="flex-row items-center justify-between">
                <SectionHeader title="Weather" />
                {loading ? <StatusPill label="Loading" tone="muted" testID="weather-loading-pill" /> : null}
            </View>

            <Text testID="weather-label" className="text-xs" style={{ color: c.textMuted, fontFamily: "monospace" }}>
                {snapshot?.label || DASH}
            </Text>

            {unavailable ? (
                <Text testID="weather-error" style={{ color: c.textMuted, fontFamily: "monospace" }}>
                    Unavailable
                </Text>
            ) : (
                <>
                    <Text
                        testID="weather-temp"
                        className="text-3xl font-bold"
                        style={{ color: c.textPrimary, fontFamily: "monospace" }}
                    >
                        {temp(snapshot?.tempC ?? null)}
                    </Text>
                    <Text style={{ color: c.textSecondary, fontFamily: "monospace" }}>
                        {snapshot?.description || DASH}
                    </Text>
                    <View className="mt-1 flex-row justify-between">
                        <Text className="text-xs" style={{ color: c.textMuted, fontFamily: "monospace" }}>
                            ↑ {clock(snapshot?.sunrise ?? null)}
                        </Text>
                        <Text className="text-xs" style={{ color: c.textMuted, fontFamily: "monospace" }}>
                            ↓ {clock(snapshot?.sunset ?? null)}
                        </Text>
                    </View>
                </>
            )}
        </Card>
    );
}
