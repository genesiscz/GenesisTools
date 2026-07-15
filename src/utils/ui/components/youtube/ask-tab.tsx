import { Button } from "@app/utils/ui/components/button";
import { Input } from "@app/utils/ui/components/input";
import { formatTimecode } from "@app/utils/ui/components/youtube/time";
import type { AskCitation, VideoId } from "@app/youtube/lib/types";
import { Loader2, MessageCircleQuestion } from "lucide-react";
import { useState } from "react";

export interface AskTabProps {
    videoId: VideoId;
    onSeek: (seconds: number) => void;
    useAskVideo: (id: VideoId) => {
        mutateAsync: (vars: {
            question: string;
            topK?: number;
            provider?: string;
            model?: string;
        }) => Promise<{ answer: string; citations?: AskCitation[] }>;
        isPending: boolean;
    };
}

interface AskExchange {
    question: string;
    answer: string;
    citations: AskCitation[];
}

export function AskTab({ videoId, onSeek, useAskVideo }: AskTabProps) {
    const ask = useAskVideo(videoId);
    const [question, setQuestion] = useState("");
    const [history, setHistory] = useState<AskExchange[]>([]);
    const [error, setError] = useState<string | null>(null);

    async function submit() {
        const trimmed = question.trim();

        if (trimmed === "" || ask.isPending) {
            return;
        }

        setError(null);
        try {
            const result = await ask.mutateAsync({ question: trimmed });
            setHistory((prev) => [
                { question: trimmed, answer: result.answer, citations: result.citations ?? [] },
                ...prev,
            ]);
            setQuestion("");
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
        }
    }

    return (
        <div className="space-y-4">
            <div>
                <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-secondary">Ask the video</p>
                <p className="mt-1 text-sm text-muted-foreground">
                    Answers come from the transcript (semantic search + your configured LLM), with timestamp citations.
                </p>
            </div>

            <form
                className="flex items-center gap-2"
                onSubmit={(event) => {
                    event.preventDefault();
                    void submit();
                }}
            >
                <Input
                    value={question}
                    onChange={(event) => setQuestion(event.target.value)}
                    placeholder="What does the video say about…?"
                    disabled={ask.isPending}
                    className="h-9 flex-1 text-sm"
                />
                <Button type="submit" size="sm" disabled={ask.isPending || question.trim() === ""}>
                    {ask.isPending ? (
                        <>
                            <Loader2 className="size-4 animate-spin" /> Thinking…
                        </>
                    ) : (
                        "Ask"
                    )}
                </Button>
            </form>

            {error ? (
                <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-2.5 text-sm">
                    <p className="break-words text-destructive/90">{error}</p>
                </div>
            ) : null}

            {history.length === 0 && !ask.isPending && !error ? (
                <div className="flex items-start gap-3 rounded-2xl border border-dashed border-primary/25 p-5">
                    <MessageCircleQuestion className="mt-0.5 size-5 shrink-0 text-primary" />
                    <p className="text-sm text-muted-foreground">
                        No questions yet. The first question indexes the transcript, so it takes a little longer.
                    </p>
                </div>
            ) : null}

            <div className="space-y-3">
                {history.map((exchange, index) => (
                    <article
                        key={`${exchange.question}-${index}`}
                        className="rounded-2xl border border-white/8 bg-black/20 p-3"
                    >
                        <p className="text-sm font-semibold text-foreground/95">{exchange.question}</p>
                        <p className="mt-2 whitespace-pre-wrap text-sm leading-relaxed text-foreground/90">
                            {exchange.answer}
                        </p>
                        {exchange.citations.length > 0 ? (
                            <div className="mt-3 flex flex-wrap gap-1.5">
                                {exchange.citations.map((citation, citationIndex) =>
                                    citation.startSec !== null ? (
                                        <button
                                            key={citationIndex}
                                            type="button"
                                            onClick={() => onSeek(citation.startSec ?? 0)}
                                            className="yt-timecode inline-flex h-6 items-center px-2 font-mono text-[12px] tabular-nums"
                                        >
                                            {formatTimecode(citation.startSec)}
                                        </button>
                                    ) : null
                                )}
                            </div>
                        ) : null}
                    </article>
                ))}
            </div>
        </div>
    );
}
