import { selectedProvider } from "@genesiscz/utils/ai/evaluation/cli";
import { Browser } from "@genesiscz/utils/browser";
import { isInteractive } from "@genesiscz/utils/cli";
import { logger, out } from "@genesiscz/utils/logger";
import * as p from "@genesiscz/utils/prompts/p";
import type { Command } from "commander";
import { GATEWAY_KEYS_URL, saveProviderKey, TYPESAFE_KEYS_URL } from "../lib/auth";

export function registerLogin(program: Command): void {
    program
        .command("login")
        .description("Open the provider console and save its key with owner-only permissions")
        .option("--stdin", "Read a piped key without opening a browser")
        .action(async (options: { stdin?: boolean }) => {
            const provider = selectedProvider(program);
            const url = provider === "vercel" ? GATEWAY_KEYS_URL : TYPESAFE_KEYS_URL;
            let apiKey: string;
            if (options.stdin) {
                if (process.stdin.isTTY) {
                    throw new Error("--stdin expects a piped key. Run tools jev login for a masked prompt.");
                }

                apiKey = (await Bun.stdin.text()).trim();
            } else {
                if (!isInteractive()) {
                    throw new Error(
                        "Run tools jev login --provider vercel|typesafe in a terminal or pipe a key with --stdin."
                    );
                }

                out.log.info(`Create a ${provider} API key: ${url}`);
                const opened = await Browser.open(url);
                if (!opened.success) {
                    logger.warn({ error: opened.error }, "Could not open Vercel API keys");
                    out.log.warn("Open the URL above in your browser.");
                }

                apiKey = await p.password({
                    message: `Paste your ${provider} API key`,
                    validate: (value) => (value.trim() ? undefined : "Enter a nonempty API key"),
                });
            }

            const file = await saveProviderKey({ apiKey, provider });
            out.log.success(`Key saved to ${file} with mode 0600. Try: tools jev demo --provider ${provider}`);
        });
}
