import { Pressable, Text, View } from "react-native";
import { useDriverStore } from "@/features/terminals/driver-store";
import { listDrivers } from "@/features/terminals/registry";
import { useThemeColors } from "@/theme/colors";

/**
 * In-app terminal driver switcher (D12). Renders one segment per registered driver (Driver A / B)
 * and writes the choice to the persisted `useDriverStore` (→ `dd.terminalDriver` pref). The active
 * driver is highlighted with the accent. Flipping it re-attaches the current session under the new
 * engine (the screen owns that effect). `accessibilityLabel` `setting-terminal-driver` on the group
 * + `driver-option-<id>` per segment for Appium.
 *
 * `listDrivers()` is non-empty because the Terminal screen imports `components/drivers.ts`, whose
 * module-load side-effects register both drivers (see that barrel's note).
 */
export function DriverSwitcher() {
    const c = useThemeColors();
    const driver = useDriverStore((s) => s.driver);
    const setDriver = useDriverStore((s) => s.setDriver);
    const drivers = listDrivers();

    return (
        <View testID="setting-terminal-driver" accessibilityLabel="setting-terminal-driver">
            <Text
                style={{
                    color: c.textMuted,
                    fontFamily: "monospace",
                    fontSize: 11,
                    letterSpacing: 1,
                    marginBottom: 6,
                    textTransform: "uppercase",
                }}
            >
                Terminal engine
            </Text>
            <View style={{ flexDirection: "row", gap: 8 }}>
                {drivers.map((d) => {
                    const isActive = d.id === driver;

                    return (
                        <Pressable
                            key={d.id}
                            testID={`driver-option-${d.id}`}
                            accessibilityLabel={`driver-option-${d.id}`}
                            accessibilityRole="button"
                            accessibilityState={{ selected: isActive }}
                            onPress={() => setDriver(d.id)}
                            style={{
                                flex: 1,
                                paddingVertical: 10,
                                paddingHorizontal: 12,
                                borderRadius: 10,
                                borderWidth: 1,
                                borderColor: isActive ? c.accent : c.border,
                                backgroundColor: isActive ? c.accentMuted : c.bgPanel,
                            }}
                        >
                            <Text
                                style={{
                                    color: isActive ? c.accent : c.textPrimary,
                                    fontFamily: "monospace",
                                    fontSize: 13,
                                    fontWeight: "600",
                                }}
                            >
                                {d.label}
                            </Text>
                            <Text style={{ color: c.textMuted, fontSize: 11, marginTop: 2 }}>{d.blurb}</Text>
                        </Pressable>
                    );
                })}
            </View>
        </View>
    );
}
