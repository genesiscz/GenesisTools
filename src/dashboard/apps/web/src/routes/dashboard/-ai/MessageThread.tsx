import type { UIMessage } from "@tanstack/ai-react";
import { ScrollArea } from "@ui/components/scroll-area";
import { MessageSquareDashed } from "lucide-react";
import { useEffect, useRef } from "react";
import type { AiMessage } from "@/drizzle";
import { MessageBubble } from "./MessageBubble";

interface MessageThreadProps {
    /** Persisted messages loaded from DB (shown when no active stream) */
    persistedMessages: AiMessage[];
    /** Live streaming messages from useChat — shown while a stream is active */
    streamingMessages: UIMessage[];
    isStreaming: boolean;
}

export function MessageThread({ persistedMessages, streamingMessages, isStreaming }: MessageThreadProps) {
    const bottomRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        bottomRef.current?.scrollIntoView({ behavior: "smooth" });
    }, [persistedMessages.length, streamingMessages.length, isStreaming]);

    // While streaming (or once a stream has produced messages), show the live
    // streaming messages; otherwise show the persisted DB rows.
    const showStreaming = isStreaming || streamingMessages.length > 0;

    if (!showStreaming && persistedMessages.length === 0) {
        return (
            <div className="flex flex-1 flex-col items-center justify-center gap-3 text-white/30">
                <MessageSquareDashed className="h-10 w-10" />
                <p className="text-sm font-mono">Start a conversation…</p>
            </div>
        );
    }

    return (
        <ScrollArea className="flex-1">
            <div className="flex flex-col gap-3 p-4">
                {showStreaming
                    ? streamingMessages.map((msg) => {
                          const textContent = msg.parts
                              .filter((p): p is { type: "text"; content: string } => p.type === "text")
                              .map((p) => p.content)
                              .join("");

                          const adaptedMsg = {
                              id: msg.id,
                              role: msg.role as "user" | "assistant" | "system",
                              content: textContent,
                              createdAt: msg.createdAt?.toISOString() ?? new Date().toISOString(),
                          };

                          const isLast = msg === streamingMessages[streamingMessages.length - 1];

                          return (
                              <MessageBubble
                                  key={msg.id}
                                  message={adaptedMsg}
                                  isStreaming={isStreaming && msg.role === "assistant" && isLast}
                              />
                          );
                      })
                    : persistedMessages.map((msg) => <MessageBubble key={msg.id} message={msg} />)}

                <div ref={bottomRef} />
            </div>
        </ScrollArea>
    );
}
