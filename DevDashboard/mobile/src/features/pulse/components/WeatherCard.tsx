import { Text, View } from "react-native";
import { DASH, formatClock } from "@/features/pulse/units";
import { Card } from "@/ui/Card";
import { SectionHeader } from "@/ui/SectionHeader";
import { useThemeColors } from "@/theme/colors";

interface WeatherCardProps {
    tempC: number | null;
    description: string;
    sunrise: string | null;
    sunset: string | null;
    label: string;
    error?: string;
}

export function WeatherCard({ tempC, description, sunrise, sunset, label, error }: WeatherCardProps) {
    const c = useThemeColors();

    return (
        <Card testID="pulse-weather-card" className="gap-2">
            <SectionHeader title="Weather" />
            <Text className="text-xs" style={{ color: c.textMuted, fontFamily: "monospace" }}>
                {label || DASH}
            </Text>
            {error ? (
                <Text style={{ color: c.textMuted, fontFamily: "monospace" }}>Unavailable</Text>
            ) : (
                <>
                    <Text className="text-3xl font-bold" style={{ color: c.textPrimary, fontFamily: "monospace" }}>
                        {tempC === null ? DASH : `${tempC.toFixed(1)}°C`}
                    </Text>
                    <Text style={{ color: c.textSecondary, fontFamily: "monospace" }}>{description || DASH}</Text>
                    <View className="mt-1 flex-row justify-between">
                        <Text className="text-xs" style={{ color: c.textMuted, fontFamily: "monospace" }}>
                            ↑ {formatClock(sunrise)}
                        </Text>
                        <Text className="text-xs" style={{ color: c.textMuted, fontFamily: "monospace" }}>
                            ↓ {formatClock(sunset)}
                        </Text>
                    </View>
                </>
            )}
        </Card>
    );
}
