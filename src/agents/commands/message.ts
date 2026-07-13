import { readFileSync } from "node:fs";
import { logger, out } from "@app/logger";
import { SafeJSON } from "@app/utils/json";
import type { Command } from "commander";
import { deriveRegistry } from "../lib/derived-registry";
import { FriendlyError, listAvailableNames, runWithFriendlyErrors } from "../lib/errors";
import { withFeedLock } from "../lib/feed";
import { ensureSessionDir, sessionPaths } from "../lib/paths";
import { resolveMany, resolveOne } from "../lib/resolve-token";
import { resolveSession } from "../lib/session-resolve";
import { runStaleSweep } from "../lib/slot-lock";
import type { AgentRecord, MessageEvent } from "../lib/types";

const log = logger.child({ component: "agents:message" });

interface MessageOpts {
    from?: string;
    to?: string;
    body?: string;
    bodyFile?: string;
    reply?: string;
    meta?: string;
    private?: boolean;
    session?: string;
}

function resolveBody(opts: MessageOpts): string | undefined {
    if (opts.bodyFile) {
        if (opts.body) {
            throw new FriendlyError("--body and --body-file are mutually exclusive", "Pass only one.");
        }

        return readFileSync(opts.bodyFile, "utf8");
    }

    return opts.body;
}

function parseMeta(raw: string | undefined): Record<string, unknown> {
    if (!raw) {
        return {};
    }

    const parsed = SafeJSON.parse(raw);

    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        throw new FriendlyError("--meta must be a JSON object", `Example: --meta '{"priority":"high"}'`);
    }

    return parsed as Record<string, unknown>;
}

async function runMessageImpl(opts: MessageOpts): Promise<void> {
    const body = resolveBody(opts);
    const hasBody = typeof body === "string" && body.length > 0;
    const isAck = !hasBody && Boolean(opts.reply);

    if (!hasBody && !isAck) {
        const records = await sessionRegistryQuietly(opts.session);
        throw new FriendlyError(
            "--body is required (or --reply <msg-id> with no --body for a pure ack)",
            `Examples:\n  tools agents message --from ${exampleSenderName(records)} --to peer --body 'hi'\n  tools agents message --from ${exampleSenderName(records)} --reply 0001 --body 'thanks'\n  tools agents message --from ${exampleSenderName(records)} --reply 0001                # ack`
        );
    }

    const resolved = resolveSession(opts.session);
    const paths = sessionPaths(resolved.session);
    ensureSessionDir(paths);
    await runStaleSweep(paths);

    const meta = parseMeta(opts.meta);

    const event = await withFeedLock(paths, ({ events, appendMessageEvent }) => {
        const registry = deriveRegistry(events);

        if (!opts.from) {
            throw new FriendlyError(
                "--from is required",
                `Registered: ${listAvailableNames(registry)}\nExample:\n  tools agents message --from <one of above> --body 'hi'`
            );
        }

        const sender = resolveOne(registry, opts.from, "sender");
        const toIds = resolveMany(registry, opts.to, "recipient");

        if (opts.reply) {
            const originalSender = findOriginalSenderInEvents(events, opts.reply);

            if (originalSender) {
                if (originalSender !== sender.agent_id && !toIds.includes(originalSender)) {
                    toIds.push(originalSender);
                }
            } else if (toIds.length === 0) {
                throw new FriendlyError(
                    `Could not resolve original sender for reply to message "${opts.reply}"`,
                    "Specify explicit recipients with --to, or verify the message ID."
                );
            }
        }

        if (toIds.includes(sender.agent_id)) {
            out.log.warn(
                `recipient list includes the sender (${sender.agent_id}); senders do NOT see their own messages on their own login stream — the message is stored but the sender's stream filters it out.`
            );
        }

        const messageInput: Omit<MessageEvent, "seq" | "ts" | "message_id"> = {
            type: "message",
            from_agent_id: sender.agent_id,
            from_agent_name: sender.agent_name,
            to_agent_ids: toIds,
            body: hasBody ? (body as string) : "",
            meta,
            private: Boolean(opts.private),
            ...(opts.reply ? { in_reply_to: opts.reply } : {}),
        };

        return appendMessageEvent(messageInput);
    });

    const isBroadcast = !opts.reply && event.to_agent_ids.length === 0;
    out.println(
        SafeJSON.stringify(
            {
                message_id: event.message_id,
                seq: event.seq,
                kind: opts.reply ? (hasBody ? "reply" : "ack") : isBroadcast ? "broadcast" : "direct",
                in_reply_to: opts.reply ?? null,
                recipients: isBroadcast ? "(all peers except sender)" : event.to_agent_ids,
                body_length: event.body.length,
            },
            { strict: true }
        )
    );
}

function findOriginalSenderInEvents(
    events: { type: string; message_id?: string; from_agent_id?: string }[],
    messageId: string
): string | null {
    for (let i = events.length - 1; i >= 0; i--) {
        const event = events[i];

        if (event?.type === "message" && event.message_id === messageId) {
            return event.from_agent_id ?? null;
        }
    }

    return null;
}

async function sessionRegistryQuietly(sessionExplicit?: string): Promise<AgentRecord[]> {
    try {
        const resolved = resolveSession(sessionExplicit);
        const paths = sessionPaths(resolved.session);
        const { readFeed } = await import("../lib/feed");
        const events = await readFeed(paths);
        return deriveRegistry(events);
    } catch (err) {
        log.debug({ err, sessionExplicit }, "could not load registry for message examples");
        return [];
    }
}

function exampleSenderName(records: AgentRecord[]): string {
    return records[0]?.agent_name ?? "lead";
}

export async function runMessage(opts: MessageOpts): Promise<void> {
    await runWithFriendlyErrors(() => runMessageImpl(opts));
}

export function registerMessageCommand(program: Command): void {
    program
        .command("message")
        .description("Send a message (direct, broadcast, reply, or pure ack)")
        .option("--from <token>", "Sender agent — name or id")
        .option("--to <csv>", "Recipient agents — comma-separated names or ids; empty = broadcast")
        .option("--body <text>", "Message body (omit + --reply for pure ack)")
        .option(
            "--body-file <path>",
            "Read message body from a file instead of --body (avoids shell-quoting issues with long/multi-line bodies)"
        )
        .option("--reply <msg-id>", "Mark this as a reply to a previous message_id (auto-routes to original sender)")
        .option("--meta <json>", "Optional JSON object")
        .option("--private", "Mark as private (v1: stored, not enforced)")
        .option("--session <id>", "Override session resolution")
        .action(async (opts: MessageOpts) => {
            await runMessage(opts);
        });
}
