import { Buffer } from "node:buffer";
import { withTimeout } from "@genesiscz/utils/async";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";

export function encodeStdioMessage(json: string): Buffer {
    return Buffer.from(`${compactJsonRpc(json)}\n`, "utf8");
}

export function parseStdioMessages(buffer: Buffer): { messages: string[]; rest: Buffer } {
    const messages: string[] = [];
    let offset = 0;

    while (true) {
        const nl = buffer.indexOf(0x0a, offset);

        if (nl < 0) {
            break;
        }

        let line = buffer.subarray(offset, nl);

        if (line.length > 0 && line[line.length - 1] === 0x0d) {
            line = line.subarray(0, line.length - 1);
        }

        const text = line.toString("utf8").trim();

        if (text.length > 0) {
            messages.push(text);
        }

        offset = nl + 1;
    }

    return { messages, rest: Buffer.from(buffer.subarray(offset)) };
}

export function compactJsonRpc(text: string): string {
    try {
        return SafeJSON.stringify(SafeJSON.parse(text, { strict: true }), { strict: true });
    } catch {
        return text.trim();
    }
}

const DEFAULT_MAX_RESPONSE_BYTES = 16 * 1024 * 1024;

function responseTooLarge(maxBytes: number): RelayRequestError {
    return new RelayRequestError(`gateway response exceeds ${maxBytes} bytes`, undefined);
}

/** Read a whole response body, cancelling it once it passes `maxBytes`. */
async function readBoundedText(response: Response, maxBytes: number): Promise<string> {
    if (!response.body) {
        return "";
    }

    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    while (true) {
        const { done, value } = await reader.read();
        if (done) {
            break;
        }

        total += value.byteLength;
        if (total > maxBytes) {
            await reader.cancel();
            throw responseTooLarge(maxBytes);
        }

        chunks.push(value);
    }

    return Buffer.concat(chunks, total).toString("utf8");
}

/**
 * Every upstream body is bounded: a plain response as a whole, an SSE stream per line and per event,
 * so an upstream that never sends a newline or an event separator cannot grow the relay's memory.
 */
export async function* jsonRpcBodiesFromHttpStream(
    response: Response,
    maxBytes = DEFAULT_MAX_RESPONSE_BYTES
): AsyncGenerator<string> {
    const type = response.headers.get("content-type") ?? "";

    if (!type.includes("text/event-stream")) {
        const trimmed = (await readBoundedText(response, maxBytes)).trim();

        if (trimmed.length > 0) {
            yield compactJsonRpc(trimmed);
        }

        return;
    }

    if (!response.body) {
        return;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let pending = "";
    let data: string[] = [];
    let dataLength = 0;

    const finishEvent = (): string | null => {
        if (data.length === 0) {
            return null;
        }

        const body = compactJsonRpc(data.join("\n"));
        data = [];
        dataLength = 0;
        return body.length > 0 ? body : null;
    };

    const pushData = async (value: string): Promise<void> => {
        dataLength += value.length + 1;
        if (dataLength > maxBytes) {
            await reader.cancel();
            throw responseTooLarge(maxBytes);
        }

        data.push(value);
    };

    while (true) {
        const { done, value } = await reader.read();
        pending += decoder.decode(value, { stream: !done });
        if (pending.length > maxBytes && pending.indexOf("\n") < 0) {
            await reader.cancel();
            throw responseTooLarge(maxBytes);
        }

        let newline = pending.indexOf("\n");
        while (newline >= 0) {
            const rawLine = pending.slice(0, newline);
            pending = pending.slice(newline + 1);
            const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;

            if (line.length === 0) {
                const body = finishEvent();
                if (body) {
                    yield body;
                }
            } else if (line.startsWith("data:")) {
                const value = line.slice(5);
                await pushData(value.startsWith(" ") ? value.slice(1) : value);
            }

            newline = pending.indexOf("\n");
        }

        if (done) {
            if (pending.startsWith("data:")) {
                const value = pending.slice(5);
                await pushData(value.startsWith(" ") ? value.slice(1) : value);
            }

            const body = finishEvent();
            if (body) {
                yield body;
            }

            return;
        }
    }
}

export async function jsonRpcBodiesFromHttp(response: Response): Promise<string[]> {
    const bodies: string[] = [];
    for await (const body of jsonRpcBodiesFromHttpStream(response)) {
        bodies.push(body);
    }

    return bodies;
}

interface RequestMeta {
    hasId: boolean;
    id?: unknown;
    cancellationId?: unknown;
}

interface QueuedMessage {
    message: string;
    meta: RequestMeta;
    /** The serialized JSON-RPC id of a queued request, so a cancellation can find it. */
    key: string | null;
}

function requestMeta(message: string): RequestMeta {
    try {
        const parsed = SafeJSON.parse(message, { strict: true });

        if (parsed && typeof parsed === "object") {
            const record = parsed as Record<string, unknown>;
            const params = record.params;
            const cancellationId =
                record.method === "notifications/cancelled" && params && typeof params === "object"
                    ? (params as Record<string, unknown>).requestId
                    : undefined;

            return { hasId: "id" in record, id: record.id, cancellationId };
        }
    } catch (error) {
        logger.debug({ error }, "stdio relay could not read jsonrpc id");
    }

    return { hasId: false };
}

function jsonRpcErrorLine(id: unknown, message: string): string {
    return SafeJSON.stringify({ jsonrpc: "2.0", id, error: { code: -32000, message } }, { strict: true });
}

function looksLikeJsonRpc(text: string): boolean {
    try {
        const parsed = SafeJSON.parse(text, { strict: true });

        return Boolean(parsed && typeof parsed === "object" && "jsonrpc" in parsed);
    } catch {
        return false;
    }
}

class RelayRequestError extends Error {
    constructor(message: string, cause: unknown) {
        super(message, { cause });
        this.name = "RelayRequestError";
    }
}

export async function runStdioHttpRelay(opts: {
    url: string;
    headers: Record<string, string>;
    stdin: AsyncIterable<Uint8Array>;
    stdout: { write(chunk: Uint8Array): unknown };
    fetchImpl?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
    requestTimeoutMs?: number;
    shutdownTimeoutMs?: number;
    maxInFlight?: number;
    /** Requests and notifications each wait in their own queue of at most this many messages. */
    maxQueued?: number;
    maxMessageBytes?: number;
}): Promise<void> {
    const fetchImpl = opts.fetchImpl ?? fetch;
    const requestTimeoutMs = opts.requestTimeoutMs ?? 300_000;
    const shutdownTimeoutMs = opts.shutdownTimeoutMs ?? 1000;
    const maxInFlight = opts.maxInFlight ?? 32;
    const maxQueued = opts.maxQueued ?? 256;
    const maxMessageBytes = opts.maxMessageBytes ?? 16 * 1024 * 1024;
    if (maxInFlight < 1) {
        throw new Error(`stdio relay maxInFlight must be at least 1, got ${maxInFlight}`);
    }
    if (maxQueued < 0) {
        throw new Error(`stdio relay maxQueued must not be negative, got ${maxQueued}`);
    }
    if (maxMessageBytes < 1) {
        throw new Error(`stdio relay maxMessageBytes must be at least 1, got ${maxMessageBytes}`);
    }
    let pendingSegments: Buffer[] = [];
    let pendingBytes = 0;
    let sessionId: string | undefined;
    let handshakeDone = false;
    const inFlight = new Set<Promise<boolean>>();
    const controllers = new Map<string, AbortController>();
    const allControllers = new Set<AbortController>();
    const queuedRequests: QueuedMessage[] = [];
    const queuedNotifications: QueuedMessage[] = [];
    let activeRequests = 0;
    let activeNotifications = 0;
    let shuttingDown = false;
    let stdoutQueue = Promise.resolve();

    async function writeOutput(chunk: Uint8Array): Promise<void> {
        const write = stdoutQueue
            .catch(() => {})
            .then(async () => {
                await opts.stdout.write(chunk);
            });
        stdoutQueue = write;
        await write;
    }

    function pushChunk(chunk: Uint8Array): string[] {
        const messages: string[] = [];
        const buffer = Buffer.from(chunk);
        let offset = 0;

        while (offset < buffer.length) {
            const newline = buffer.indexOf(0x0a, offset);
            if (newline < 0) {
                const tail = Buffer.from(buffer.subarray(offset));
                pendingSegments.push(tail);
                pendingBytes += tail.length;

                if (pendingBytes > maxMessageBytes) {
                    throw new Error(`stdio relay message exceeds ${maxMessageBytes} bytes`);
                }

                break;
            }

            const tail = buffer.subarray(offset, newline);
            const lineBytes = pendingBytes + tail.length;
            if (lineBytes > maxMessageBytes) {
                throw new Error(`stdio relay message exceeds ${maxMessageBytes} bytes`);
            }
            const line = Buffer.concat([...pendingSegments, tail], lineBytes);
            pendingSegments = [];
            pendingBytes = 0;
            const withoutCr = line.length > 0 && line[line.length - 1] === 0x0d ? line.subarray(0, -1) : line;
            const text = withoutCr.toString("utf8").trim();
            if (text.length > 0) {
                messages.push(text);
            }

            offset = newline + 1;
        }

        return messages;
    }

    async function dispatch(message: string, meta: RequestMeta): Promise<void> {
        const controller = new AbortController();
        allControllers.add(controller);
        const controllerKey = meta.hasId ? SafeJSON.stringify(meta.id, { strict: true }) : null;
        if (controllerKey) {
            controllers.set(controllerKey, controller);
        }
        const timer = setTimeout(() => controller.abort("timeout"), requestTimeoutMs);

        // The gateway header used to be set explicitly here and then overwritten by the
        // spread on the next line, so the explicit entry was either identical or the
        // empty string nobody wants. The spread is the only source.
        const headers: Record<string, string> = {
            Accept: "application/json, text/event-stream",
            "Content-Type": "application/json",
            ...opts.headers,
        };

        if (sessionId) {
            headers["mcp-session-id"] = sessionId;
        }

        try {
            const response = await fetchImpl(opts.url, {
                method: "POST",
                headers,
                body: message,
                signal: controller.signal,
            });
            const returnedSession = response.headers.get("mcp-session-id");

            if (returnedSession) {
                sessionId = returnedSession;
            }

            if (response.status === 404) {
                sessionId = undefined;
            }

            if (response.status === 202 || response.status === 204) {
                await response.body?.cancel();

                return;
            }

            if (!response.ok) {
                const status = response.status;
                const text = await readBoundedText(response, maxMessageBytes);
                logger.warn({ status, url: opts.url }, "stdio relay upstream HTTP error");

                if (looksLikeJsonRpc(text)) {
                    await writeOutput(encodeStdioMessage(text));

                    return;
                }

                if (meta.hasId) {
                    await writeOutput(encodeStdioMessage(jsonRpcErrorLine(meta.id, `gateway HTTP ${status}`)));
                }

                return;
            }

            for await (const body of jsonRpcBodiesFromHttpStream(response, maxMessageBytes)) {
                await writeOutput(encodeStdioMessage(body));
            }
        } catch (error) {
            if (controller.signal.aborted) {
                const reason = controller.signal.reason;
                const message =
                    reason === "cancelled"
                        ? "gateway request cancelled"
                        : reason === "shutdown"
                          ? "gateway shutting down"
                          : "gateway request timed out";
                throw new RelayRequestError(message, error);
            }

            throw error;
        } finally {
            clearTimeout(timer);
            allControllers.delete(controller);
            if (controllerKey && controllers.get(controllerKey) === controller) {
                controllers.delete(controllerKey);
            }
        }
    }

    function drainQueuedRequests(): void {
        while (!shuttingDown && activeRequests < maxInFlight) {
            const queued = queuedRequests.shift();
            if (!queued) {
                break;
            }

            void track(queued.message, queued.meta);
        }

        while (!shuttingDown && activeNotifications < maxInFlight) {
            const queued = queuedNotifications.shift();
            if (!queued) {
                break;
            }

            void track(queued.message, queued.meta);
        }
    }

    function track(message: string, meta: RequestMeta = requestMeta(message)): Promise<boolean> {
        if (meta.hasId) {
            activeRequests += 1;
        } else {
            activeNotifications += 1;
        }
        const task = dispatch(message, meta).then(
            () => true,
            async (error: unknown) => {
                if (meta.hasId) {
                    const failure = error instanceof RelayRequestError ? error.message : "gateway transport failed";
                    await writeOutput(encodeStdioMessage(jsonRpcErrorLine(meta.id, failure)));
                }
                logger.warn({ error, url: opts.url }, "stdio relay request failed");
                return false;
            }
        );
        inFlight.add(task);
        void task.finally(() => {
            inFlight.delete(task);
            if (meta.hasId) {
                activeRequests -= 1;
            } else {
                activeNotifications -= 1;
            }
            drainQueuedRequests();
        });

        return task;
    }

    // A cancellation acts locally the moment it is read, before its own notification waits
    // for a slot: a dispatched request is aborted, a queued one never runs.
    function applyCancellation(cancellationId: unknown): void {
        const key = SafeJSON.stringify(cancellationId, { strict: true });
        controllers.get(key)?.abort("cancelled");
        const index = queuedRequests.findIndex((queued) => queued.key === key);
        if (index !== -1) {
            const [cancelled] = queuedRequests.splice(index, 1);
            void writeOutput(encodeStdioMessage(jsonRpcErrorLine(cancelled?.meta.id, "gateway request cancelled")));
        }
    }

    function schedule(message: string): void {
        const meta = requestMeta(message);
        if (meta.cancellationId !== undefined) {
            applyCancellation(meta.cancellationId);
        }

        if (meta.hasId) {
            if (activeRequests < maxInFlight) {
                void track(message, meta);
                return;
            }

            if (queuedRequests.length >= maxQueued) {
                logger.warn({ url: opts.url, maxQueued }, "stdio relay request backlog full, rejecting request");
                void writeOutput(encodeStdioMessage(jsonRpcErrorLine(meta.id, "gateway relay backlog full")));
                return;
            }

            queuedRequests.push({ message, meta, key: SafeJSON.stringify(meta.id, { strict: true }) });
            return;
        }

        if (activeNotifications < maxInFlight) {
            void track(message, meta);
            return;
        }

        if (queuedNotifications.length >= maxQueued) {
            logger.warn({ url: opts.url, maxQueued }, "stdio relay notification backlog full, dropping notification");
            return;
        }

        queuedNotifications.push({ message, meta, key: null });
    }

    function hasPendingWork(): boolean {
        return queuedRequests.length > 0 || queuedNotifications.length > 0 || inFlight.size > 0;
    }

    async function drainAll(): Promise<void> {
        drainQueuedRequests();
        while (hasPendingWork()) {
            if (inFlight.size === 0) {
                drainQueuedRequests();
                continue;
            }

            await Promise.race(inFlight);
            drainQueuedRequests();
        }
    }

    async function abortOutstanding(error: unknown, reason: string): Promise<void> {
        shuttingDown = true;
        queuedNotifications.splice(0);
        const queued = queuedRequests.splice(0);
        const remaining = [...inFlight];
        // Abort first: the error lines below go through stdout, which may itself be blocked, so
        // they share the one bounded wait with the aborted requests instead of gating the abort.
        for (const controller of allControllers) {
            controller.abort("shutdown");
        }
        logger.warn({ error, url: opts.url }, reason);
        const notices = queued.map((entry) =>
            writeOutput(encodeStdioMessage(jsonRpcErrorLine(entry.meta.id, "gateway shutting down")))
        );
        try {
            await withTimeout(
                Promise.all([...remaining, ...notices]),
                Math.min(shutdownTimeoutMs, 250),
                new Error("stdio relay abort drain timed out")
            );
        } catch (abortError) {
            logger.warn({ error: abortError, url: opts.url }, "stdio relay requests ignored abort");
        }
    }

    try {
        for await (const chunk of opts.stdin) {
            for (const message of pushChunk(chunk)) {
                // Only the handshake is serialized, because the session id comes back on its
                // response and every later request has to carry it. After that, awaiting each
                // call in the read loop made a slow tool call block everything queued behind
                // it — including the notifications/cancelled that was meant to stop it.
                if (!handshakeDone) {
                    handshakeDone = await track(message);
                    continue;
                }

                schedule(message);
            }
        }
    } catch (error) {
        // An oversized line or a failing stdin ends the relay; nothing it started may keep running.
        await abortOutstanding(error, "stdio relay input failed, aborted outstanding requests");
        throw error;
    }

    if (hasPendingWork()) {
        try {
            await withTimeout(drainAll(), shutdownTimeoutMs, new Error("stdio relay shutdown drain timed out"));
        } catch (error) {
            await abortOutstanding(error, "stdio relay aborted requests after shutdown deadline");
        }
    }
}
