import { isAbsolute } from "node:path";
import {
    acknowledgeSessionMessage,
    cancelSessionMessage,
    enqueueSessionMessage,
    listSessionMessages,
    offerSessionMessage,
    type SessionMessageTarget,
} from "@genesiscz/utils/agent-sessions/message-queue";
import { out } from "@genesiscz/utils/logger";
import type { Command } from "commander";
import { readWorkerPrompt } from "./worker";

interface QueueFlags extends Record<string, unknown> {
    session?: string;
    home?: string;
    queueRoot?: string;
    idempotencyKey?: string;
    consumer?: string;
}

export function registerSessionQueueCommand({
    program,
    provider,
    output = (value) => out.result(value),
    enqueue = enqueueSessionMessage,
}: {
    program: Command;
    provider: SessionMessageTarget["provider"];
    output?: (value: unknown) => void;
    enqueue?: typeof enqueueSessionMessage;
}): void {
    const target = (flags: QueueFlags): SessionMessageTarget => {
        if (!flags.session?.trim() || !flags.home?.trim() || !isAbsolute(flags.home)) {
            throw new Error("Pass an exact --session and absolute --home to address this conversation.");
        }

        return { provider, sessionId: flags.session.trim(), sourceHome: flags.home };
    };
    const queue = program
        .command("queue")
        .description("Persist messages for an exact session; received only after its consumer acknowledges")
        .requiredOption("--session <id>", "Exact native provider session id")
        .requiredOption("--home <path>", "Absolute source home of that session")
        .option("--queue-root <path>", "Override the shared message queue directory")
        .option("--prompt <text>", "Message to persist")
        .option("--prompt-file <path>", "Read the message from a file")
        .option("--idempotency-key <key>", "Reuse the same message only when its text is unchanged")
        .option("--json", "Print JSON (the default)");
    queue.action(async (flags: QueueFlags) => {
        const text = readWorkerPrompt(flags);
        if (!text?.trim()) {
            throw new Error("A nonempty --prompt or --prompt-file is required.");
        }

        const message = await enqueue({
            target: target(flags),
            text,
            idempotencyKey: flags.idempotencyKey,
            root: flags.queueRoot,
        });
        output({
            target: message.target,
            channel: "session-queue",
            delivered: message.state === "received",
            queued: message.state === "queued",
            accepted: true,
            message,
        });
    });
    queue
        .command("list")
        .description("Read the queue without claiming or acknowledging messages")
        .action((_options, command: Command) => {
            const flags = command.optsWithGlobals<QueueFlags>();
            const address = target(flags);
            output({ target: address, messages: listSessionMessages({ target: address, root: flags.queueRoot }) });
        });
    queue
        .command("offer <id>")
        .description("Claim one payload for a consumer; offering is not receipt acknowledgement")
        .requiredOption("--consumer <id>", "Explicit identity of the agent receiving the payload")
        .action(async (id: string, _options, command: Command) => {
            const flags = command.optsWithGlobals<QueueFlags>();
            const message = await offerSessionMessage({
                target: target(flags),
                id,
                consumer: flags.consumer ?? "",
                root: flags.queueRoot,
            });
            output({ delivered: false, offered: true, message });
        });
    queue
        .command("ack <id>")
        .description("Acknowledge only after this consumer has read its offered payload")
        .requiredOption("--consumer <id>", "The same consumer identity that offered this message")
        .action(async (id: string, _options, command: Command) => {
            const flags = command.optsWithGlobals<QueueFlags>();
            const message = await acknowledgeSessionMessage({
                target: target(flags),
                id,
                consumer: flags.consumer ?? "",
                root: flags.queueRoot,
            });
            output({ delivered: message.state === "received", message });
        });
    queue
        .command("cancel <id>")
        .description("Cancel a message that has not been offered to a consumer")
        .action(async (id: string, _options, command: Command) => {
            const flags = command.optsWithGlobals<QueueFlags>();
            const message = await cancelSessionMessage({ target: target(flags), id, root: flags.queueRoot });
            output({ delivered: false, message });
        });
}
