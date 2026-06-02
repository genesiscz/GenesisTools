import { Pressable, Text, View } from "react-native";
import { useThemeColors } from "@/theme/colors";

export const inputClass =
    "rounded-2xl border border-white/10 bg-dd-bg-base px-4 py-3.5 text-[15px] text-dd-text-primary";
export const placeholderColor = "#5b6670";

/**
 * Soft mesh-orb glow layer — the same Obsidian-Terminal background "wow" the Connect screen uses, so
 * the Connections screen reads as part of the same surface. Purely decorative + non-interactive.
 */
export function MeshOrbs() {
    const c = useThemeColors();

    return (
        <View pointerEvents="none" className="absolute inset-0 overflow-hidden">
            <View
                className="absolute h-80 w-80 rounded-full opacity-[0.16]"
                style={{ backgroundColor: c.accent, top: -130, left: -100 }}
            />
            <View
                className="absolute h-72 w-72 rounded-full opacity-[0.12]"
                style={{ backgroundColor: "#8b5cf6", top: "40%", right: -120 }}
            />
        </View>
    );
}

/** Mono uppercase eyebrow label — the "signature tell" of this design system. */
export function Eyebrow({ label, tone = "accent" }: { label: string; tone?: "accent" | "violet" }) {
    const c = useThemeColors();
    const fg = tone === "violet" ? "#a78bfa" : c.accent;

    return (
        <View className="self-start rounded-full border border-white/10 bg-white/[0.04] px-3 py-1">
            <Text
                className="text-[10px] font-bold uppercase tracking-[0.2em]"
                style={{ color: fg, fontFamily: "monospace" }}
            >
                {label}
            </Text>
        </View>
    );
}

/** Primary emerald pressable (the design system's CTA). */
export function PrimaryButton({
    label,
    onPress,
    accessibilityLabel,
    testID,
    disabled = false,
}: {
    label: string;
    onPress: () => void;
    accessibilityLabel: string;
    testID?: string;
    disabled?: boolean;
}) {
    return (
        <Pressable
            testID={testID}
            accessibilityLabel={accessibilityLabel}
            accessibilityState={{ disabled }}
            disabled={disabled}
            onPress={onPress}
            className={`rounded-2xl bg-dd-accent-from px-5 py-3.5 active:scale-[0.98] ${disabled ? "opacity-50" : ""}`}
            style={{ borderCurve: "continuous" }}
        >
            <Text className="text-center text-[15px] font-bold text-dd-bg-base">{label}</Text>
        </Pressable>
    );
}

/** Ghost pressable (secondary action) — translucent glass with hairline border. */
export function GhostButton({
    label,
    onPress,
    accessibilityLabel,
    testID,
    tone = "neutral",
}: {
    label: string;
    onPress: () => void;
    accessibilityLabel: string;
    testID?: string;
    tone?: "neutral" | "danger";
}) {
    const c = useThemeColors();
    const textColor = tone === "danger" ? c.danger : c.textPrimary;

    return (
        <Pressable
            testID={testID}
            accessibilityLabel={accessibilityLabel}
            onPress={onPress}
            className="rounded-2xl border border-white/10 bg-white/[0.04] px-5 py-3.5 active:opacity-80"
            style={{ borderCurve: "continuous" }}
        >
            <Text className="text-center text-[15px] font-semibold" style={{ color: textColor }}>
                {label}
            </Text>
        </Pressable>
    );
}
