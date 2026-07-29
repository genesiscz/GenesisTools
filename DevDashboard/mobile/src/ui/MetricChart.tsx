import interMedium from "@expo-google-fonts/inter/500Medium/Inter_500Medium.ttf";
import { LinearGradient, useFont, vec } from "@shopify/react-native-skia";
import { useMemo } from "react";
import { Text, View } from "react-native";
import { Area, CartesianChart } from "victory-native";
import { Card } from "@/ui/Card";
import { SectionHeader } from "@/ui/SectionHeader";
import { useThemeColors } from "@/theme/colors";

/** A single plotted point. `ts` is epoch ms (callers map any ISO string before passing). */
export interface MetricPoint {
    ts: number;
    value: number;
}

/**
 * Tier-1 SHARED chart primitive (ADR §6 `MetricChart` contract). `VictoryMetricChart` is the active
 * impl (victory-native XL, Skia GPU); `GraphMetricChart` (react-native-graph) / `SkiaMetricChart`
 * (hand-drawn Skia) are swappable but unbuilt — the registration seam is the single
 * `export const MetricChart = VictoryMetricChart` at the bottom, so swapping the lib touches one
 * line, not feature code. Generic: no feature import; the x-tick formatter is injectable.
 */
export interface MetricChartProps {
    title: string;
    points: MetricPoint[];
    unit?: string;
    domain?: [number, number];
    /** "area" = full panel with axes + glowing gradient; "sparkline" = compact, no axes. */
    variant?: "area" | "sparkline";
    /** Format an epoch-ms x value for the axis tick (default: 24h HH:MM). */
    formatX?: (ms: number) => string;
    /** testID for the chart container (Appium locates this; the Skia canvas itself is opaque). */
    testID: string;
}

const AREA_HEIGHT = 180;
const SPARK_HEIGHT = 56;

function defaultFormatX(ms: number): string {
    return new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(ms));
}

export function VictoryMetricChart({
    title,
    points,
    unit,
    domain = [0, 100],
    variant = "area",
    formatX = defaultFormatX,
    testID,
}: MetricChartProps) {
    const c = useThemeColors();
    const font = useFont(interMedium, 10);

    const data = useMemo(() => points.map((p) => ({ ts: p.ts, value: Math.round(p.value * 10) / 10 })), [points]);
    const isSpark = variant === "sparkline";
    const height = isSpark ? SPARK_HEIGHT : AREA_HEIGHT;

    const chart = (
        <View testID={testID} accessibilityLabel={`${title} chart`} style={{ height }}>
            {data.length === 0 ? (
                <View className="flex-1 items-center justify-center">
                    <Text style={{ color: c.textMuted, fontFamily: "monospace" }}>—</Text>
                </View>
            ) : (
                <CartesianChart
                    data={data}
                    xKey="ts"
                    yKeys={["value"]}
                    domain={{ y: domain }}
                    padding={isSpark ? 0 : 4}
                    xAxis={
                        isSpark
                            ? undefined
                            : {
                                  font,
                                  lineColor: c.border,
                                  labelColor: c.textMuted,
                                  formatXLabel: (ms: number) => formatX(ms),
                              }
                    }
                    yAxis={
                        isSpark
                            ? undefined
                            : [
                                  {
                                      font,
                                      lineColor: c.border,
                                      labelColor: c.textMuted,
                                      formatYLabel: (v: number) => `${v}${unit ?? ""}`,
                                  },
                              ]
                    }
                >
                    {({ points: chartPoints, chartBounds }) => (
                        <Area
                            points={chartPoints.value}
                            y0={chartBounds.bottom}
                            color={c.accent}
                            curveType="natural"
                            animate={{ type: "timing", duration: 300 }}
                        >
                            <LinearGradient
                                start={vec(0, 0)}
                                end={vec(0, height)}
                                colors={[c.accentGradientFrom, c.accentGradientTo]}
                            />
                        </Area>
                    )}
                </CartesianChart>
            )}
        </View>
    );

    if (isSpark) {
        return (
            <View testID={`${testID}-wrap`} className="flex-1 gap-1">
                <Text
                    className="text-xs uppercase tracking-widest"
                    style={{ color: c.textMuted, fontFamily: "monospace" }}
                >
                    {title}
                </Text>
                {chart}
            </View>
        );
    }

    return (
        <Card testID={`${testID}-card`}>
            <SectionHeader title={title} />
            <View className="mt-3">{chart}</View>
        </Card>
    );
}

/**
 * The active chart impl. Swap to `GraphMetricChart` (react-native-graph) or `SkiaMetricChart`
 * (hand-drawn @shopify/react-native-skia escape hatch) here — both would implement
 * `MetricChartProps`; neither is built in this plan (ADR §6 "swappable but unbuilt").
 */
export const MetricChart = VictoryMetricChart;
