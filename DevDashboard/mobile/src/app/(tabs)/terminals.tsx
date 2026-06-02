import { Feather } from "@expo/vector-icons";
import { useFocusEffect } from "expo-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Alert, KeyboardAvoidingView, Platform, Pressable, ScrollView, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useAttentionTargetStore } from "@/features/needs-input-inbox/attention-target-store";
import { DriverSwitcher } from "@/features/terminals/components/DriverSwitcher";
// Side-effect import: registers BOTH drivers so `listDrivers()` is non-empty for the switcher.
import { WebViewHtmlRenderer, WebViewTtydRenderer } from "@/features/terminals/components/drivers";
import { MobileKeyBar } from "@/features/terminals/components/MobileKeyBar";
import { SessionsList } from "@/features/terminals/components/SessionsList";
import { useDriverStore } from "@/features/terminals/driver-store";
import { useRenameTtyd } from "@/features/terminals/hooks";
import { resolveDriver } from "@/features/terminals/registry";
import type {
    TerminalExitReason,
    TerminalRenderer,
    TerminalStatus,
} from "@/features/terminals/TerminalRenderer";
import { MockBadge } from "@/ui/MockBadge";
import { StatusPill } from "@/ui/StatusPill";
import { useThemeColors } from "@/theme/colors";

interface OpenSession {
    id: string;
    title?: string;
}

const STATUS_TONE: Record<TerminalStatus, "accent" | "muted" | "danger"> = {
    idle: "muted",
    connecting: "muted",
    connected: "accent",
    disconnected: "danger",
    ended: "muted",
    error: "danger",
};

/**
 * Terminals tab (D12). One screen, master → detail: a session inventory (tmux/ttyd/cmux) that opens
 * a selected ttyd session in the active WebView driver, plus the in-app driver switcher and the
 * touch key bar. Spawn/kill/rename/create flow through the SessionsList's hooks. Flipping the driver
 * re-attaches the open session under the new engine.
 *
 * The two driver components are imported (above) for their `registerDriver` side-effects; the active
 * one is resolved by id from the persisted `useDriverStore`. WebView terminal rendering is inherently
 * device-only (no DOM/WebView in a sim-less env) — see the terminals notes.
 *
 * NOTE TO ORCHESTRATOR (tab registration): this screen lives at `app/(tabs)/terminals.tsx` but is
 * NOT yet wired into `app/(tabs)/_layout.tsx` (a DO-NOT-TOUCH shared file). Register a
 * `<NativeTabs.Trigger name="terminals">` in the consolidation pass and reconcile the placeholder
 * `terminal.tsx` / `sessions.tsx` tabs (this screen supersedes both).
 */
export default function TerminalsScreen() {
    const c = useThemeColors();
    const insets = useSafeAreaInsets();
    const driverId = useDriverStore((s) => s.driver);
    const hydrate = useDriverStore((s) => s.hydrate);

    const [open, setOpen] = useState<OpenSession | null>(null);
    const [status, setStatus] = useState<TerminalStatus>("idle");
    const rendererRef = useRef<TerminalRenderer | null>(null);
    const rename = useRenameTtyd();

    useEffect(() => {
        void hydrate();
    }, [hydrate]);

    // Deep-link handoff: when the Needs-Input Inbox stashed a ttyd id, open it on focus then clear it.
    // No-op (and zero behavior change) when the store is empty.
    useFocusEffect(
        useCallback(() => {
            const pendingTtydId = useAttentionTargetStore.getState().pendingTtydId;
            if (!pendingTtydId) {
                return;
            }

            setOpen({ id: pendingTtydId });
            useAttentionTargetStore.getState().setPendingTtydId(null);
        }, []),
    );

    const driver = useMemo(() => resolveDriver(driverId), [driverId]);
    const DriverComponent = driver?.component ?? WebViewTtydRenderer;
    // Reference the html driver so the side-effect import is retained by the bundler.
    void WebViewHtmlRenderer;

    const callbacks = useMemo(
        () => ({
            onStatus: (next: TerminalStatus) => setStatus(next),
            onExit: (_reason: TerminalExitReason) => setStatus("disconnected"),
        }),
        [],
    );

    const handleOpen = useCallback((ttydId: string, title?: string) => {
        setOpen({ id: ttydId, title });
    }, []);

    // Attach whenever the open session OR the active driver changes (driver flip = detach+reattach).
    useEffect(() => {
        const renderer = rendererRef.current;
        if (!renderer || !open) {
            return;
        }

        void renderer.attach({ id: open.id, title: open.title }, callbacks);
    }, [open, driverId, callbacks]);

    const closeTerminal = useCallback(() => {
        void rendererRef.current?.detach();
        setOpen(null);
        setStatus("idle");
    }, []);

    // Rename the open ttyd terminal from the detail header (web parity). Optimistically updates the
    // header title on success so the change shows without waiting for the next list refetch.
    const renameOpen = useCallback(() => {
        if (!open || typeof Alert.prompt !== "function") {
            return;
        }

        const current = open.title ?? open.id;
        Alert.prompt(
            "Rename terminal",
            undefined,
            (next) => {
                const name = next?.trim();
                if (!name || name === current) {
                    return;
                }

                rename.mutate(
                    { id: open.id, name },
                    { onSuccess: () => setOpen((prev) => (prev ? { ...prev, title: name } : prev)) },
                );
            },
            "plain-text",
            current,
        );
    }, [open, rename]);

    return (
        <View testID="screen-terminals" style={{ flex: 1, backgroundColor: c.bgBase, paddingTop: insets.top + 8 }}>
            <View
                style={{
                    flexDirection: "row",
                    alignItems: "center",
                    justifyContent: "space-between",
                    paddingHorizontal: 16,
                    marginBottom: 8,
                }}
            >
                <Text
                    accessibilityRole="header"
                    style={{ color: c.accent, fontFamily: "monospace", fontSize: 22, fontWeight: "700", letterSpacing: 2 }}
                >
                    TERMINALS_
                </Text>
                <StatusPill
                    testID="terminal-status"
                    label={status}
                    tone={STATUS_TONE[status]}
                    dot={status === "connected"}
                />
            </View>

            {open ? (
                <KeyboardAvoidingView
                    style={{ flex: 1 }}
                    behavior={Platform.OS === "ios" ? "padding" : undefined}
                    keyboardVerticalOffset={insets.top + 8}
                >
                    <View
                        style={{
                            flexDirection: "row",
                            alignItems: "center",
                            justifyContent: "space-between",
                            paddingHorizontal: 16,
                            paddingBottom: 8,
                        }}
                    >
                        <Pressable
                            testID="btn-rename-terminal"
                            accessibilityLabel="btn-rename-terminal"
                            accessibilityRole="button"
                            onPress={renameOpen}
                            style={{ flex: 1, flexDirection: "row", alignItems: "center", gap: 8, paddingRight: 8 }}
                        >
                            <Text numberOfLines={1} style={{ color: c.textSecondary, fontFamily: "monospace", flexShrink: 1 }}>
                                {open.title ?? open.id}
                            </Text>
                            <Feather name="edit-2" size={13} color={c.textMuted} />
                        </Pressable>
                        <Pressable
                            testID="btn-close-terminal"
                            accessibilityLabel="btn-close-terminal"
                            accessibilityRole="button"
                            onPress={closeTerminal}
                            style={{ paddingHorizontal: 12, paddingVertical: 6 }}
                        >
                            <Text style={{ color: c.danger, fontFamily: "monospace" }}>Close</Text>
                        </Pressable>
                    </View>

                    <View testID="terminal-surface" style={{ flex: 1 }}>
                        <DriverComponent ref={rendererRef} session={{ id: open.id, title: open.title }} callbacks={callbacks} />
                    </View>

                    <MobileKeyBar renderer={rendererRef.current} />
                </KeyboardAvoidingView>
            ) : (
                <ScrollView contentContainerStyle={{ padding: 16, gap: 16, paddingBottom: insets.bottom + 24 }}>
                    <MockBadge />
                    <DriverSwitcher />
                    <SessionsList onOpen={handleOpen} />
                </ScrollView>
            )}
        </View>
    );
}
