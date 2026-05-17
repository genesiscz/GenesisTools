import { Button } from "@ui/components/button";
import { Textarea } from "@ui/components/textarea";
import { Loader2, SendHorizonal } from "lucide-react";
import type React from "react";
import { useRef, useState } from "react";

interface ChatInputProps {
    onSend: (content: string) => void;
    isStreaming: boolean;
    disabled: boolean;
}

export function ChatInput({ onSend, isStreaming, disabled }: ChatInputProps) {
    const [value, setValue] = useState("");
    const textareaRef = useRef<HTMLTextAreaElement>(null);

    function handleSend() {
        const trimmed = value.trim();

        if (!trimmed || isStreaming || disabled) {
            return;
        }

        onSend(trimmed);
        setValue("");
        textareaRef.current?.focus();
    }

    function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
        if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            handleSend();
        }
    }

    const charCount = value.length;
    const isOverLimit = charCount > 4000;

    return (
        <div className="border-t border-white/10 bg-black/20 p-4 backdrop-blur-sm">
            <div className="relative flex flex-col gap-2">
                <Textarea
                    ref={textareaRef}
                    value={value}
                    onChange={(e) => setValue(e.target.value)}
                    onKeyDown={handleKeyDown}
                    placeholder="Message… (Cmd+Enter to send)"
                    disabled={isStreaming || disabled}
                    rows={3}
                    className={[
                        "resize-none rounded-lg border bg-white/5 font-mono text-sm text-white/90",
                        "placeholder:text-white/30 focus:ring-1 focus:ring-violet-400/60",
                        "disabled:opacity-50",
                        isOverLimit ? "border-red-500/60" : "border-white/10",
                    ].join(" ")}
                />

                <div className="flex items-center justify-between">
                    <span
                        className={[
                            "text-xs font-mono tabular-nums",
                            isOverLimit ? "text-red-400" : "text-white/30",
                        ].join(" ")}
                    >
                        {charCount}/4000
                    </span>

                    <Button
                        onClick={handleSend}
                        disabled={!value.trim() || isStreaming || disabled || isOverLimit}
                        size="sm"
                        className={[
                            "gap-1.5 rounded-lg px-4 font-mono text-xs transition-all",
                            "bg-violet-600 text-white hover:bg-violet-500 disabled:opacity-40",
                        ].join(" ")}
                    >
                        {isStreaming ? (
                            <>
                                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                Generating…
                            </>
                        ) : (
                            <>
                                <SendHorizonal className="h-3.5 w-3.5" />
                                Send
                            </>
                        )}
                    </Button>
                </div>
            </div>
        </div>
    );
}
