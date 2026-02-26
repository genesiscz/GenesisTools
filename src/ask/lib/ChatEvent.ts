import type { ChatResponse } from "./types";

type ChatEventType = "text" | "thinking" | "tool_call" | "tool_result" | "done";

export class ChatEvent {
    readonly type: ChatEventType;
    readonly text?: string;
    readonly name?: string;
    readonly input?: unknown;
    readonly output?: unknown;
    readonly duration?: number;
    readonly response?: ChatResponse;

    private constructor(type: ChatEventType, data: Partial<Omit<ChatEvent, "type">>) {
        this.type = type;
        Object.assign(this, data);
    }

    // === Factory methods ===
    static text(text: string): ChatEvent {
        return new ChatEvent("text", { text });
    }
    static thinking(text: string): ChatEvent {
        return new ChatEvent("thinking", { text });
    }
    static toolCall(name: string, input: unknown): ChatEvent {
        return new ChatEvent("tool_call", { name, input });
    }
    static toolResult(name: string, output: unknown, duration: number): ChatEvent {
        return new ChatEvent("tool_result", { name, output, duration });
    }
    static done(response: ChatResponse): ChatEvent {
        return new ChatEvent("done", { response });
    }

    // === Type guards ===
    isText(): this is ChatEvent & { text: string } {
        return this.type === "text";
    }
    isThinking(): this is ChatEvent & { text: string } {
        return this.type === "thinking";
    }
    isToolCall(): this is ChatEvent & { name: string; input: unknown } {
        return this.type === "tool_call";
    }
    isToolResult(): this is ChatEvent & { name: string; output: unknown; duration: number } {
        return this.type === "tool_result";
    }
    isDone(): this is ChatEvent & { response: ChatResponse } {
        return this.type === "done";
    }
}
