import { Text, View } from "react-native";
import { EventRow } from "@/features/activity-timeline/components/EventRow";
import type { HourGroup as HourGroupModel } from "@/features/activity-timeline/types";
import { Card } from "@/ui/Card";
import { useThemeColors } from "@/theme/colors";

interface HourGroupProps {
    group: HourGroupModel;
}

/**
 * One hour bucket: a sticky-feeling header (`timeline-hour-<HH>`) above a Card holding its event
 * rows. The header is the assertable group boundary in the Appium spec.
 */
export function HourGroup({ group }: HourGroupProps) {
    const c = useThemeColors();

    return (
        <View className="gap-2">
            <Text
                testID={`timeline-hour-${group.hourKey}`}
                accessibilityRole="header"
                accessibilityLabel={`timeline-hour-${group.hourKey}`}
                className="text-xs font-bold uppercase tracking-widest"
                style={{ color: c.textSecondary, fontFamily: "monospace" }}
            >
                {group.label}
            </Text>
            <Card className="gap-0">
                {group.events.map((event) => (
                    <EventRow key={event.id} event={event} />
                ))}
            </Card>
        </View>
    );
}
