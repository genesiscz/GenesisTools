import { Pressable, Text, View } from "react-native";
import { useDriverStore } from "@/features/terminals/driver-store";
import { driverUsable, listDrivers, usableDriver } from "@/features/terminals/registry";
import { useTierCapabilities } from "@/state/connection-store";
import { useThemeColors } from "@/theme/colors";

const UNAVAILABLE_REASON = "Not on this connection: it cannot load the Mac's pages by plain URL.";

/**
 * In-app terminal driver switcher (D12). Renders one segment per registered driver (Driver A / B)
 * and writes the choice to the persisted `useDriverStore` (→ `dd.terminalDriver` pref). The active
 * driver is highlighted with the accent. Flipping it re-attaches the current session under the new
 * engine (the screen owns that effect). Appium finds the group by `setting-terminal-driver` and each segment by
 * its `testID` `driver-option-<id>`; a segment's accessible name is the driver's label (plus the reason when the
 * connection cannot run it), so a screen reader never reads the internal id.
 *
 * `listDrivers()` is non-empty because the Terminal screen imports `components/drivers.ts`, whose
 * module-load side-effects register both drivers (see that barrel's note).
 *
 * A driver the connection's tier cannot run (ttyd's plain page on the managed relay) is shown disabled with the
 * reason, and the highlight marks the driver the terminal really runs (`usableDriver`).
 */
export function DriverSwitcher() {
    const c = useThemeColors();
    const saved = useDriverStore((s) => s.driver);
    const setDriver = useDriverStore((s) => s.setDriver);
    const plainUrls = useTierCapabilities()?.plainUrls ?? true;
    const driver = usableDriver({ id: saved, plainUrls })?.id ?? saved;
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
                    const usable = driverUsable(d, plainUrls);
                    const detail = usable ? d.blurb : UNAVAILABLE_REASON;

                    return (
                        <Pressable
                            key={d.id}
                            testID={`driver-option-${d.id}`}
                            accessibilityLabel={usable ? d.label : `${d.label}. ${UNAVAILABLE_REASON}`}
                            accessibilityHint={usable ? d.blurb : undefined}
                            accessibilityRole="button"
                            accessibilityState={{ selected: isActive, disabled: !usable }}
                            disabled={!usable}
                            onPress={() => setDriver(d.id)}
                            style={{
                                opacity: usable ? 1 : 0.5,
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
                            <Text style={{ color: c.textMuted, fontSize: 11, marginTop: 2 }}>
                                {detail}
                            </Text>
                        </Pressable>
                    );
                })}
            </View>
        </View>
    );
}
