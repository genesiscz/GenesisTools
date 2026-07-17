import { Button } from "@app/utils/ui/components/button";
import { Card, CardContent } from "@app/utils/ui/components/card";
import { Input } from "@app/utils/ui/components/input";
import type { AskMessageRecord } from "@app/youtube/lib/types";
import { useState } from "react";

export interface CollectionAskPanelProps {
    messages: AskMessageRecord[];
    busy: boolean;
    error?: string | null;
    onSend: (question: string) => void;
}

export function CollectionAskPanel({ messages, busy, error, onSend }: CollectionAskPanelProps) {
    const [draft, setDraft] = useState("");
    const send = () => {
        const question = draft.trim();

        if (!question || busy) {
            return;
        }

        onSend(question);
        setDraft("");
    };

    return (
        <Card>
            <CardContent className="space-y-3 pt-4">
                <div className="max-h-96 space-y-2 overflow-y-auto">
                    {messages.map((message) => {
                        if (message.role === "tool") {
                            return (
                                <p key={message.id} className="text-xs italic text-muted-foreground">
                                    Looked at:{" "}
                                    {message.toolName === "list_videos"
                                        ? "collection videos"
                                        : `transcript (${message.toolArgsJson ?? ""})`}
                                </p>
                            );
                        }

                        return (
                            <div
                                key={message.id}
                                className={
                                    message.role === "user" ? "text-sm font-medium" : "text-sm text-muted-foreground"
                                }
                            >
                                {message.content}
                            </div>
                        );
                    })}
                    {busy ? <p className="text-sm text-muted-foreground">Thinking…</p> : null}
                    {error ? <p className="text-sm text-destructive">{error}</p> : null}
                </div>
                <div className="flex gap-2">
                    <Input
                        placeholder="Ask about this collection… (10 💎)"
                        value={draft}
                        disabled={busy}
                        onChange={(event) => setDraft(event.target.value)}
                        onKeyDown={(event) => {
                            if (event.key === "Enter") {
                                send();
                            }
                        }}
                    />
                    <Button disabled={busy || !draft.trim()} onClick={send}>
                        Ask
                    </Button>
                </div>
            </CardContent>
        </Card>
    );
}
