import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { withFileLock } from "@genesiscz/utils/storage/file-lock";
import { toolDataDir } from "@genesiscz/utils/storage/root";
import { atomicWriteFileSync } from "@genesiscz/utils/storage/storage";
import { workerSourceHome } from "@genesiscz/utils/worker/delivery";
import { z } from "zod";

const targetSchema = z.object({
    provider: z.enum(["claude", "codex", "grok"]),
    sessionId: z.string().trim().min(1),
    sourceHome: z.string().trim().min(1).refine(isAbsolute, "An absolute source home is required"),
});
export type SessionMessageTarget = z.infer<typeof targetSchema>;
const messageSchema = z.object({
    id: z.string().min(1),
    target: targetSchema,
    text: z.string().min(1),
    state: z.enum(["queued", "offered", "received", "cancelled"]),
    createdAt: z.string(),
    updatedAt: z.string(),
    consumer: z.string().optional(),
});
export type SessionMessage = z.infer<typeof messageSchema>;
export type SessionMessageState = SessionMessage["state"];
/** The largest text one queued message may carry; every read parses the whole queue file. */
export const MAX_SESSION_MESSAGE_BYTES = 64 * 1024;
/** How long a received or cancelled message stays in its queue before the next write drops it. */
const TERMINAL_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
/** Dropped messages leave a text-free receipt; this many newest receipts are kept per queue. */
const MAX_RECEIPTS = 1000;
const receiptSchema = z.object({
    id: z.string().min(1),
    state: z.enum(["received", "cancelled"]),
    updatedAt: z.string(),
    consumer: z.string().optional(),
    textHash: z.string(),
});
/**
 * A message's final state without its text. The prune keeps one for every message it drops, so a producer that
 * was away longer than the retention can still confirm the delivery instead of reading the absence as "not sent".
 */
export type SessionMessageReceipt = z.infer<typeof receiptSchema>;
/** What a producer needs to reconcile a message: its state, consumer and the hash of the text it carried. */
export type SessionMessageOutcome = Omit<SessionMessageReceipt, "state"> & { state: SessionMessageState };
interface QueueAddress {
    target: SessionMessageTarget;
    root?: string;
}

export function sessionMessageQueueRoot(root?: string): string {
    return root ?? toolDataDir("agent-messages");
}

function address(input: QueueAddress) {
    const target = targetSchema.parse(input.target);
    target.sourceHome = workerSourceHome(target.sourceHome);
    const root = sessionMessageQueueRoot(input.root);
    const key = createHash("sha256").update(SafeJSON.stringify(target)).digest("hex");
    return { target, root, file: join(root, `${key}.json`) };
}

function read(file: string, target: SessionMessageTarget): SessionMessage[] {
    if (!existsSync(file)) {
        return [];
    }
    const messages = z.array(messageSchema).parse(SafeJSON.parse(readFileSync(file, "utf8"), { strict: true }));
    if (
        messages.some(
            (message) =>
                message.target.provider !== target.provider ||
                message.target.sessionId !== target.sessionId ||
                message.target.sourceHome !== target.sourceHome
        )
    ) {
        throw new Error("Message queue contains a different session identity; refusing to read it.");
    }
    return messages;
}

/** Inspection never creates directories, claims messages or marks them received. */
export function listSessionMessages(input: QueueAddress): SessionMessage[] {
    const { file, target } = address(input);
    return read(file, target);
}

function receiptsFile(file: string): string {
    return file.replace(/\.json$/, ".receipts.jsonl");
}

function readReceipts(file: string): SessionMessageReceipt[] {
    const path = receiptsFile(file);
    if (!existsSync(path)) {
        return [];
    }
    return readFileSync(path, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => receiptSchema.parse(SafeJSON.parse(line, { strict: true })));
}

export function sessionMessageTextHash(text: string): string {
    return createHash("sha256").update(text).digest("hex");
}

/** Every message's outcome: the queued ones as they are, then the receipts of messages the prune dropped. */
export function listSessionMessageOutcomes(input: QueueAddress): SessionMessageOutcome[] {
    const { file, target } = address(input);
    const live = read(file, target).map((message) => ({
        id: message.id,
        state: message.state,
        updatedAt: message.updatedAt,
        ...(message.consumer ? { consumer: message.consumer } : {}),
        textHash: sessionMessageTextHash(message.text),
    }));
    const ids = new Set(live.map((message) => message.id));
    return [...live, ...readReceipts(file).filter((receipt) => !ids.has(receipt.id))];
}

function keyedMessageId(idempotencyKey: string): string {
    return createHash("sha256").update(idempotencyKey).digest("hex");
}

/**
 * The outcome of the message an earlier enqueue saved under this delivery key, if any, including one the prune
 * dropped; read-only like `listSessionMessages`.
 */
export function findKeyedSessionMessage(
    input: QueueAddress & { idempotencyKey: string }
): SessionMessageOutcome | undefined {
    const id = keyedMessageId(input.idempotencyKey);
    return listSessionMessageOutcomes(input).find((message) => message.id === id);
}

async function mutate(
    input: QueueAddress,
    edit: (messages: SessionMessage[], target: SessionMessageTarget) => SessionMessage
): Promise<SessionMessage> {
    const { target, root, file } = address(input);
    mkdirSync(root, { recursive: true, mode: 0o700 });
    return withFileLock(`${file}.lock`, async () => {
        const messages = read(file, target);
        const before = SafeJSON.stringify(messages);
        const result = edit(messages, target);
        const cutoff = Date.now() - TERMINAL_RETENTION_MS;
        const kept = messages.filter(
            (message) =>
                message === result ||
                !(message.state === "received" || message.state === "cancelled") ||
                Date.parse(message.updatedAt) >= cutoff
        );
        const dropped = messages.filter((message) => !kept.includes(message));
        if (dropped.length > 0) {
            // Written before the queue: a crash in between leaves a receipt for a message still queued, never neither.
            const receipts = [
                ...readReceipts(file),
                ...dropped.map((message) =>
                    receiptSchema.parse({
                        id: message.id,
                        state: message.state,
                        updatedAt: message.updatedAt,
                        consumer: message.consumer,
                        textHash: sessionMessageTextHash(message.text),
                    })
                ),
            ].slice(-MAX_RECEIPTS);
            atomicWriteFileSync(
                receiptsFile(file),
                `${receipts.map((receipt) => SafeJSON.stringify(receipt)).join("\n")}\n`,
                { mode: 0o600 }
            );
        }
        messages.splice(0, messages.length, ...kept);
        const after = SafeJSON.stringify(messages);
        if (before !== after) {
            atomicWriteFileSync(file, after, { mode: 0o600 });
            logger.info(
                { provider: target.provider, sessionId: target.sessionId, messageId: result.id, state: result.state },
                "Session message queue updated"
            );
        }
        return result;
    });
}

export async function enqueueSessionMessage(
    input: QueueAddress & { text: string; idempotencyKey?: string }
): Promise<SessionMessage> {
    if (!input.text.trim()) {
        throw new Error("A queued message must contain text.");
    }

    if (Buffer.byteLength(input.text, "utf8") > MAX_SESSION_MESSAGE_BYTES) {
        throw new Error(`A queued message is limited to ${MAX_SESSION_MESSAGE_BYTES} bytes of text.`);
    }

    const id = input.idempotencyKey ? keyedMessageId(input.idempotencyKey) : randomUUID();
    return mutate(input, (messages, target) => {
        const existing = messages.find((message) => message.id === id);
        if (
            !existing &&
            input.idempotencyKey &&
            readReceipts(address(input).file).some((receipt) => receipt.id === id)
        ) {
            throw new Error("This delivery key was already received or cancelled; no message was queued again.");
        }
        if (existing) {
            if (existing.text !== input.text) {
                throw new Error("This delivery key already belongs to different text; no message was replaced.");
            }
            return existing;
        }
        const now = new Date().toISOString();
        const message: SessionMessage = {
            id,
            target,
            text: input.text,
            state: "queued",
            createdAt: now,
            updatedAt: now,
        };
        messages.push(message);
        return message;
    });
}

function requireMessage(messages: SessionMessage[], id: string): SessionMessage {
    const message = messages.find((candidate) => candidate.id === id);
    if (!message) {
        throw new Error("Message not found for this exact provider, session and source home.");
    }
    return message;
}

function requireConsumer(consumer: string): string {
    const value = consumer.trim();
    if (!value || value.length > 256) {
        throw new Error("An explicit consumer identity is required.");
    }
    return value;
}

/** Offering reserves the payload for one consumer; it is not an acknowledgement of receipt. */
export async function offerSessionMessage(
    input: QueueAddress & { id: string; consumer: string }
): Promise<SessionMessage> {
    const consumer = requireConsumer(input.consumer);
    return mutate(input, (messages) => {
        const message = requireMessage(messages, input.id);
        if (message.state === "offered" && message.consumer === consumer) {
            return message;
        }
        if (message.state !== "queued") {
            throw new Error("This message is already offered, received or cancelled; it cannot be offered again.");
        }
        message.state = "offered";
        message.consumer = consumer;
        message.updatedAt = new Date().toISOString();
        return message;
    });
}

/** The consumer calls this only after receiving the offered payload. */
export async function acknowledgeSessionMessage(
    input: QueueAddress & { id: string; consumer: string }
): Promise<SessionMessage> {
    const consumer = requireConsumer(input.consumer);
    return mutate(input, (messages) => {
        const message = requireMessage(messages, input.id);
        if (message.consumer !== consumer || !["offered", "received"].includes(message.state)) {
            throw new Error("Only the consumer holding this offered message can acknowledge it.");
        }
        if (message.state === "offered") {
            message.state = "received";
            message.updatedAt = new Date().toISOString();
        }
        return message;
    });
}

export async function cancelSessionMessage(input: QueueAddress & { id: string }): Promise<SessionMessage> {
    return mutate(input, (messages) => {
        const message = requireMessage(messages, input.id);
        if (message.state === "cancelled") {
            return message;
        }
        if (message.state !== "queued") {
            throw new Error(
                "An offered message may already have reached its consumer; it cannot be silently cancelled or resent."
            );
        }
        message.state = "cancelled";
        message.updatedAt = new Date().toISOString();
        return message;
    });
}
