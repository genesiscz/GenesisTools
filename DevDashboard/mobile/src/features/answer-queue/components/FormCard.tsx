import type { WaitingFormDto } from "@dd/contract";
import { useState } from "react";
import { Pressable, Text, TextInput, View } from "react-native";
import { ReceiptLine, WriteError } from "@/features/answer-queue/components/ReceiptLine";
import { useAnswerForm } from "@/features/answer-queue/hooks";
import { type FormDraft, formAnswers, idempotencyKey, missingAnswers, togglePick } from "@/features/answer-queue/units";
import { useThemeColors } from "@/theme/colors";

/**
 * A pending ask form as a native form: choice buttons per question (one or several, as the question allows) and a
 * text field where it takes free text. Send stays disabled until every required question has an answer.
 */
export function FormCard({ form }: { form: WaitingFormDto }) {
    const c = useThemeColors();
    const answer = useAnswerForm();
    const [draft, setDraft] = useState<FormDraft>({});
    const missing = missingAnswers(form, draft);
    const canSend = missing.length === 0 && !answer.isPending;
    const testId = `answer-queue-form-${form.id}`;

    const update = (itemId: string, patch: Partial<FormDraft[string]>) =>
        setDraft((current) => ({
            ...current,
            [itemId]: { ...(current[itemId] ?? { selected: [], text: "" }), ...patch },
        }));

    return (
        <View testID={testId} className="gap-3 rounded-lg border border-dd-border p-3">
            <Text className="text-xs" style={{ color: c.textMuted, fontFamily: "monospace" }}>
                {`Ask form${form.source ? ` · ${form.source}` : ""}`}
            </Text>
            {form.questions.map((question) => {
                const current = draft[question.itemId] ?? { selected: [], text: "" };
                return (
                    <View key={question.itemId} className="gap-2">
                        <Text className="text-sm" style={{ color: c.textPrimary }}>
                            {question.prompt}
                            {question.required ? "" : " (optional)"}
                        </Text>
                        {question.choices.map((choice) => {
                            const picked = current.selected.includes(choice.id);
                            return (
                                <Pressable
                                    key={choice.id}
                                    testID={`${testId}-${question.itemId}-${choice.id}`}
                                    accessibilityRole={question.multiple ? "checkbox" : "radio"}
                                    accessibilityState={{ checked: picked }}
                                    accessibilityLabel={choice.label}
                                    onPress={() =>
                                        update(question.itemId, {
                                            selected: togglePick(current.selected, choice.id, question.multiple),
                                        })
                                    }
                                    className="min-h-11 justify-center rounded-lg border px-3 py-2"
                                    style={{
                                        borderColor: picked ? c.accent : c.border,
                                        backgroundColor: picked ? c.accentMuted : "transparent",
                                    }}
                                >
                                    <Text className="text-sm" style={{ color: c.textPrimary }}>
                                        {choice.label}
                                    </Text>
                                </Pressable>
                            );
                        })}
                        {question.freeText ? (
                            <TextInput
                                testID={`${testId}-${question.itemId}-text`}
                                accessibilityLabel={`Answer: ${question.prompt}`}
                                placeholder={question.choices.length > 0 ? "Or type an answer…" : "Type an answer…"}
                                placeholderTextColor={c.textMuted}
                                value={current.text}
                                onChangeText={(text) => update(question.itemId, { text })}
                                multiline
                                className="min-h-11 rounded-lg border border-dd-border bg-dd-bg-base px-3 py-2"
                                style={{ color: c.textPrimary }}
                            />
                        ) : null}
                    </View>
                );
            })}
            <Pressable
                testID={`${testId}-send`}
                accessibilityRole="button"
                accessibilityLabel="Send the form"
                accessibilityHint={missing.length > 0 ? "Answer every required question first" : undefined}
                accessibilityState={{ disabled: !canSend }}
                disabled={!canSend}
                onPress={() => answer.mutate({ id: form.id, answers: formAnswers(form, draft), key: idempotencyKey() })}
                className="min-h-11 items-center justify-center rounded-lg px-4"
                style={{ backgroundColor: canSend ? c.accent : c.border, opacity: canSend ? 1 : 0.6 }}
            >
                <Text className="font-bold" style={{ color: c.bgBase, fontFamily: "monospace" }}>
                    {answer.isPending ? "Sending…" : "Send"}
                </Text>
            </Pressable>
            {answer.data ? <ReceiptLine testID={`${testId}-receipt`} receipt={answer.data} /> : null}
            {answer.isError ? <WriteError testID={`${testId}-error`} error={answer.error} /> : null}
        </View>
    );
}
