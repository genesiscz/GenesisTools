import { Feather } from "@expo/vector-icons";
import type { TimelineEvent } from "@dd/contract";
import { Text, View } from "react-native";
import { eventTime, eventVisual } from "@/features/activity-timeline/units";
import { StatusPill } from "@/ui/StatusPill";
import { useThemeColors } from "@/theme/colors";

interface EventRowProps {
    event: TimelineEvent;
}

/**
 * One timeline event (feature-local Tier-2): leading local time + a type-colored icon on the
 * timeline spine, the title + dim subtitle, and a trailing type pill. testID `timeline-event-<id>`
 * (id is source-unique and already prefixed by type).
 */
export function EventRow({ event }: EventRowProps) {
    const c = useThemeColors();
    const visual = eventVisual(event);
    const iconColor = visual.tone === "danger" ? c.danger : visual.tone === "accent" ? c.accent : c.textSecondary;

    return (
        <View
            testID={`timeline-event-${event.id}`}
            accessibilityLabel={`timeline-event-${event.id}`}
            className="flex-row items-start gap-3 py-3"
        >
            <Text className="w-12 text-xs" style={{ color: c.textMuted, fontFamily: "monospace" }}>
                {eventTime(event.ts)}
            </Text>
            <View
                className="mt-0.5 h-6 w-6 items-center justify-center rounded-full"
                style={{ backgroundColor: c.bgPanel, borderWidth: 1, borderColor: c.border }}
            >
                <Feather name={visual.icon} size={12} color={iconColor} />
            </View>
            <View className="flex-1 gap-0.5">
                <Text numberOfLines={1} style={{ color: c.textPrimary, fontFamily: "monospace" }}>
                    {event.title}
                </Text>
                {event.subtitle ? (
                    <Text numberOfLines={1} className="text-xs" style={{ color: c.textMuted, fontFamily: "monospace" }}>
                        {event.subtitle}
                    </Text>
                ) : null}
            </View>
            <StatusPill label={visual.pillLabel} tone={visual.tone} />
        </View>
    );
}
