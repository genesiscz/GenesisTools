import type { WaitingDecisionDto } from "@dd/contract";
import { useContext, useEffect, useRef, useState } from "react";
import { Pressable, Text, TextInput, View } from "react-native";
import { WriteError } from "@/features/answer-queue/components/ReceiptLine";
import { KeptEditsContext, useKeptState, useStagePick } from "@/features/answer-queue/hooks";
import {
    flushDecision,
    idempotencyKey,
    type NoteState,
    noteIsDirty,
    noteStateOf,
    reconcileNote,
    stagesOf,
} from "@/features/answer-queue/units";
import { useThemeColors } from "@/theme/colors";

interface DecisionCardProps {
    session: string;
    decision: WaitingDecisionDto;
    /** Hands the session card this card's flush (save the note, wait for a stage), so Send runs it first. */
    registerFlush: (number: number, flush: (() => Promise<void>) | null) => void;
}

/**
 * One decision of the queue: its question, one button per option letter (the recommended one marked), and a note.
 * A tap stages the letter on the Mac (nothing is sent); the session's Send button sends every staged pick as one
 * message, as the notch widget does. The stage carries the revision shown, so a decision the agent re-posted refuses
 * the stale pick with the Mac's words.
 */
export function DecisionCard({ session, decision, registerFlush }: DecisionCardProps) {
    const c = useThemeColors();
    const stage = useStagePick();
    // Kept by the screen, not the card: the list unmounts a card scrolled far away, and the note must survive that.
    const [noteState, setNoteState] = useKeptState<NoteState>(
        (kept) => kept.notes,
        decision.id,
        () => noteStateOf(decision)
    );
    // Picks and note saves are tracked apart: a failed pick blocks Send, a failed note save is retried by it. The
    // screen keeps the trackers too, so a refused pick still blocks Send after the list remounts the card.
    const { pick: pickStage, note: noteStage } = stagesOf(useContext(KeptEditsContext), decision.id);
    const testId = `answer-queue-decision-${session}-${decision.number}`;

    // The card is keyed by the decision id, which stays when the agent re-posts it or another surface edits the draft.
    useEffect(() => {
        setNoteState((state) => reconcileNote(state, { revision: decision.revision, draft: decision.draft }));
    }, [decision.revision, decision.draft, setNoteState]);

    const [, setSettled] = useState(0);
    const rerender = () => setSettled((count) => count + 1);

    const stageAsync = (patch: { option?: string; text?: string }, revision: number) => {
        const pending = stage.mutateAsync({
            session,
            number: decision.number,
            expectedRevision: revision,
            key: idempotencyKey(),
            ...patch,
        });
        (patch.option === undefined ? noteStage : pickStage).track(pending);
        // The tracker settles after the mutation's own render: render again so the refusal line follows the tracker.
        pending.then(rerender, rerender);
        return pending;
    };

    /** Stages the note against the revision it was written on; rejects when the Mac refuses it. */
    const saveNote = async () => {
        if (!noteIsDirty(noteState)) {
            return;
        }

        const text = noteState.note.trim();
        await stageAsync({ text }, noteState.base.revision);
        setNoteState((state) => ({ ...state, base: { ...state.base, draft: text } }));
    };

    // The session card calls the latest flush; the ref keeps one stable function registered.
    const flushRef = useRef(async () => {});
    flushRef.current = async () => {
        await flushDecision({ pick: pickStage, note: noteStage, saveNote });
    };

    useEffect(() => {
        registerFlush(decision.number, () => flushRef.current());
        return () => registerFlush(decision.number, null);
    }, [decision.number, registerFlush]);

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
                            onPress={() =>
                                void stageAsync({ option: choice.id }, decision.revision).catch(() => undefined)
                            }
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
                value={noteState.note}
                onChangeText={(note) => setNoteState((state) => ({ ...state, note }))}
                onEndEditing={() => void saveNote().catch(() => undefined)}
                multiline
                className="min-h-11 rounded-lg border border-dd-border bg-dd-bg-base px-3 py-2"
                style={{ color: c.textPrimary }}
            />
            {stage.isError || pickStage.refusal() ? (
                // A remounted card's mutation has no error yet: the kept pick tracker still holds the refusal that
                // blocks Send, so the card says why Send does nothing.
                <WriteError testID={`${testId}-error`} error={stage.isError ? stage.error : pickStage.refusal()} />
            ) : null}
        </View>
    );
}
