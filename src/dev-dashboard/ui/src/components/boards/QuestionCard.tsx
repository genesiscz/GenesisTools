import type { CardDto, QuestionDto } from "@app/dev-dashboard/contract/dto";
import { SafeJSON } from "@app/utils/json";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { boardsApi } from "./boards-api";

const OTHER_LABEL = "Other / Něco jiného";
const CARD_GAP = 12;

function QuestionCard({ slug, question }: { slug: string; question: QuestionDto }) {
    const queryClient = useQueryClient();
    const [picked, setPicked] = useState<Set<string>>(new Set(question.answer ?? []));
    const [otherText, setOtherText] = useState("");

    const answerMutation = useMutation({
        mutationFn: (answer: string) => boardsApi.answerQuestion(question.id, answer),
        onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["board", slug] }),
    });

    const answered = question.answer !== null;
    // Answers are staged until dispatch — re-picks are free (vitrinka: "answers are staged
    // until dispatch, so re-picks are free"). Only a dispatched question locks.
    const locked = answered && !question.staged;

    if (locked) {
        return (
            <div className="dd-panel w-64 rounded-md border border-[var(--dd-border)] p-2 text-xs text-[var(--dd-text-secondary)]">
                <p className="mb-1 font-semibold text-[var(--dd-text-primary)]">{question.prompt}</p>
                <p>✓ {(question.answer ?? []).join(", ")} — sent</p>
            </div>
        );
    }

    const submit = (labels: string[]) => {
        const trimmed = labels.map((l) => l.trim()).filter((l) => l.length > 0);
        if (trimmed.length === 0) {
            return;
        }
        answerMutation.mutate(question.multi ? SafeJSON.stringify(trimmed) : trimmed[0]);
    };

    const currentSingle = !question.multi && answered ? (question.answer ?? [])[0] : null;

    const toggle = (label: string) => {
        const next = new Set(picked);

        if (next.has(label)) {
            next.delete(label);
        } else {
            next.add(label);
        }

        setPicked(next);

        // Re-picks re-POST immediately while staged; the last toggle can't empty the answer.
        if (answered && next.size > 0) {
            submit([...next]);
        }
    };

    return (
        <div className="dd-panel w-64 rounded-md border border-[var(--dd-border)] p-2 text-xs">
            <p className="mb-2 font-semibold text-[var(--dd-text-primary)]">{question.prompt}</p>
            <div className="flex flex-col gap-1">
                {question.options.map((opt) => {
                    const isOn = question.multi ? picked.has(opt.label) : currentSingle === opt.label;

                    return (
                        <button
                            key={opt.label}
                            type="button"
                            title={opt.hint}
                            onClick={() => {
                                if (question.multi) {
                                    toggle(opt.label);
                                } else if (opt.label !== currentSingle) {
                                    submit([opt.label]);
                                }
                            }}
                            disabled={answerMutation.isPending}
                            className={`rounded border px-2 py-1 text-left ${
                                isOn
                                    ? "border-[var(--dd-accent-from)] bg-[var(--dd-accent-from)]/10"
                                    : "border-[var(--dd-border)] hover:bg-[var(--dd-bg-hover)]"
                            } ${opt.recommended ? "ring-1 ring-[var(--dd-accent-from)]" : ""}`}
                        >
                            {question.multi ? (picked.has(opt.label) ? "☑ " : "☐ ") : ""}
                            {opt.label}
                        </button>
                    );
                })}
                <div className="flex gap-1">
                    <input
                        type="text"
                        value={otherText}
                        onChange={(e) => setOtherText(e.target.value)}
                        placeholder={OTHER_LABEL}
                        className="min-w-0 flex-1 rounded border border-[var(--dd-border)] bg-transparent px-2 py-1 outline-none focus:border-[var(--dd-accent-from)]"
                    />
                    {otherText ? (
                        <button
                            type="button"
                            onClick={() => {
                                if (question.multi) {
                                    toggle(otherText);
                                    setOtherText("");
                                } else {
                                    submit([otherText]);
                                }
                            }}
                            className="dd-btn-accent rounded px-2"
                        >
                            {question.multi ? "add" : "send"}
                        </button>
                    ) : null}
                </div>
                {question.multi && !answered ? (
                    <button
                        type="button"
                        disabled={picked.size === 0 || answerMutation.isPending}
                        onClick={() => submit([...picked])}
                        className="dd-btn-accent mt-1 rounded px-2 py-1 disabled:opacity-40"
                    >
                        submit ({picked.size})
                    </button>
                ) : null}
                {answered ? (
                    <p className="mt-1 text-[var(--dd-text-muted)]">
                        ◦ {(question.answer ?? []).join(", ")} — staged · re-pick to change · sends with dispatch
                    </p>
                ) : null}
            </div>
        </div>
    );
}

/** Card-anchored questions: pinned below their card, in WORLD space (pans/zooms with the canvas). */
export function AnchoredQuestions({
    slug,
    questions,
    cards,
}: {
    slug: string;
    questions: QuestionDto[];
    cards: CardDto[];
}) {
    const cardById = new Map(cards.map((c) => [c.id, c]));

    return (
        <>
            {questions
                .filter((q) => q.cardId != null)
                .map((q) => {
                    const card = cardById.get(q.cardId as number);
                    if (!card) {
                        return null;
                    }
                    return (
                        <div key={q.id} style={{ position: "absolute", left: card.x, top: card.y + card.h + CARD_GAP }}>
                            <QuestionCard slug={slug} question={q} />
                        </div>
                    );
                })}
        </>
    );
}

/** Board-level questions: a fixed corner stack in SCREEN space (doesn't move with pan/zoom). */
export function BoardLevelQuestions({ slug, questions }: { slug: string; questions: QuestionDto[] }) {
    const boardLevel = questions.filter((q) => q.cardId == null);

    if (boardLevel.length === 0) {
        return null;
    }

    return (
        <div className="absolute top-14 right-3 z-20 flex flex-col gap-2">
            {boardLevel.map((q) => (
                <QuestionCard key={q.id} slug={slug} question={q} />
            ))}
        </div>
    );
}
