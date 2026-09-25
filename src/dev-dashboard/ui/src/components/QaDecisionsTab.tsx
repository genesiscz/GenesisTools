import { deliveryLabel } from "@app/dev-dashboard/lib/qa-decision-delivery";
import { renderQaQuestionHtml } from "@app/dev-dashboard/lib/qa-render";
import type { InboxAnswerResult } from "@app/question/lib/inbox/answer";
import type { InboxDecision, InboxSession } from "@app/question/lib/inbox/build";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@ui/components/button";
import { Textarea } from "@ui/components/textarea";
import { useMemo, useState } from "react";
import { truncateMiddle } from "@/components/handoff/handoff-format";
import { QaClockProvider } from "@/components/QaClockProvider";
import { QaRecencyTime } from "@/components/QaRecencyTime";
import { QaSessionActions } from "@/components/QaSessionActions";
import { qaDecisionsApi } from "@/lib/api";

const INBOX_QUERY_KEY = ["qa", "decisions", "inbox"] as const;
/** The inbox reads transcripts (cached by size and mtime); a slow refresh is enough to notice a new question. */
const INBOX_REFRESH_MS = 20_000;

type Draft = { option?: string; text: string };
type Drafts = Record<number, Draft>;

function isWaiting(item: InboxDecision): boolean {
    return item.status === "waiting" || item.status === "drafted";
}

function decisionsOf(session: InboxSession): InboxDecision[] {
    return session.items.filter((item): item is InboxDecision => item.kind === "decision");
}

/** Decisions the session still waits on, across the inbox: the tab's badge. */
export function waitingDecisionCount(sessions: readonly InboxSession[]): number {
    return sessions.reduce((sum, session) => sum + decisionsOf(session).filter(isWaiting).length, 0);
}

/** The drafted answers of one session in the batch shape `answerInboxDecisions` takes. */
export function draftedAnswers(drafts: Drafts): Array<{ number: number; option?: string; text?: string }> {
    return Object.entries(drafts)
        .map(([number, draft]) => ({
            number: Number(number),
            ...(draft.option ? { option: draft.option } : {}),
            ...(draft.text.trim() ? { text: draft.text.trim() } : {}),
        }))
        .filter((answer) => answer.option !== undefined || answer.text !== undefined)
        .sort((a, b) => a.number - b.number);
}

/** The answer as the agent receives it: `b) label`, then the free text. */
function answerText(item: InboxDecision): string {
    const label = item.choices.find((choice) => choice.id === item.option)?.label;
    const text = item.answer?.trim() || label || "";

    return `${item.option ? `${item.option}) ` : ""}${text}`.trim();
}

function deliveryLine(result: InboxAnswerResult): string {
    if (result.channel === "dry-run") {
        return `Preview only, nothing sent. The agent would receive: ${result.text}`;
    }

    if (result.channel === "cmux" && result.delivered) {
        return "Delivered: typed into the session's cmux pane.";
    }

    if (result.channel === "codex" && result.delivered) {
        return `Delivered: steered into the tools codex worker${result.detail ? ` ${result.detail}` : ""}.`;
    }

    return `Queued: ${result.detail ?? "no live route"}. The session's next prompt picks the answers up.`;
}

function DecisionItem({
    item,
    draft,
    onDraft,
}: {
    item: InboxDecision;
    draft: Draft | undefined;
    onDraft: (next: Draft) => void;
}) {
    const promptHtml = useMemo(() => renderQaQuestionHtml(item.prompt), [item.prompt]);
    const contextHtml = useMemo(() => (item.context ? renderQaQuestionHtml(item.context) : null), [item.context]);
    const notesHtml = useMemo(() => (item.notes ? renderQaQuestionHtml(item.notes) : null), [item.notes]);
    const waiting = isWaiting(item);
    const current = draft ?? { text: "" };
    const refs = item.refs.filter((ref) => ref.excerpt || ref.missing);

    return (
        <div
            className="flex flex-col gap-2 border-t border-[var(--dd-border)]/60 pt-3 first:border-t-0 first:pt-0"
            data-decision-id={item.id}
        >
            <div className="flex flex-wrap items-center gap-2 text-xs text-[var(--dd-text-muted)]">
                <span className="font-medium text-[var(--dd-text-primary)]">
                    DECISION {item.number}
                    {item.title && item.title !== item.prompt ? ` · ${item.title}` : ""}
                </span>
                <span
                    className={`rounded-full border px-2 py-[1px] ${
                        waiting
                            ? "dd-accent-text border-[var(--color-primary)]"
                            : "border-[var(--dd-border)] text-[var(--dd-text-secondary)]"
                    }`}
                >
                    {item.status}
                </span>
                {item.source === "transcript" ? <span>from the last reply</span> : null}
                {item.blocking ? <span className="text-[var(--dd-danger)]">blocking</span> : null}
                <QaRecencyTime ts={Date.parse(item.at)} />
            </div>
            <article
                className="dd-qa-section-body dd-markdown text-sm leading-relaxed text-[var(--dd-text-primary)]"
                dangerouslySetInnerHTML={{ __html: promptHtml }}
            />
            {contextHtml ? (
                <details className="group rounded-md border border-[var(--dd-border)]/60 bg-[var(--dd-border)]/10 p-2 text-xs">
                    <summary className="cursor-pointer select-none text-[var(--dd-text-muted)]">Context</summary>
                    <article
                        className="dd-markdown mt-2 leading-relaxed text-[var(--dd-text-secondary)]"
                        dangerouslySetInnerHTML={{ __html: contextHtml }}
                    />
                </details>
            ) : null}
            {refs.length > 0 ? (
                <div className="flex flex-col gap-1.5" data-testid={`decision-refs-${item.id}`}>
                    {refs.map((ref) => (
                        <div key={`${ref.path}:${ref.line}`} className="rounded-md border border-[var(--dd-border)]/60">
                            <div className="flex items-center justify-between px-2 py-1 text-[11px] text-[var(--dd-text-muted)]">
                                <span className="font-mono">
                                    {ref.path}
                                    {ref.line ? `:${ref.line}` : ""}
                                </span>
                                {ref.missing ? <span className="text-[var(--dd-danger)]">file not found</span> : null}
                            </div>
                            {ref.excerpt ? (
                                <pre className="overflow-x-auto rounded-b-md bg-black/40 px-2 py-1.5 text-[11px] leading-snug text-[var(--dd-text-primary)]">
                                    <code>{ref.excerpt}</code>
                                </pre>
                            ) : null}
                        </div>
                    ))}
                </div>
            ) : null}
            {item.proposal ? (
                <p className="text-xs text-[var(--dd-text-secondary)]">Proposal: {item.proposal}</p>
            ) : null}
            {notesHtml ? (
                <article
                    className="dd-markdown text-xs leading-relaxed text-[var(--dd-text-secondary)]"
                    dangerouslySetInnerHTML={{ __html: notesHtml }}
                />
            ) : null}

            {waiting ? (
                <>
                    {item.choices.length > 0 ? (
                        <div className="flex flex-col gap-1.5">
                            {item.choices.map((choice) => {
                                const on = current.option === choice.id;

                                return (
                                    <button
                                        key={choice.id}
                                        type="button"
                                        aria-pressed={on}
                                        data-testid={`decision-option-${item.id}-${choice.id}`}
                                        className={`cursor-pointer rounded-md border px-3 py-1.5 text-left text-xs transition-colors ${
                                            on
                                                ? "dd-accent-text border-[var(--color-primary)] bg-[var(--dd-border)]/40"
                                                : "border-[var(--dd-border)] text-[var(--dd-text-secondary)] hover:bg-[var(--dd-border)]/30"
                                        }`}
                                        onClick={() => onDraft({ ...current, option: on ? undefined : choice.id })}
                                    >
                                        <span className="font-medium text-[var(--dd-text-primary)]">
                                            {choice.id}) {choice.label}
                                        </span>
                                        {choice.recommended ? (
                                            <span className="dd-accent-text ml-1">· recommended</span>
                                        ) : null}
                                        {choice.rationale ? (
                                            <span className="mt-0.5 block text-[var(--dd-text-muted)]">
                                                {choice.rationale}
                                            </span>
                                        ) : null}
                                    </button>
                                );
                            })}
                        </div>
                    ) : null}
                    <Textarea
                        rows={2}
                        placeholder={item.choices.length > 0 ? "Optional note with the option…" : "Your answer…"}
                        data-testid={`decision-text-${item.id}`}
                        value={current.text}
                        onChange={(ev) => onDraft({ ...current, text: ev.target.value })}
                    />
                </>
            ) : (
                <p className="text-xs text-[var(--dd-text-secondary)]">
                    Answer: <span className="text-[var(--dd-text-primary)]">{answerText(item) || "none"}</span>
                    {deliveryLabel(item.delivery) ? (
                        <span className="text-[var(--dd-text-muted)]" data-testid={`decision-delivery-${item.id}`}>
                            {" · "}
                            {deliveryLabel(item.delivery)}
                        </span>
                    ) : null}
                </p>
            )}
        </div>
    );
}

/** The last real send, kept above the list: a sent or queued session can leave the inbox on the next refresh. */
interface LastSend {
    title: string;
    line: string;
}

function DecisionSessionCard({ session, onSent }: { session: InboxSession; onSent: (last: LastSend) => void }) {
    const queryClient = useQueryClient();
    const sessionId = session.sessionId ?? "";
    // A pick or note saved elsewhere (the hub) starts filled in and counts toward Send.
    const [drafts, setDrafts] = useState<Drafts>(() =>
        Object.fromEntries(
            decisionsOf(session).flatMap((item) =>
                item.draftOption || item.draft
                    ? [
                          [
                              item.number,
                              { ...(item.draftOption ? { option: item.draftOption } : {}), text: item.draft ?? "" },
                          ],
                      ]
                    : []
            )
        )
    );
    const [showAll, setShowAll] = useState(false);
    const [result, setResult] = useState<InboxAnswerResult | null>(null);
    const history = useQuery({
        queryKey: ["qa", "decisions", "session", sessionId],
        queryFn: () => qaDecisionsApi.session(sessionId),
        enabled: showAll && sessionId !== "",
    });
    const refresh = (): void => {
        void queryClient.invalidateQueries({ queryKey: ["qa", "decisions"] });
    };
    const answers = draftedAnswers(drafts);
    const send = useMutation({
        mutationFn: (dryRun: boolean) =>
            qaDecisionsApi.answer({
                session: sessionId,
                provider: session.provider,
                cwd: session.cwd,
                answers,
                dryRun,
            }),
        onSuccess: (res) => {
            setResult(res);

            if (res.channel !== "dry-run") {
                onSent({ title: session.title ?? sessionId, line: deliveryLine(res) });
                setDrafts({});
                refresh();
            }
        },
    });
    const resend = useMutation({
        mutationFn: () => qaDecisionsApi.resend(sessionId, session.provider),
        onSuccess: (res) => {
            const next: InboxAnswerResult = {
                session: res.session,
                text: res.text,
                channel: res.channel ?? "queued",
                delivered: res.delivered === true,
                // A send result carries the target or the error sentence; the answer line shows either.
                ...((res.target ?? res.error) ? { detail: res.target ?? res.error } : {}),
            };
            setResult(next);
            onSent({ title: session.title ?? sessionId, line: deliveryLine(next) });
            refresh();
        },
    });
    const items = showAll && history.data ? history.data.decisions : decisionsOf(session);
    const queued = items.filter((item) => item.status === "answered").length;
    const forms = session.items.length - decisionsOf(session).length;
    const error = send.error ?? resend.error ?? history.error;

    return (
        <div
            className={`dd-panel flex flex-col gap-3 p-4${session.waiting > 0 ? " dd-qa-card--unread" : ""}`}
            data-decision-session={sessionId}
        >
            <div className="flex flex-wrap items-center gap-2 text-xs text-[var(--dd-text-muted)]">
                {session.waiting > 0 ? <span className="dd-qa-unread-badge">{session.waiting} waiting</span> : null}
                <span className="font-medium text-[var(--dd-text-primary)]" title={session.title ?? sessionId}>
                    {truncateMiddle(session.title ?? (sessionId || "no session"), 60)}
                </span>
                {session.project ? (
                    <>
                        <span>·</span>
                        <span className="text-[var(--dd-text-secondary)]">{session.project}</span>
                    </>
                ) : null}
                {session.branch ? <span>· {session.branch}</span> : null}
                {session.provider ? <span>· {session.provider}</span> : null}
                {sessionId ? <QaSessionActions sessionId={sessionId} /> : null}
                {sessionId ? (
                    <button
                        type="button"
                        className="dd-accent-text ml-auto cursor-pointer transition-opacity hover:opacity-80"
                        onClick={() => setShowAll((value) => !value)}
                    >
                        {showAll ? "Waiting only" : "All decisions"}
                    </button>
                ) : null}
            </div>

            {items.map((item) => (
                <DecisionItem
                    key={item.id}
                    item={item}
                    draft={drafts[item.number]}
                    onDraft={(next) => setDrafts((prev) => ({ ...prev, [item.number]: next }))}
                />
            ))}
            {showAll && history.isLoading ? (
                <p className="text-xs text-[var(--dd-text-muted)]">Loading every decision of this session…</p>
            ) : null}
            {forms > 0 ? (
                <p className="text-xs text-[var(--dd-text-muted)]">
                    {forms} question form{forms === 1 ? "" : "s"} also waiting: answer {forms === 1 ? "it" : "them"} in
                    the Q&amp;A tab.
                </p>
            ) : null}

            {sessionId && (answers.length > 0 || queued > 0 || result) ? (
                <div className="flex flex-wrap items-center gap-2 border-t border-[var(--dd-border)]/60 pt-3">
                    {answers.length > 0 ? (
                        <>
                            <Button
                                size="sm"
                                data-testid={`decision-send-${sessionId}`}
                                disabled={send.isPending}
                                onClick={() => send.mutate(false)}
                            >
                                {send.isPending
                                    ? "Sending…"
                                    : `Send ${answers.length} answer${answers.length === 1 ? "" : "s"}`}
                            </Button>
                            <Button
                                size="sm"
                                variant="ghost"
                                disabled={send.isPending}
                                onClick={() => send.mutate(true)}
                            >
                                Preview
                            </Button>
                        </>
                    ) : null}
                    {queued > 0 ? (
                        <Button size="sm" variant="ghost" disabled={resend.isPending} onClick={() => resend.mutate()}>
                            {resend.isPending ? "Sending…" : `Send ${queued} queued again`}
                        </Button>
                    ) : null}
                    {result ? (
                        <span className="text-xs text-[var(--dd-text-secondary)]" data-testid="decision-send-result">
                            {deliveryLine(result)}
                        </span>
                    ) : null}
                </div>
            ) : null}
            {error ? <p className="text-xs text-[var(--dd-danger)]">{String(error.message)}</p> : null}
        </div>
    );
}

/** The hub inbox, decisions only: the same list as `tools question inbox`. */
export function useDecisionInbox() {
    return useQuery({
        queryKey: INBOX_QUERY_KEY,
        queryFn: qaDecisionsApi.inbox,
        refetchInterval: INBOX_REFRESH_MS,
        select: (data) => data.sessions.filter((session) => decisionsOf(session).length > 0),
    });
}

/** Sessions waiting on a decision, answered in place and delivered through the hub inbox's lib. */
export function QaDecisionsTab() {
    const inbox = useDecisionInbox();
    const sessions = inbox.data ?? [];
    const [lastSend, setLastSend] = useState<LastSend | null>(null);

    return (
        <QaClockProvider>
            <div className="flex flex-col gap-4">
                {lastSend ? (
                    <div
                        className="dd-panel px-4 py-2 text-xs text-[var(--dd-text-secondary)]"
                        data-testid="decision-last-send"
                    >
                        <span className="text-[var(--dd-text-primary)]">{truncateMiddle(lastSend.title, 60)}</span>
                        {" · "}
                        {lastSend.line}
                    </div>
                ) : null}
                {inbox.isLoading ? (
                    <div className="dd-panel py-8 text-center text-sm text-[var(--dd-text-muted)]">
                        Loading decisions…
                    </div>
                ) : inbox.error ? (
                    <div className="dd-panel py-8 text-center text-sm text-[var(--dd-danger)]">
                        {String(inbox.error.message)}
                    </div>
                ) : sessions.length === 0 ? (
                    <div className="dd-panel flex flex-col items-center gap-1 py-10 text-center">
                        <span className="text-sm text-[var(--dd-text-primary)]">No decisions are waiting.</span>
                        <span className="text-xs text-[var(--dd-text-muted)]">
                            A ❓ DECISION in a session's last reply, or one posted with question_post, shows here.
                        </span>
                    </div>
                ) : (
                    sessions.map((session) => (
                        <DecisionSessionCard
                            key={session.sessionId ?? session.lastAt}
                            session={session}
                            onSent={setLastSend}
                        />
                    ))
                )}
            </div>
        </QaClockProvider>
    );
}
