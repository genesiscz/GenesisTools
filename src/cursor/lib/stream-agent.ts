import { CursorStreamAdapter } from "@app/utils/agents/adapters/cursor";
import { TerminalRenderer } from "@app/utils/agents/renderers/TerminalRenderer";
import type { Subprocess } from "bun";

export interface StreamCursorAgentOptions {
    raw?: boolean;
    adapter?: CursorStreamAdapter;
    renderer?: Pick<TerminalRenderer, "render">;
    onTextDelta?: (text: string) => void;
    onBlocks?: (output: string) => void;
}

export async function streamCursorAgent(proc: Subprocess, opts: StreamCursorAgentOptions = {}): Promise<number> {
    const adapter = opts.adapter ?? new CursorStreamAdapter();
    const renderer = opts.renderer ?? new TerminalRenderer({ colors: false });
    const raw = opts.raw ?? false;

    const decoder = new TextDecoder();
    let buffer = "";
    let wroteText = false;

    if (!proc.stdout || typeof proc.stdout === "number") {
        throw new Error("cursor agent stdout is not piped");
    }

    const reader = proc.stdout.getReader();

    try {
        try {
            while (true) {
                const { done, value } = await reader.read();

                if (done) {
                    break;
                }

                buffer += decoder.decode(value, { stream: true });

                for (let newlineIdx = buffer.indexOf("\n"); newlineIdx !== -1; newlineIdx = buffer.indexOf("\n")) {
                    const line = buffer.slice(0, newlineIdx);
                    buffer = buffer.slice(newlineIdx + 1);

                    const parsed = adapter.parseLine(line);

                    if (parsed.textDelta) {
                        opts.onTextDelta?.(parsed.textDelta);
                        wroteText = true;
                    }

                    if (parsed.blocks.length > 0 && !raw) {
                        if (wroteText) {
                            wroteText = false;
                        }

                        const rendered = renderer.render(parsed.blocks);
                        const output = rendered.join("\n");

                        if (output.trim()) {
                            opts.onBlocks?.(output);
                        }
                    }

                    if (parsed.done) {
                        break;
                    }
                }
            }
        } finally {
            reader.releaseLock();
        }

        if (proc.stderr && typeof proc.stderr !== "number") {
            await new Response(proc.stderr).text();
        }
        return await proc.exited;
    } catch (err) {
        proc.kill();
        await proc.exited;
        throw err;
    }
}
