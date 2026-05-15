import { Streamdown } from "streamdown";
import type { AiMessage } from "@/drizzle";

interface MessageBubbleProps {
    message: AiMessage | { id: string; role: "user" | "assistant" | "system"; content: string; createdAt: string };
    isStreaming?: boolean;
}

// Static Record — NEVER dynamic interpolation (no bg-${role}, Tailwind can't see it).
const ROLE_STYLES: Record<"user" | "assistant" | "system", string> = {
    user: "border-l-cyan-400/70 bg-cyan-500/5",
    assistant: "border-l-violet-400/70 bg-violet-500/5",
    system: "border-l-amber-400/70 bg-amber-500/5",
};

const ROLE_LABEL: Record<"user" | "assistant" | "system", string> = {
    user: "You",
    assistant: "Assistant",
    system: "System",
};

const ROLE_LABEL_COLOR: Record<"user" | "assistant" | "system", string> = {
    user: "text-cyan-400",
    assistant: "text-violet-400",
    system: "text-amber-400",
};

export function MessageBubble({ message, isStreaming = false }: MessageBubbleProps) {
    const role = message.role as "user" | "assistant" | "system";
    const containerStyle = ROLE_STYLES[role];
    const labelStyle = ROLE_LABEL_COLOR[role];

    return (
        <article
            className={[
                "group relative rounded-lg border-l-2 px-4 py-3 backdrop-blur-sm transition-all",
                "hover:-translate-y-px hover:shadow-lg",
                containerStyle,
            ].join(" ")}
        >
            <header className="mb-1.5 flex items-center gap-2">
                <span className={["text-xs font-semibold font-mono uppercase tracking-widest", labelStyle].join(" ")}>
                    {ROLE_LABEL[role]}
                </span>
                <span className="text-xs text-white/30">
                    {new Date(message.createdAt).toLocaleTimeString([], {
                        hour: "2-digit",
                        minute: "2-digit",
                    })}
                </span>
            </header>

            <div className="prose prose-invert prose-sm max-w-none font-mono text-sm leading-relaxed text-white/85">
                {role === "assistant" ? (
                    <Streamdown>{message.content}</Streamdown>
                ) : (
                    <p className="whitespace-pre-wrap">{message.content}</p>
                )}

                {isStreaming && (
                    <span
                        aria-label="Streaming"
                        className="ml-0.5 inline-block h-4 w-0.5 animate-pulse bg-violet-400 align-middle"
                    />
                )}
            </div>
        </article>
    );
}
