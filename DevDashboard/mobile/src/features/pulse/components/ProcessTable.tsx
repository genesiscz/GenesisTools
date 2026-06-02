import type { TopProcess } from "@dd/contract";
import { Text, View } from "react-native";
import { DASH } from "@/features/pulse/units";
import { Card } from "@/ui/Card";
import { ListRow } from "@/ui/ListRow";
import { SectionHeader } from "@/ui/SectionHeader";
import { useThemeColors } from "@/theme/colors";

interface ProcessTableProps {
    processes: TopProcess[];
}

export function ProcessTable({ processes }: ProcessTableProps) {
    const c = useThemeColors();

    return (
        <Card testID="pulse-process-table">
            <SectionHeader title="Top RAM" />
            {processes.length === 0 ? (
                <Text className="mt-3" style={{ color: c.textMuted, fontFamily: "monospace" }}>
                    {DASH}
                </Text>
            ) : (
                <View className="mt-3 gap-2">
                    {processes.map((p) => (
                        <ListRow key={p.pid} primary={p.name} trailing={`${(p.rssBytes / 1024 / 1024).toFixed(0)} MB`} />
                    ))}
                </View>
            )}
        </Card>
    );
}
