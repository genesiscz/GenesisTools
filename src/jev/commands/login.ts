import { Browser } from "@genesiscz/utils/browser";
import { isInteractive } from "@genesiscz/utils/cli";
import { logger, out } from "@genesiscz/utils/logger";
import * as p from "@genesiscz/utils/prompts/p";
import type { Command } from "commander";
import { GATEWAY_KEYS_URL, saveApiKey } from "../lib/auth";

export function registerLogin(program: Command): void {
    program
        .command("login")
        .description("Open Vercel and save an AI Gateway key with owner-only permissions")
        .option("--stdin", "Read a piped key without opening a browser")
        .action(async (options: { stdin?: boolean }) => {
            let apiKey: string;
            if (options.stdin) {
                if (process.stdin.isTTY) {
                    throw new Error("--stdin expects a piped key. Run tools jev login for a masked prompt.");
                }

                apiKey = (await Bun.stdin.text()).trim();
            } else {
                if (!isInteractive()) {
                    throw new Error("Run tools jev login in a terminal or set AI_GATEWAY_API_KEY.");
                }

                out.log.info(`Create an AI Gateway API key: ${GATEWAY_KEYS_URL}`);
                const opened = await Browser.open(GATEWAY_KEYS_URL);
                if (!opened.success) {
                    logger.warn({ error: opened.error }, "Could not open Vercel API keys");
                    out.log.warn("Open the URL above in your browser.");
                }

                apiKey = await p.password({
                    message: "Paste your AI Gateway API key",
                    validate: (value) => (value.trim() ? undefined : "Enter a nonempty API key"),
                });
            }

            const file = await saveApiKey(apiKey);
            out.log.success(`Key saved to ${file} with mode 0600. Try: tools jev demo`);
        });
}
