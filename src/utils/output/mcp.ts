/** A `Reply` as an MCP tool answer: the text form for the model, the whole reply as the structured result. */
import type { ToolAnswer } from "@genesiscz/utils/mcp/tool-entry";
import { type Door, type Formatter, render } from "./formatter";
import type { Reply } from "./reply";

export function replyToToolAnswer<T>(reply: Reply<T>, formatter: Formatter<T>, door: Door): ToolAnswer {
    const { stdout, stderr } = render(reply, formatter, "text", { tty: false, width: 120, door });
    const text = [stdout, ...stderr].filter((part) => part.length > 0).join("\n");
    return {
        text: text.length > 0 ? text : reply.ok ? "ok" : "failed",
        structuredContent: { ...reply },
    };
}
