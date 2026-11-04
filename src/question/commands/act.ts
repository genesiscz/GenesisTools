import { out } from "@genesiscz/utils/logger";
import type { Command } from "commander";
import { act, realActDeps } from "../lib/act/act";

/**
 * `tools question act <token> --key <key>`: answers one decision letter from a stored act token, through the same door
 * as the Telegram button and the phone (`POST /api/act`). The Mac banner's letter buttons run it; `--key` is the
 * idempotency key, so a double click answers once.
 */
export function registerActCommand(program: Command): void {
    program
        .command("act <token>")
        .description("Answer one decision letter from an act token (the banner and phone buttons run this)")
        .requiredOption("--key <key>", "the idempotency key; a retry with the same key returns the first receipt")
        .option("--json", "print the receipt as JSON")
        .action(async (token: string, options: { key: string; json?: boolean }) => {
            const receipt = await act({ token, key: options.key, deps: await realActDeps() });

            if (options.json) {
                out.result(receipt);
            } else {
                const what = receipt.decision
                    ? `DECISION ${receipt.decision.number} ${receipt.decision.option}`
                    : "act";
                const detail = receipt.outcome.detail ? `: ${receipt.outcome.detail}` : "";
                out.println(`${what} ${receipt.outcome.kind}${detail}`);
            }

            process.exitCode = receipt.outcome.kind === "refused" ? 1 : 0;
        });
}
