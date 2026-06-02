import { Feather } from "@expo/vector-icons";
import { type Href, router } from "expo-router";
import { Pressable, Text, View } from "react-native";
import { Card } from "@/ui/Card";
import { Screen } from "@/ui/Screen";
import { SectionHeader } from "@/ui/SectionHeader";
import { useThemeColors } from "@/theme/colors";

type FeatherName = keyof typeof Feather.glyphMap;

interface MoreLink {
    title: string;
    route: Href;
    testID: string;
    icon: FeatherName;
}

interface MoreGroup {
    heading: string;
    links: MoreLink[];
}

/**
 * The "More" hub, grouped into purpose-driven sections instead of a single cramped Card. Each group
 * is its own `<Card>` with a `SectionHeader` and comfortable, tappable rows (leading accent icon +
 * label + chevron). "Configuration" leads (the connections/agent setup entry — the most common
 * reason to open More), then Insights / System / Environment.
 *
 * Rows are rendered inline here (not via the shared `@/ui/ListRow`) because they need a LEADING icon,
 * which `ListRow` doesn't expose — and `ListRow` is a shared primitive this feature must not modify.
 * All `more-link-*` testIDs are preserved; `more-link-connections` is new (routes to the
 * `(more)/connections` screen that renders the connections feature built by the connections agent).
 */
const MORE_GROUPS: MoreGroup[] = [
    {
        heading: "Attention",
        links: [
            { title: "Needs Input", route: "/needs-input-inbox", testID: "more-link-needs-input-inbox", icon: "inbox" },
        ],
    },
    {
        heading: "Configuration",
        links: [
            { title: "Connections", route: "/connections", testID: "more-link-connections", icon: "link" },
            { title: "Network", route: "/network-status", testID: "more-link-network-status", icon: "activity" },
        ],
    },
    {
        heading: "Workflow",
        links: [
            { title: "Quick Commands", route: "/quick-commands", testID: "more-link-quick-commands", icon: "command" },
        ],
    },
    {
        heading: "Productivity",
        links: [
            { title: "Reminders", route: "/reminders-todos", testID: "more-link-reminders-todos", icon: "check-square" },
        ],
    },
    {
        heading: "Terminals",
        links: [
            { title: "Tmux Presets", route: "/tmux-presets", testID: "more-link-tmux-presets", icon: "save" },
        ],
    },
    {
        heading: "Insights",
        links: [
            { title: "Activity", route: "/activity-timeline", testID: "more-link-activity-timeline", icon: "activity" },
            { title: "Claude Usage", route: "/claude-usage", testID: "more-link-claude-usage", icon: "bar-chart-2" },
        ],
    },
    {
        heading: "System",
        links: [
            { title: "Daemon", route: "/daemon", testID: "more-link-daemon", icon: "cpu" },
            { title: "Build Log", route: "/build-log-tail", testID: "more-link-build-log-tail", icon: "terminal" },
            { title: "Containers", route: "/containers", testID: "more-link-containers", icon: "box" },
            { title: "Disk Janitor", route: "/disk-janitor", testID: "more-link-disk-janitor", icon: "hard-drive" },
            { title: "Port Killer", route: "/port-killer", testID: "more-link-port-killer", icon: "crosshair" },
            { title: "Process Monitor", route: "/process-monitor", testID: "more-link-process-monitor", icon: "activity" },
        ],
    },
    {
        heading: "Environment",
        links: [{ title: "Weather", route: "/weather", testID: "more-link-weather", icon: "cloud" }],
    },
];

export default function MoreScreen() {
    const c = useThemeColors();

    return (
        <Screen testID="screen-more">
            <SectionHeader title="More" />

            <View className="gap-5">
                {MORE_GROUPS.map((group) => (
                    <View key={group.heading} className="gap-2">
                        <SectionHeader title={group.heading} uppercase />
                        <Card bezel className="gap-1">
                            {group.links.map((link) => (
                                <Pressable
                                    key={link.testID}
                                    testID={link.testID}
                                    accessibilityRole="button"
                                    accessibilityLabel={link.title}
                                    onPress={() => router.push(link.route)}
                                    className="flex-row items-center gap-3 py-3"
                                >
                                    <Feather name={link.icon} size={16} color={c.accent} />
                                    <Text
                                        numberOfLines={1}
                                        className="flex-1"
                                        style={{ color: c.textPrimary, fontFamily: "monospace" }}
                                    >
                                        {link.title}
                                    </Text>
                                    <Feather name="chevron-right" size={16} color={c.textMuted} />
                                </Pressable>
                            ))}
                        </Card>
                    </View>
                ))}
            </View>
        </Screen>
    );
}
