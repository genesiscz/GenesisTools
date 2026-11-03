import type { WaitingDecisionDto } from "@dd/contract";
import { useState } from "react";
import { Pressable, Text, TextInput, View } from "react-native";
import { WriteError } from "@/features/answer-queue/components/ReceiptLine";
import { useStagePick } from "@/features/answer-queue/hooks";
import { idempotencyKey } from "@/features/answer-queue/units";
import { useThemeColors } from "@/theme/colors";

interface DecisionCardProps {
    session: string;
    decision: WaitingDecisionDto;
}

/**
 * One decision of the queue: its question, one button per option letter (the recommended one marked), and a note.
 * A tap stages the letter on the Mac (nothing is sent); the session's Send button sends every staged pick as one
 * message, as the notch widget does. The stage carries the revision shown, so a decision the agent re-posted refuses
 * the stale pick with the Mac's words.
 */
export function DecisionCard({ session, decision }: DecisionCardProps) {
    const c = useThemeColors();
    const stage = useStagePick();
    const [note, setNote] = useState(decision.draft ?? "");
    const testId = `answer-queue-decision-${session}-${decision.number}`;

    const stageWith = (patch: { option?: string; text?: string }) =>
        stage.mutate({
            session,
            number: decision.number,
            expectedRevision: decision.revision,
            key: idempotencyKey(),
            ...patch,
        });

    const saveNote = () => {
        if (note.trim() !== (decision.draft ?? "").trim()) {
            stageWith({ text: note.trim() });
        }
    };

    return (
        <View testID={testId} className="gap-2 rounded-lg border border-dd-border p-3">
            <Text className="text-xs" style={{ color: c.textMuted, fontFamily: "monospace" }}>
                {`DECISION ${decision.number}${decision.blocking ? " · blocking" : ""}`}
            </Text>
            <Text className="text-sm" style={{ color: c.textPrimary }}>
                {decision.title ?? decision.prompt}
            </Text>
            {decision.title ? (
                <Text className="text-xs" style={{ color: c.textSecondary }}>
                    {decision.prompt}
                </Text>
            ) : null}
            <View className="gap-2">
                {decision.choices.map((choice) => {
                    const staged = decision.draftOption?.includes(choice.id) === true;
                    return (
                        <Pressable
                            key={choice.id}
                            testID={`${testId}-option-${choice.id}`}
                            accessibilityRole="button"
                            accessibilityState={{ selected: staged, disabled: stage.isPending }}
                            accessibilityLabel={`Option ${choice.id}: ${choice.label}${choice.recommended ? ", recommended" : ""}`}
                            disabled={stage.isPending}
                            onPress={() => stageWith({ option: choice.id })}
                            className="min-h-11 flex-row items-center gap-3 rounded-lg border px-3 py-2"
                            style={{
                                borderColor: staged ? c.accent : c.border,
                                backgroundColor: staged ? c.accentMuted : "transparent",
                            }}
                        >
                            <Text className="font-bold" style={{ color: c.accent, fontFamily: "monospace" }}>
                                {choice.id}
                            </Text>
                            <Text className="flex-1 text-sm" style={{ color: c.textPrimary }}>
                                {choice.label}
                            </Text>
                            {choice.recommended ? (
                                <Text className="text-xs" style={{ color: c.textMuted }}>
                                    recommended
                                </Text>
                            ) : null}
                        </Pressable>
                    );
                })}
            </View>
            <TextInput
                testID={`${testId}-note`}
                accessibilityLabel={`Note for decision ${decision.number}`}
                placeholder="Add a note…"
                placeholderTextColor={c.textMuted}
                value={note}
                onChangeText={setNote}
                onEndEditing={saveNote}
                multiline
                className="min-h-11 rounded-lg border border-dd-border bg-dd-bg-base px-3 py-2"
                style={{ color: c.textPrimary }}
            />
            {stage.isError ? <WriteError testID={`${testId}-error`} error={stage.error} /> : null}
        </View>
    );
}
