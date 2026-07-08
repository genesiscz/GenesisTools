import type { CardDto, QuestionDto } from "@app/dev-dashboard/contract/dto";
import { SafeJSON } from "@app/utils/json";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { boardsApi } from "./boards-api";

const OTHER_LABEL = "Other / Něco jiného";
const CARD_GAP = 12;

function QuestionCard({ slug, question }: { slug: string; question: QuestionDto }) {
    const queryClient = useQueryClient();
    const [picked, setPicked] = useState<Set<string>>(new Set());
    const [otherText, setOtherText] = useState("");

    const answerMutation = useMutation({
        mutationFn: (answer: string) => boardsApi.answerQuestion(question.id, answer),
        onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["board", slug] }),
    });

    if (question.answer !== null) {
        return (
            <div className="dd-panel w-64 rounded-md border border-[var(--dd-border)] p-2 text-xs text-[var(--dd-text-secondary)]">
                <p className="mb-1 font-semibold text-[var(--dd-text-primary)]">{question.prompt}</p>
                <p>picked: {question.answer.join(", ")}</p>
                <p className="mt-1 text-[var(--dd-text-muted)]">staged — will send with next dispatch</p>
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

    const toggle = (label: string) => {
        setPicked((prev) => {
            const next = new Set(prev);
            if (next.has(label)) {
                next.delete(label);
            } else {
                next.add(label);
            }
            return next;
        });
    };

    return (
        <div className="dd-panel w-64 rounded-md border border-[var(--dd-border)] p-2 text-xs">
            <p className="mb-2 font-semibold text-[var(--dd-text-primary)]">{question.prompt}</p>
            <div className="flex flex-col gap-1">
                {question.options.map((opt) => (
                    <button
                        key={opt.label}
                        type="button"
                        title={opt.hint}
                        onClick={() => (question.multi ? toggle(opt.label) : submit([opt.label]))}
                        disabled={answerMutation.isPending}
                        className={`rounded border px-2 py-1 text-left ${
                            picked.has(opt.label)
                                ? "border-[var(--dd-accent-from)] bg-[var(--dd-accent-from)]/10"
                                : "border-[var(--dd-border)] hover:bg-[var(--dd-bg-hover)]"
                        } ${opt.recommended ? "ring-1 ring-[var(--dd-accent-from)]" : ""}`}
                    >
                        {question.multi ? (picked.has(opt.label) ? "☑ " : "☐ ") : ""}
                        {opt.label}
                    </button>
                ))}
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
                {question.multi ? (
                    <button
                        type="button"
                        disabled={picked.size === 0 || answerMutation.isPending}
                        onClick={() => submit([...picked])}
                        className="dd-btn-accent mt-1 rounded px-2 py-1 disabled:opacity-40"
                    >
                        submit ({picked.size})
                    </button>
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
