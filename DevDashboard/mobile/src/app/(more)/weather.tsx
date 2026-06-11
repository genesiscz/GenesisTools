import { Stack } from "expo-router";
import { ScrollView } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { WeatherCard } from "@/features/weather/components/WeatherCard";
import { useWeatherCard } from "@/features/weather/hooks";
import { MockBadge } from "@/ui/MockBadge";

/**
 * Standalone Weather screen — a thin composition of the feature's `useWeatherCard` hook + the
 * compact `WeatherCard`. Weather is primarily a CARD (Pulse renders its own copy); this screen is
 * the "More" entry for a focused view. Consumes the per-feature hook (D32 — never raw useQuery).
 */
export default function WeatherScreen() {
    const insets = useSafeAreaInsets();
    const weather = useWeatherCard();

    return (
        <>
            <Stack.Screen options={{ title: "Weather" }} />
            <ScrollView
                testID="screen-weather"
                accessibilityLabel="screen-weather"
                className="flex-1 bg-dd-bg-base"
                contentContainerStyle={{ padding: 16, paddingTop: insets.top + 8, gap: 16 }}
            >
                <MockBadge />
                <WeatherCard snapshot={weather.data ?? null} loading={weather.isPending} />
            </ScrollView>
        </>
    );
}
