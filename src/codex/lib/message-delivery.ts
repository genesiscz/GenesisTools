import { isAbsolute } from "node:path";
import {
    enqueueSessionMessage,
    findKeyedSessionMessage,
    type SessionMessage,
    type SessionMessageTarget,
} from "@genesiscz/utils/agent-sessions/message-queue";
import { WorkerDeliveryRejectedError, workerSourceHome } from "@genesiscz/utils/worker/delivery";
import type { WorkerVerbOutcome } from "@genesiscz/utils/worker/driver";
import { codexDriver } from "./driver";
import { isCodexDaemonPid } from "./spawn";
import { type CodexSessionMeta, CodexSessionStore } from "./store";

export interface CodexMessageDeps {
    store?: Pick<CodexSessionStore, "listNames" | "readMeta">;
    isLive?: (meta: CodexSessionMeta) => boolean;
    steer?: typeof codexDriver.steer;
    enqueue?: typeof enqueueSessionMessage;
}

export interface CodexMessageReceipt {
    target: SessionMessageTarget;
    channel: "session-queue" | "codex";
    delivered: boolean;
    queued: boolean;
    accepted: boolean;
    message?: SessionMessage;
    daemon?: string;
    result?: unknown;
}

export class CodexMessageUnknownError extends Error {
    constructor(options: { cause?: unknown } = {}) {
        super(
            "Codex delivery was attempted without a valid receipt. Inspect the conversation before retrying.",
            options
        );
        this.name = "CodexMessageUnknownError";
    }
}

export function codexMessageTarget({
    sessionId,
    sourceHome,
}: {
    sessionId: string;
    sourceHome: string;
}): SessionMessageTarget {
    if (
        typeof sessionId !== "string" ||
        typeof sourceHome !== "string" ||
        !sessionId.trim() ||
        !sourceHome.trim() ||
        !isAbsolute(sourceHome)
    ) {
        throw new Error("An exact Codex session and absolute source home are required.");
    }

    return { provider: "codex", sessionId: sessionId.trim(), sourceHome: workerSourceHome(sourceHome) };
}

export async function queueCodexMessage({
    target,
    text,
    idempotencyKey,
    root,
    deps = {},
}: {
    target: SessionMessageTarget;
    text: string;
    idempotencyKey?: string;
    root?: string;
    deps?: CodexMessageDeps;
}): Promise<CodexMessageReceipt> {
    if (target.provider !== "codex") {
        throw new Error("The Codex queue requires a Codex target.");
    }

    const address = codexMessageTarget(target);
    const message = await (deps.enqueue ?? enqueueSessionMessage)({
        target: address,
        text,
        idempotencyKey,
        root,
    });
    return {
        target: message.target,
        channel: "session-queue",
        delivered: message.state === "received",
        queued: message.state === "queued",
        accepted: message.state !== "cancelled",
        message,
    };
}

export async function steerCodexMessage({
    target,
    text,
    force = false,
    idempotencyKey,
    root,
    deps = {},
}: {
    target: SessionMessageTarget;
    text: string;
    force?: boolean;
    idempotencyKey?: string;
    root?: string;
    deps?: CodexMessageDeps;
}): Promise<CodexMessageReceipt> {
    if (target.provider !== "codex" || !text.trim()) {
        throw new Error("An exact Codex target and nonempty prompt are required.");
    }

    const address = codexMessageTarget(target);
    const store = deps.store ?? new CodexSessionStore();
    const isLive = deps.isLive ?? ((meta) => isCodexDaemonPid(meta.daemonPid, meta.name));
    const candidates = store.listNames().flatMap((name) => {
        const meta = store.readMeta(name);
        return meta?.threadId === address.sessionId &&
            meta.home &&
            workerSourceHome(meta.home) === address.sourceHome &&
            ["ready", "running"].includes(meta.status) &&
            isLive(meta)
            ? [meta]
            : [];
    });
    if (candidates.length > 1) {
        throw new Error("Multiple live Codex daemons claim this exact session and home; none was selected.");
    }

    const meta = candidates[0];
    if (!meta) {
        if (force) {
            throw new Error("--force requires a live owned Codex daemon; no new owner was started.");
        }

        return queueCodexMessage({ target: address, text, idempotencyKey, root, deps });
    }

    // A repeat of a key that was already queued is the same delivery; steering it too would deliver it twice.
    if (idempotencyKey && findKeyedSessionMessage({ target: address, root, idempotencyKey })) {
        return queueCodexMessage({ target: address, text, idempotencyKey, root, deps });
    }

    let outcome: WorkerVerbOutcome;
    try {
        outcome = await (deps.steer ?? codexDriver.steer)(meta, {
            prompt: text,
            extras: { force, expectSession: address.sessionId, expectHome: address.sourceHome },
        });
    } catch (cause) {
        if (cause instanceof WorkerDeliveryRejectedError) {
            throw cause;
        }

        throw new CodexMessageUnknownError({ cause });
    }

    const result = outcome.kind === "ack" ? outcome.result : undefined;
    if (
        typeof result !== "object" ||
        result === null ||
        !("queued" in result) ||
        typeof result.queued !== "boolean" ||
        (!result.queued && (!("turnId" in result) || typeof result.turnId !== "string" || !result.turnId))
    ) {
        throw new CodexMessageUnknownError();
    }

    return {
        target: address,
        channel: "codex",
        delivered: false,
        queued: result.queued,
        accepted: true,
        daemon: meta.name,
        result,
    };
}
