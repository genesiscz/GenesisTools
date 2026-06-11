import { View } from "react-native";
import { formatClock } from "@/features/pulse/units";
import { MetricChart, type MetricPoint } from "@/ui/MetricChart";

interface SparklineRowProps {
    cpu: MetricPoint[];
    memFree: MetricPoint[];
    swap: MetricPoint[];
}

const formatX = (ms: number) => formatClock(new Date(ms).toISOString());

/** Horizontal row of three compact glowing sparklines (CPU / mem-free / swap). */
export function SparklineRow({ cpu, memFree, swap }: SparklineRowProps) {
    return (
        <View testID="pulse-sparkline-row" className="flex-row gap-3">
            <MetricChart testID="spark-cpu" title="CPU" points={cpu} unit="%" variant="sparkline" formatX={formatX} />
            <MetricChart testID="spark-mem" title="MEM FREE" points={memFree} unit="%" variant="sparkline" formatX={formatX} />
            <MetricChart testID="spark-swap" title="SWAP" points={swap} unit="%" variant="sparkline" formatX={formatX} />
        </View>
    );
}
