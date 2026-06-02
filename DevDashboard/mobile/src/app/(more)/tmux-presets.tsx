import { Stack } from "expo-router";
import { useState } from "react";
import { ActivityIndicator, Text, View } from "react-native";
import { CaptureSheet } from "@/features/tmux-presets/components/CaptureSheet";
import { PresetCard } from "@/features/tmux-presets/components/PresetCard";
import { type ConfirmState, RestoreConfirm } from "@/features/tmux-presets/components/RestoreConfirm";
import { useDeletePreset, usePresets, useRestorePreset } from "@/features/tmux-presets/hooks";
import { restoreOutcomeLine } from "@/features/tmux-presets/units";
import { Empty } from "@/ui/Empty";
import { MockBadge } from "@/ui/MockBadge";
import { Screen } from "@/ui/Screen";
import { SectionHeader } from "@/ui/SectionHeader";
import { useThemeColors } from "@/theme/colors";

/**
 * Tmux Presets screen — lists every saved layout preset, captures the current live tmux layout into a
 * new one, and restores/deletes a preset behind an explicit confirm dialog. Composes the feature off
 * the per-feature `usePresets`/`useCapturePreset`/`useRestorePreset`/`useDeletePreset` hooks (D32 —
 * never raw useQuery). Phone and the cmux CLI share the same preset library on disk.
 *
 * Uses `<Screen>` (a ScrollView, `displayed=true`) + a non-virtualized `.map()` of cards so the
 * `screen-tmux-presets` root stays displayed for Appium (the preset list is short). The single
 * `RestoreConfirm` modal is rendered once at screen level, driven by a `ConfirmState | null`.
 */
export default function TmuxPresetsScreen() {
    const c = useThemeColors();
    const presetsQuery = usePresets();
    const restore = useRestorePreset();
    const remove = useDeletePreset();

    const [confirm, setConfirm] = useState<ConfirmState | null>(null);
    const [resultLine, setResultLine] = useState<string | null>(null);

    const busy = restore.isPending || remove.isPending;

    const onConfirm = (): void => {
        if (!confirm) {
            return;
        }

        if (confirm.action === "restore") {
            restore.mutate(confirm.name, {
                onSuccess: (data) => setResultLine(`Restored "${confirm.name}": ${restoreOutcomeLine(data.result)}`),
                onSettled: () => setConfirm(null),
            });
            return;
        }

        remove.mutate(confirm.name, {
            onSettled: () => setConfirm(null),
        });
    };

    if (presetsQuery.isPending) {
        return (
            <>
                <Stack.Screen options={{ title: "Tmux Presets" }} />
                <View
                    testID="screen-tmux-presets"
                    accessibilityLabel="screen-tmux-presets"
                    className="flex-1 items-center justify-center bg-dd-bg-base"
                >
                    <View testID="tmux-presets-loading" className="items-center gap-2">
                        <ActivityIndicator color={c.accent} />
                        <Text style={{ color: c.textMuted, fontFamily: "monospace" }}>Loading presets…</Text>
                    </View>
                </View>
            </>
        );
    }

    if (presetsQuery.isError || !presetsQuery.data) {
        return (
            <>
                <Stack.Screen options={{ title: "Tmux Presets" }} />
                <View
                    testID="screen-tmux-presets"
                    accessibilityLabel="screen-tmux-presets"
                    className="flex-1 items-center justify-center gap-2 bg-dd-bg-base p-6"
                >
                    <Text
                        testID="tmux-presets-error"
                        className="text-base font-bold"
                        style={{ color: c.danger, fontFamily: "monospace" }}
                    >
                        Presets unavailable
                    </Text>
                    <Text className="text-xs" style={{ color: c.textMuted, fontFamily: "monospace" }}>
                        {presetsQuery.error instanceof Error ? presetsQuery.error.message : "Could not reach the agent."}
                    </Text>
                </View>
            </>
        );
    }

    const presets = presetsQuery.data;

    return (
        <>
            <Stack.Screen options={{ title: "Tmux Presets" }} />
            <Screen testID="screen-tmux-presets">
                <MockBadge />
                <CaptureSheet />

                {resultLine ? (
                    <View
                        testID="tmux-presets-result"
                        className="rounded-lg border border-dd-border bg-dd-bg-panel px-3 py-2"
                    >
                        <Text className="text-xs" style={{ color: c.accent, fontFamily: "monospace" }}>
                            {resultLine}
                        </Text>
                    </View>
                ) : null}

                <SectionHeader title={`Presets (${presets.length})`} />

                {presets.length === 0 ? (
                    <Empty
                        title="No presets"
                        hint="Capture the current tmux layout to save your first preset."
                        testID="tmux-presets-empty"
                    />
                ) : (
                    <View testID="tmux-presets-list" className="gap-3">
                        {presets.map((preset) => (
                            <PresetCard
                                key={preset.name}
                                preset={preset}
                                onRestore={(name) => setConfirm({ action: "restore", name })}
                                onDelete={(name) => setConfirm({ action: "delete", name })}
                            />
                        ))}
                    </View>
                )}
            </Screen>

            <RestoreConfirm state={confirm} busy={busy} onCancel={() => setConfirm(null)} onConfirm={onConfirm} />
        </>
    );
}
