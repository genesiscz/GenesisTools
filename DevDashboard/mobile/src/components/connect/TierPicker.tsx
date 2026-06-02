import { Pressable, Text, View } from "react-native";
import { useThemeColors } from "@/theme/colors";
import type { TransportTier } from "@/transport/Transport";

const TIERS: { tier: TransportTier; title: string; subtitle: string; tag: string }[] = [
    { tier: "lan", title: "Same Wi-Fi (LAN)", subtitle: "Direct, nothing leaves your network", tag: "direct" },
    { tier: "tailscale", title: "Tailscale (trust-max)", subtitle: "Encrypted end-to-end over WireGuard", tag: "vpn" },
    { tier: "cloudflared-self", title: "My Cloudflare tunnel", subtitle: "Your own account — vendor never sees data", tag: "tunnel" },
    { tier: "managed", title: "Managed (one-tap)", subtitle: "Vendor relay, end-to-end encrypted on top", tag: "relay" },
];

/**
 * Tier picker, Obsidian-Terminal styled. Each option is a concentric "mini-bezel" row: a glass
 * outer shell wrapping a solid core; the selected row lights its ring + core to emerald, drops a
 * leading pulse dot, and tints the title. Keeps the stable `tier-option-*` / `tier-title-*`
 * accessibility labels the Appium page object depends on.
 */
export function TierPicker({
    selected,
    onSelect,
}: {
    selected: TransportTier | null;
    onSelect: (t: TransportTier) => void;
}) {
    const c = useThemeColors();

    return (
        <View accessibilityLabel="tier-picker" className="gap-2.5">
            {TIERS.map((t) => {
                const isActive = selected === t.tier;

                return (
                    <Pressable
                        key={t.tier}
                        accessibilityLabel={`tier-option-${t.tier}`}
                        accessibilityState={{ selected: isActive }}
                        onPress={() => onSelect(t.tier)}
                        className="rounded-[20px] border p-1 active:opacity-90"
                        style={{
                            borderCurve: "continuous",
                            borderColor: isActive ? c.accentGlow : "rgba(255,255,255,0.10)",
                            backgroundColor: isActive ? c.accentMuted : "rgba(255,255,255,0.03)",
                        }}
                    >
                        <View
                            className="flex-row items-center gap-3 rounded-[15px] border-t px-4 py-3.5"
                            style={{
                                borderCurve: "continuous",
                                borderTopColor: isActive ? c.accentGlow : "rgba(255,255,255,0.10)",
                                backgroundColor: c.bgPanel,
                            }}
                        >
                            <View
                                className="h-2.5 w-2.5 rounded-full"
                                style={{ backgroundColor: isActive ? c.accent : c.border }}
                            />
                            <View className="flex-1">
                                <Text
                                    accessibilityLabel={`tier-title-${t.tier}`}
                                    className="text-[15px] font-semibold"
                                    style={{ color: isActive ? c.accent : c.textPrimary }}
                                >
                                    {t.title}
                                </Text>
                                <Text className="mt-0.5 text-xs text-dd-text-secondary">{t.subtitle}</Text>
                            </View>
                            <Text
                                className="text-[10px] font-bold uppercase tracking-[0.18em]"
                                style={{ color: isActive ? c.accent : c.textMuted, fontFamily: "monospace" }}
                            >
                                {t.tag}
                            </Text>
                        </View>
                    </Pressable>
                );
            })}
        </View>
    );
}
