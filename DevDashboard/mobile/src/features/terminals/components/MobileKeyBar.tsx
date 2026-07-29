import { useCallback, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import type { TerminalKey, TerminalRenderer } from "@/features/terminals/TerminalRenderer";
import { useThemeColors } from "@/theme/colors";

/**
 * Touch-tuned key bar that sits above the keyboard and feeds the active `TerminalRenderer`. It sends
 * the keys a mobile soft-keyboard can't: a STICKY Ctrl modifier (next key is sent with ctrl, then it
 * auto-clears), Esc, Tab, the four arrows, PageUp/Down, Paste, and common shell punctuation
 * (`/ - _ | ~ : .` etc.). Named keys go through `renderer.sendKey`; characters through
 * `renderer.sendInput` (or `renderer.sendKey(char,{ctrl})` when Ctrl is sticky). Every button carries
 * an `accessibilityLabel` (`key-<id>`) for Appium.
 *
 * Paste: there is no clipboard lib in the project (adding `expo-clipboard` is a D20 lib decision —
 * flagged in the terminals notes). The Paste button therefore delegates to an `onPaste` callback the
 * screen supplies; until a clipboard module is added it is a documented no-op.
 */

interface MobileKeyBarProps {
    renderer: TerminalRenderer | null;
    /** Supplies clipboard text for the Paste key (screen-owned; no clipboard lib in-project yet). */
    onPaste?: () => void;
}

const NAMED_KEYS: { id: string; label: string; key: TerminalKey }[] = [
    { id: "esc", label: "Esc", key: "Escape" },
    { id: "tab", label: "Tab", key: "Tab" },
    { id: "up", label: "↑", key: "ArrowUp" },
    { id: "down", label: "↓", key: "ArrowDown" },
    { id: "left", label: "←", key: "ArrowLeft" },
    { id: "right", label: "→", key: "ArrowRight" },
    { id: "pgup", label: "PgUp", key: "PageUp" },
    { id: "pgdn", label: "PgDn", key: "PageDown" },
];

const PUNCT: string[] = ["/", "-", "_", "|", "~", ":", ".", "*", "$", "&"];

export function MobileKeyBar({ renderer, onPaste }: MobileKeyBarProps) {
    const c = useThemeColors();
    const [ctrl, setCtrl] = useState(false);

    const sendChar = useCallback(
        (char: string) => {
            if (!renderer) {
                return;
            }

            if (ctrl) {
                renderer.sendKey(char as TerminalKey, { ctrl: true });
                setCtrl(false);
                return;
            }

            renderer.sendInput(char);
        },
        [renderer, ctrl],
    );

    const sendNamed = useCallback(
        (key: TerminalKey) => {
            renderer?.sendKey(key, ctrl ? { ctrl: true } : undefined);
            if (ctrl) {
                setCtrl(false);
            }
        },
        [renderer, ctrl],
    );

    const keyButton = (id: string, label: string, onPress: () => void, sticky = false) => (
        <Pressable
            key={id}
            testID={`key-${id}`}
            accessibilityLabel={`key-${id}`}
            accessibilityRole="button"
            onPress={onPress}
            style={{
                paddingHorizontal: 12,
                paddingVertical: 8,
                marginRight: 6,
                borderRadius: 8,
                borderWidth: 1,
                borderColor: sticky ? c.accent : c.border,
                backgroundColor: sticky ? c.accentMuted : c.bgPanel,
            }}
        >
            <Text style={{ color: sticky ? c.accent : c.textPrimary, fontFamily: "monospace", fontSize: 13 }}>
                {label}
            </Text>
        </Pressable>
    );

    return (
        <View
            testID="terminal-key-bar"
            style={{ borderTopWidth: 1, borderTopColor: c.border, backgroundColor: c.bgBase, paddingVertical: 8 }}
        >
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ paddingHorizontal: 8 }}>
                {keyButton("ctrl", "Ctrl", () => setCtrl((v) => !v), ctrl)}
                {NAMED_KEYS.map((k) => keyButton(k.id, k.label, () => sendNamed(k.key)))}
                {keyButton("paste", "Paste", () => onPaste?.())}
                {PUNCT.map((ch) => keyButton(`punct-${ch}`, ch, () => sendChar(ch)))}
            </ScrollView>
        </View>
    );
}
