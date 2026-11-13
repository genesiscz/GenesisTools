import { runServeCommand } from "@app/ai-proxy/commands/serve";
import { isValidThinkingMode } from "@app/ai-proxy/lib/thinking-config";
import type { CursorTranslationMode, ThinkingPresentationMode } from "@app/ai-proxy/lib/types";
import type { Command } from "commander";

export function register(program: Command): void {
    program
        .command("serve")
        .description("Start the OpenAI-compatible proxy server")
        .option("--port <number>", "Listen port", (value) => Number.parseInt(value, 10))
        .option("--host <host>", "Listen host")
        .option("--translate-cursor <mode>", "Cursor translation mode: auto|on|off")
        .option("--thinking <mode>", "Thinking presentation: raw|cursor|folded")
        .option("--no-translate", "Disable Cursor translation")
        .action(async (options) => {
            const thinking =
                options.thinking && isValidThinkingMode(options.thinking)
                    ? (options.thinking as ThinkingPresentationMode)
                    : undefined;

            await runServeCommand({
                port: options.port,
                host: options.host,
                translateCursor: options.translateCursor as CursorTranslationMode | undefined,
                thinking,
                noTranslate: options.noTranslate,
            });
        });
}
