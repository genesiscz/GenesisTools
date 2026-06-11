import { useState } from "react";
import { Alert, Modal, Pressable, Text, View } from "react-native";
import { CommandGrid } from "@/features/quick-commands/components/CommandGrid";
import { EditCommandSheet } from "@/features/quick-commands/components/EditCommandSheet";
import { TargetPicker } from "@/features/quick-commands/components/TargetPicker";
import {
    useCommands,
    useCreateCommand,
    useDeleteCommand,
    useRunCommand,
} from "@/features/quick-commands/hooks";
import type { RunTargetOption, SavedCommand } from "@/features/quick-commands/types";
import { Card } from "@/ui/Card";
import { Loading } from "@/ui/Loading";
import { MockBadge } from "@/ui/MockBadge";
import { Screen } from "@/ui/Screen";
import { SectionHeader } from "@/ui/SectionHeader";
import { useThemeColors } from "@/theme/colors";

/**
 * Quick Commands screen — a grid of one-tap snippets. Tap a card → pick a target → run-confirm →
 * fire. Running composes the two existing exec endpoints (create tmux session, attach to cmux); this
 * screen never builds a shell string beyond the saved snippet `command`. State: which snippet is
 * being targeted (`picking`), the chosen target awaiting confirm (`pending`), and the edit sheet.
 *
 * The run-confirm is an IN-SCREEN control (testID `run-confirm`), not a native `Alert` — native
 * dialogs are not addressable by `~testID` in Appium, so the confirm leg needs a real testID.
 */
export function QuickCommandsScreen() {
    const c = useThemeColors();
    const list = useCommands();
    const create = useCreateCommand();
    const remove = useDeleteCommand();
    const run = useRunCommand();

    const [picking, setPicking] = useState<SavedCommand | null>(null);
    const [pending, setPending] = useState<{ command: SavedCommand; option: RunTargetOption } | null>(null);
    const [editing, setEditing] = useState<SavedCommand | "new" | null>(null);

    function onPick(option: RunTargetOption) {
        if (picking) {
            setPending({ command: picking, option });
        }

        setPicking(null);
    }

    function confirmRun() {
        if (!pending) {
            return;
        }

        run.mutate(
            { command: pending.command, target: pending.option.target },
            {
                onError: (err) =>
                    Alert.alert("Run failed", err instanceof Error ? err.message : "Could not run the command."),
            },
        );
        setPending(null);
    }

    return (
        <Screen testID="screen-quick-commands">
            <MockBadge />
            <SectionHeader title="Quick Commands" />

            {list.isPending ? (
                <Loading />
            ) : (
                <CommandGrid
                    commands={list.data?.commands ?? []}
                    onRun={setPicking}
                    onEdit={setEditing}
                    onAdd={() => setEditing("new")}
                />
            )}

            <TargetPicker command={picking} onPick={onPick} onCancel={() => setPicking(null)} />

            <Modal
                visible={pending !== null}
                transparent
                animationType="fade"
                onRequestClose={() => setPending(null)}
            >
                <View testID="run-confirm-sheet" className="flex-1 items-center justify-center bg-black/60 p-6">
                    <Card className="w-full gap-3">
                        <SectionHeader title="Run command" />
                        <Text style={{ color: c.textSecondary, fontFamily: "monospace" }}>
                            {pending ? `Run "${pending.command.label}" in ${pending.option.label}?` : ""}
                        </Text>
                        <Pressable
                            testID="run-confirm"
                            accessibilityLabel="run-confirm"
                            accessibilityRole="button"
                            onPress={confirmRun}
                        >
                            <Card className="items-center py-3">
                                <Text style={{ color: c.accent, fontFamily: "monospace" }}>
                                    {run.isPending ? "Running…" : "Run"}
                                </Text>
                            </Card>
                        </Pressable>
                        <Pressable
                            testID="run-cancel"
                            accessibilityLabel="run-cancel"
                            accessibilityRole="button"
                            onPress={() => setPending(null)}
                            className="items-center py-2"
                        >
                            <Text style={{ color: c.textMuted, fontFamily: "monospace" }}>Cancel</Text>
                        </Pressable>
                    </Card>
                </View>
            </Modal>

            <EditCommandSheet
                editing={editing}
                saving={create.isPending}
                onSave={(input) =>
                    create.mutate(input, {
                        onSuccess: () => setEditing(null),
                        onError: (err) =>
                            Alert.alert("Save failed", err instanceof Error ? err.message : "Could not save."),
                    })
                }
                onDelete={(id) =>
                    remove.mutate(id, {
                        onSuccess: () => setEditing(null),
                    })
                }
                onCancel={() => setEditing(null)}
            />
        </Screen>
    );
}
