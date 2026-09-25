import { renderQaQuestionHtml } from "@app/dev-dashboard/lib/qa-render";
import type { AskAnswer, AskForm, AskItem } from "@app/question/lib/pending/types";
import { useMutation } from "@tanstack/react-query";
import { BlinkingBox } from "@ui/components/BlinkingBox";
import { Button } from "@ui/components/button";
import { Input } from "@ui/components/input";
import { Textarea } from "@ui/components/textarea";
import { useMemo, useState } from "react";
import { truncateMiddle } from "@/components/handoff/handoff-format";
import { QaRecencyTime } from "@/components/QaRecencyTime";
import { QaSectionHeading } from "@/components/QaSectionHeading";
import { QaSessionActions } from "@/components/QaSessionActions";
import { type AnswerResponse, qaPendingApi } from "@/lib/api";

type Draft = Record<string, { choices: string[]; freeText: string; fileTags: string }>;

function emptyDraft(form: AskForm): Draft {
    return Object.fromEntries(form.items.map((item) => [item.id, { choices: [], freeText: "", fileTags: "" }]));
}

function splitTags(raw: string): string[] {
    return raw
        .split(/[\s,]+/)
        .map((tag) => tag.trim().replace(/^@/, ""))
        .filter((tag) => tag.length > 0);
}

function draftToAnswers(form: AskForm, draft: Draft): AskAnswer[] {
    return form.items.map((item) => {
        const entry = draft[item.id];

        return {
            itemId: item.id,
            selectedChoices: entry.choices.length > 0 ? entry.choices : undefined,
            freeText: entry.freeText.trim() ? entry.freeText : undefined,
            fileTags: item.allowFileTags && entry.fileTags.trim() ? splitTags(entry.fileTags) : undefined,
        };
    });
}

function ChoiceRow({
    item,
    picked,
    onToggle,
}: {
    item: AskItem;
    picked: string[];
    onToggle: (choiceId: string) => void;
}) {
    return (
        <div className="flex flex-wrap gap-1.5">
            {(item.choices ?? []).map((choice) => {
                const on = picked.includes(choice.id);

                return (
                    <button
                        key={choice.id}
                        type="button"
                        aria-pressed={on}
                        data-testid={`qa-choice-${item.id}-${choice.id}`}
                        className={`cursor-pointer rounded-full border px-3 py-1 text-xs transition-colors ${
                            on
                                ? "dd-accent-text border-[var(--color-primary)] bg-[var(--dd-border)]/40"
                                : "border-[var(--dd-border)] text-[var(--dd-text-secondary)] hover:bg-[var(--dd-border)]/30"
                        }`}
                        onClick={() => onToggle(choice.id)}
                    >
                        {choice.label}
                    </button>
                );
            })}
        </div>
    );
}

/**
 * One pending ask form, with the controls the agent asked for.
 *
 * Answering posts to the same core the CLI and MCP doors use, so the form is resolved for
 * every waiter at once and the Q→A lands in history as a normal entry.
 */
export function QaPendingCard({ form, pinned }: { form: AskForm; pinned?: boolean }) {
    const [draft, setDraft] = useState<Draft>(() => emptyDraft(form));
    const [failure, setFailure] = useState<AnswerResponse | null>(null);

    // Both calls can REJECT as well as resolve unhappily: `qaPendingApi.cancel` throws on a
    // 404, which is exactly what someone answering the form elsewhere first produces. With no
    // onError the button simply went quiet and the card sat there giving no reason.
    const asFailure = (err: unknown): AnswerResponse => ({
        ok: false,
        code: "not_found",
        error: err instanceof Error ? err.message : String(err),
    });
    const submit = useMutation({
        mutationFn: () => qaPendingApi.answer(form.id, draftToAnswers(form, draft)),
        onSuccess: (result) => setFailure(result.ok ? null : result),
        onError: (err: unknown) => setFailure(asFailure(err)),
    });
    const cancel = useMutation({
        mutationFn: () => qaPendingApi.cancel(form.id),
        onError: (err: unknown) => setFailure(asFailure(err)),
    });

    const toggleChoice = (item: AskItem, choiceId: string): void => {
        setDraft((prev) => {
            const current = prev[item.id].choices;
            const next = current.includes(choiceId)
                ? current.filter((id) => id !== choiceId)
                : item.allowMultiple
                  ? [...current, choiceId]
                  : [choiceId];

            return { ...prev, [item.id]: { ...prev[item.id], choices: next } };
        });
    };

    const missing = failure?.ok === false && failure.code === "incomplete" ? new Set(failure.missing ?? []) : null;
    const promptHtml = useMemo(
        () => Object.fromEntries(form.items.map((item) => [item.id, renderQaQuestionHtml(item.promptMarkdown)])),
        [form.items]
    );

    const card = (
        <div
            className="dd-panel dd-qa-card--unread flex flex-col gap-3 p-4"
            data-qa-pending-id={form.id}
            style={{ scrollMarginTop: "5rem" }}
        >
            <div className="flex flex-wrap items-center gap-2 text-xs text-[var(--dd-text-muted)]">
                <span className="dd-qa-unread-badge">waiting</span>
                <span className="text-[var(--dd-text-secondary)]">{form.source ?? "agent"}</span>
                <span>·</span>
                <span title={form.cwd}>{truncateMiddle(form.cwd, 40)}</span>
                <QaSessionActions sessionId={form.sessionHint} />
                <QaRecencyTime ts={form.createdAt} />
            </div>

            {form.items.map((item) => (
                // The controls below carry only placeholder text, so on a multi-item form a
                // screen reader could not tell which question a box belonged to. The group is
                // labelled by the rendered prompt itself.
                <div
                    key={item.id}
                    className="flex flex-col gap-2"
                    data-testid={`qa-question-${item.id}`}
                    role="group"
                    aria-labelledby={`${form.id}-${item.id}-prompt`}
                >
                    <QaSectionHeading label="Question" />
                    {item.required ? null : <span className="text-[10px] text-[var(--dd-text-muted)]">optional</span>}
                    {/* Same sanitized markdown renderer the history cards use. */}
                    <article
                        id={`${form.id}-${item.id}-prompt`}
                        className="dd-qa-section-body dd-markdown font-medium leading-relaxed text-[var(--dd-text-primary)]"
                        dangerouslySetInnerHTML={{ __html: promptHtml[item.id] }}
                    />
                    {item.choices?.length ? (
                        <ChoiceRow
                            item={item}
                            picked={draft[item.id].choices}
                            onToggle={(choiceId) => toggleChoice(item, choiceId)}
                        />
                    ) : null}
                    {item.allowFreeText !== false ? (
                        <Textarea
                            rows={2}
                            placeholder="Your answer…"
                            data-testid={`qa-freetext-${item.id}`}
                            value={draft[item.id].freeText}
                            onChange={(ev) =>
                                setDraft((prev) => ({
                                    ...prev,
                                    [item.id]: { ...prev[item.id], freeText: ev.target.value },
                                }))
                            }
                        />
                    ) : null}
                    {item.allowFileTags ? (
                        <Input
                            placeholder="@file tags, relative to the form cwd (space or comma separated)"
                            data-testid={`qa-filetag-${item.id}`}
                            value={draft[item.id].fileTags}
                            onChange={(ev) =>
                                setDraft((prev) => ({
                                    ...prev,
                                    [item.id]: { ...prev[item.id], fileTags: ev.target.value },
                                }))
                            }
                        />
                    ) : null}
                    {item.allowImagePaste ? (
                        <p className="text-[10px] text-[var(--dd-text-muted)]">
                            This question accepts pasted images. Paste is available in Genesis.app; answer the text here
                            or attach the image there.
                        </p>
                    ) : null}
                    {missing?.has(item.id) ? (
                        <p className="text-[10px] text-[var(--dd-danger)]">This question still needs an answer.</p>
                    ) : null}
                </div>
            ))}

            {failure?.ok === false ? (
                <p className="text-xs text-[var(--dd-danger)]" data-testid="qa-pending-error">
                    {failure.error}
                </p>
            ) : null}

            <div className="flex flex-wrap items-center gap-2">
                <Button size="sm" data-testid="qa-submit" disabled={submit.isPending} onClick={() => submit.mutate()}>
                    {submit.isPending ? "Sending…" : "Answer"}
                </Button>
                <Button size="sm" variant="ghost" disabled={cancel.isPending} onClick={() => cancel.mutate()}>
                    Dismiss
                </Button>
                {form.timeoutMs ? (
                    <span className="text-[10px] text-[var(--dd-text-muted)]">
                        expires {Math.round(form.timeoutMs / 1000)}s after it was asked
                    </span>
                ) : null}
            </div>
        </div>
    );

    if (!pinned) {
        return card;
    }

    return (
        <BlinkingBox active variant="accent-glow" iterations={5} durationMs={700} className="rounded-lg">
            {card}
        </BlinkingBox>
    );
}
