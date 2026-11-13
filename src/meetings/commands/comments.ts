import { SafeJSON } from "@genesiscz/utils/json";
import { out } from "@genesiscz/utils/logger";
import type { Command } from "commander";
import { momentTargetSchema } from "../lib/moment-schema";
import { withMeetingsClient } from "../lib/service/client";
import { fail } from "../lib/shared";

export function registerCommentsCommand(program: Command): void {
    const comments = program
        .command("comments")
        .description("List, acknowledge or withdraw comments for the listening agent");
    comments
        .command("list")
        .argument("<meeting>")
        .option("--json", "print the comments and listeners as JSON")
        .action(async (meeting: string, options: { json?: boolean }) => {
            try {
                const result = await withMeetingsClient((client) => client.call("comment.list", { meeting }));
                out.result(SafeJSON.stringify(result, null, options.json ? undefined : 2));
            } catch (error) {
                fail(error);
            }
        });
    comments
        .command("stage")
        .argument("<meeting>")
        .requiredOption("--target <json>")
        .requiredOption("--text <text>")
        .option("--quote <text>")
        .option("--json")
        .action(async (meeting: string, options: { target: string; text: string; quote?: string }) => {
            try {
                const target = momentTargetSchema.parse(SafeJSON.parse(options.target, { strict: true }));
                const result = await withMeetingsClient((client) =>
                    client.call("comment.stage", {
                        meeting,
                        target,
                        text: options.text,
                        ...(options.quote ? { quote: options.quote } : {}),
                    })
                );
                out.result(SafeJSON.stringify(result));
            } catch (error) {
                fail(error);
            }
        });
    comments
        .command("send")
        .argument("<meeting>")
        .option("--ids <ids...>")
        .option("--reason <text>")
        .option("--require-listener", "keep comments staged when no receiver is connected")
        .option("--json")
        .action(async (meeting: string, options: { ids?: string[]; reason?: string; requireListener?: boolean }) => {
            try {
                const result = await withMeetingsClient((client) =>
                    client.call("comment.send", {
                        meeting,
                        ...(options.ids ? { ids: options.ids } : {}),
                        ...(options.requireListener ? { requireListener: true } : {}),
                        ...(options.reason ? { reason: options.reason } : {}),
                    })
                );
                out.result(SafeJSON.stringify(result));
            } catch (error) {
                fail(error);
            }
        });
    for (const action of ["read", "withdraw", "unstage"] as const) {
        comments
            .command(action)
            .argument("<meeting>")
            .argument("<id>")
            .option("--json", "print the updated comment as JSON")
            .description(
                action === "read"
                    ? "Acknowledge a sent comment before acting on it"
                    : action === "unstage"
                      ? "Remove a staged comment before sending it"
                      : "Withdraw a comment before a receiver reads it"
            )
            .action(async (meeting: string, id: string, options: { json?: boolean }) => {
                try {
                    const result = await withMeetingsClient((client) =>
                        client.call(`comment.${action}`, { meeting, id })
                    );
                    out.result(SafeJSON.stringify(result, null, options.json ? undefined : 2));
                } catch (error) {
                    fail(error);
                }
            });
    }
}
