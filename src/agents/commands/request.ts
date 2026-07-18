import { readFileSync } from "node:fs";
import { out } from "@app/logger";
import { SafeJSON } from "@app/utils/json";
import type { Command } from "commander";
import { sendRequest } from "../lib/request";
import { resolveSession } from "../lib/session-resolve";

interface RequestOptions {
    from: string;
    to: string;
    body?: string;
    bodyFile?: string;
    timeout?: string;
    session?: string;
}

export function registerRequestCommand(program: Command): void {
    program
        .command("request")
        .description("Send a message and block until a correlated reply arrives")
        .requiredOption("--from <token>", "Sender agent name or id")
        .requiredOption("--to <token>", "Single recipient agent name or id")
        .option("--body <text>", "Request body")
        .option("--body-file <path>", "Read request body from a file")
        .option("--timeout <seconds>", "Reply timeout in seconds", "300")
        .option("--session <id>", "Override session resolution")
        .action(async (options: RequestOptions) => {
            if (options.body && options.bodyFile) {
                throw new Error("--body and --body-file are mutually exclusive");
            }

            const body = options.bodyFile ? readFileSync(options.bodyFile, "utf8") : options.body;
            if (!body) {
                throw new Error("--body or --body-file is required");
            }

            const timeoutSeconds = Number.parseFloat(options.timeout ?? "300");
            if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0) {
                throw new Error("--timeout must be greater than zero");
            }

            const session = resolveSession(options.session).session;
            const reply = await sendRequest({
                session,
                from: options.from,
                to: options.to,
                body,
                timeoutMs: timeoutSeconds * 1_000,
            });
            out.result(SafeJSON.stringify(reply, { strict: true }));
        });
}
