import { Pressable, Text, View } from "react-native";
import { GhostButton, PrimaryButton } from "@/features/connections/components";
import { relativeTime, tierLabel } from "@/features/connections/format";
import type { SavedConnection } from "@/features/connections/types";
import { useThemeColors } from "@/theme/colors";
import { Card } from "@/ui/Card";
import { StatusPill } from "@/ui/StatusPill";

/** The glowing "active" dot (matches StatusPill's layered halo) shown next to the live connection. */
function ActiveDot() {
    const c = useThemeColors();

    return (
        <View className="relative h-2.5 w-2.5 items-center justify-center">
            <View
                className="absolute h-2.5 w-2.5 rounded-full opacity-40"
                style={{ backgroundColor: c.accent, transform: [{ scale: 2.2 }] }}
            />
            <View className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: c.accent }} />
        </View>
    );
}

export function ConnectionRow({
    connection,
    active,
    onActivate,
    onEdit,
    onDelete,
}: {
    connection: SavedConnection;
    active: boolean;
    onActivate: () => void;
    onEdit: () => void;
    onDelete: () => void;
}) {
    return (
        <Card bezel featured={active} className="gap-3">
            <View
                testID={`connection-row-${connection.id}`}
                accessibilityLabel={`connection-row-${connection.id}`}
                className="gap-3"
            >
                <View className="flex-row items-start justify-between gap-3">
                    <View className="flex-1 gap-1">
                        <View className="flex-row items-center gap-2">
                            {active ? <ActiveDot /> : null}
                            <Text
                                className="flex-1 text-[16px] font-bold text-dd-text-primary"
                                numberOfLines={1}
                            >
                                {connection.label}
                            </Text>
                        </View>
                        <Text
                            className="text-[13px] text-dd-text-secondary"
                            style={{ fontFamily: "monospace" }}
                            numberOfLines={1}
                        >
                            {connection.host}:{connection.port}
                        </Text>
                    </View>
                    <StatusPill label={tierLabel(connection.tier)} tone={active ? "accent" : "muted"} />
                </View>

                <Text className="text-[11px] text-dd-text-muted" style={{ fontFamily: "monospace" }}>
                    {active ? "ACTIVE · " : ""}last used {relativeTime(connection.lastUsedAt)}
                </Text>

                <View className="flex-row items-center gap-2 pt-1">
                    {active ? (
                        <View
                            testID={`connection-active-${connection.id}`}
                            accessibilityLabel={`connection-active-${connection.id}`}
                            className="flex-1 rounded-2xl border border-dd-accent-from/30 bg-dd-accent-from/[0.06] px-5 py-3.5"
                        >
                            <Text className="text-center text-[15px] font-bold text-dd-accent-from">
                                Connected
                            </Text>
                        </View>
                    ) : (
                        <View className="flex-1">
                            <PrimaryButton
                                testID={`btn-activate-${connection.id}`}
                                accessibilityLabel={`btn-activate-${connection.id}`}
                                label="Activate"
                                onPress={onActivate}
                            />
                        </View>
                    )}
                    <Pressable
                        testID={`btn-edit-${connection.id}`}
                        accessibilityLabel={`btn-edit-${connection.id}`}
                        onPress={onEdit}
                        className="rounded-2xl border border-white/10 bg-white/[0.04] px-4 py-3.5 active:opacity-80"
                        style={{ borderCurve: "continuous" }}
                    >
                        <Text className="text-[15px] font-semibold text-dd-text-primary">Edit</Text>
                    </Pressable>
                </View>

                <GhostButton
                    testID={`btn-delete-${connection.id}`}
                    accessibilityLabel={`btn-delete-${connection.id}`}
                    label="Delete"
                    tone="danger"
                    onPress={onDelete}
                />
            </View>
        </Card>
    );
}
