import { randomUUID } from "node:crypto";
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { waitForPath } from "@genesiscz/utils/fs/watcher";
import { SafeJSON } from "@genesiscz/utils/json";
import { parseJsonl } from "@genesiscz/utils/jsonl";
import { isProcessAlive } from "@genesiscz/utils/process-alive";
import { withFileLock } from "@genesiscz/utils/storage";
import { atomicWriteFileSync } from "@genesiscz/utils/storage/storage";
import { WorkerDeliveryRejectedError, workerSourceHome } from "@genesiscz/utils/worker/delivery";
import type { CodexControl } from "./control";
import { sessionControlPath, sessionResponsePath } from "./paths";
import { CodexSessionStore } from "./store";

export interface ControlRequest {
    id: string;
    generation: string;
    seq: number;
    ts: string;
    control: CodexControl;
}

/** `code: "rejected"` marks a refusal proven before the prompt reached the provider. */
export type ControlResponse = { ok: true; result?: unknown } | { ok: false; error: string; code?: "rejected" };

export interface ControlLogReadSample {
    bytes: number;
    records: number;
}

const MAX_CONTROL_RECORD_BYTES = 16 * 1024 * 1024;
const CONTROL_READ_CHUNK_BYTES = 64 * 1024;

function readRequests(path: string): ControlRequest[] {
    if (!existsSync(path)) {
        return [];
    }

    const text = readFileSync(path, "utf8");
    return text.trim() ? parseJsonl<ControlRequest>(text) : [];
}

export class ControlLogCursor {
    private afterSeq = 0;
    private offset = 0;
    private partial = Buffer.alloc(0);
    private identity: string | null = null;

    constructor(
        private readonly options: {
            name: string;
            generation: string;
            onRead?: (sample: ControlLogReadSample) => void;
        }
    ) {}

    async readAppendedRequests(): Promise<ControlRequest[]> {
        const path = sessionControlPath(this.options.name);
        if (!existsSync(path)) {
            this.offset = 0;
            this.partial = Buffer.alloc(0);
            this.identity = null;
            return [];
        }

        const stat = statSync(path);
        const identity = `${stat.dev}:${stat.ino}`;
        if (this.identity !== identity || stat.size < this.offset) {
            this.offset = 0;
            this.partial = Buffer.alloc(0);
            this.identity = identity;
        }
        if (stat.size === this.offset) {
            return [];
        }

        // Fixed-size reads, one record at a time: a long backlog (every earlier generation) never
        // becomes one allocation, and only this generation's new requests are retained.
        const chunk = Buffer.allocUnsafe(CONTROL_READ_CHUNK_BYTES);
        const appended: ControlRequest[] = [];
        let bytesRead = 0;
        let records = 0;
        const fd = openSync(path, "r");
        try {
            while (this.offset < stat.size) {
                const read = readSync(fd, chunk, 0, Math.min(chunk.length, stat.size - this.offset), this.offset);
                if (read === 0) {
                    break;
                }

                this.offset += read;
                bytesRead += read;
                const view = chunk.subarray(0, read);
                let start = 0;
                let newline = view.indexOf(0x0a, start);
                while (newline >= 0) {
                    const line = Buffer.concat([this.partial, view.subarray(start, newline)]);
                    this.partial = Buffer.alloc(0);
                    if (line.length > MAX_CONTROL_RECORD_BYTES) {
                        throw new Error(`Codex control record exceeds ${MAX_CONTROL_RECORD_BYTES} bytes`);
                    }

                    const text = line.toString("utf8").trim();
                    if (text) {
                        records += 1;
                        for (const request of parseJsonl<ControlRequest>(text)) {
                            if (request.seq > this.afterSeq && request.generation === this.options.generation) {
                                appended.push(request);
                                this.afterSeq = request.seq;
                            }
                        }
                    }

                    start = newline + 1;
                    newline = view.indexOf(0x0a, start);
                }

                this.partial = Buffer.concat([this.partial, view.subarray(start)]);
                if (this.partial.length > MAX_CONTROL_RECORD_BYTES) {
                    throw new Error(`Codex control record exceeds ${MAX_CONTROL_RECORD_BYTES} bytes`);
                }
            }
        } finally {
            closeSync(fd);
        }

        this.options.onRead?.({ bytes: bytesRead, records });
        return appended;
    }
}

export async function appendControlRequest(
    name: string,
    generation: string,
    control: CodexControl
): Promise<ControlRequest> {
    const path = sessionControlPath(name);
    mkdirSync(dirname(path), { recursive: true });

    return withFileLock(`${path}.lock`, async () => {
        const existing = readRequests(path);
        const request: ControlRequest = {
            id: randomUUID(),
            generation,
            seq: (existing.at(-1)?.seq ?? 0) + 1,
            ts: new Date().toISOString(),
            control,
        };
        appendFileSync(path, `${SafeJSON.stringify(request, { jsonl: true })}\n`);
        return request;
    });
}

export async function readControlRequests(
    name: string,
    afterSeq: number,
    generation?: string
): Promise<ControlRequest[]> {
    return readRequests(sessionControlPath(name)).filter(
        (request) => request.seq > afterSeq && (generation === undefined || request.generation === generation)
    );
}

export function respondToControl(name: string, requestId: string, response: ControlResponse): void {
    const path = sessionResponsePath(name, requestId);
    mkdirSync(dirname(path), { recursive: true });
    atomicWriteFileSync(path, SafeJSON.stringify(response, null, 2));
}

export async function waitForControlResponse(
    name: string,
    requestId: string,
    timeoutMs = 30_000
): Promise<ControlResponse> {
    const path = sessionResponsePath(name, requestId);
    mkdirSync(dirname(path), { recursive: true });
    // `respondToControl` creates this file with an atomic rename, which the parent directory sees
    // as one event. `waitForPath` watches that directory, so the answer arrives when it is written
    // rather than up to 20 ms later. It used to stat the path 50 times a second for as long as
    // 30 seconds. The 250 ms poll behind the watch is not decoration: on bun 1.3.13 a watcher
    // created after any earlier watcher was closed goes deaf, and this daemon closes one per request.
    const appeared = await waitForPath(path, { timeoutMs, pollMs: 250 });

    if (appeared) {
        return SafeJSON.parse(readFileSync(path, "utf8"), { strict: true }) as ControlResponse;
    }

    throw new Error(`Timed out waiting for Codex session "${name}" to answer control request ${requestId}`);
}

export async function sendControlRequest(
    name: string,
    control: CodexControl,
    timeoutMs = 30_000
): Promise<ControlResponse> {
    const meta = await new CodexSessionStore().readMeta(name);
    if (!meta) {
        throw new Error(`Codex session not found: ${name}`);
    }

    if (meta.status === "closed" || meta.status === "failed") {
        throw new Error(`Codex session "${name}" is ${meta.status}`);
    }

    if (!isProcessAlive(meta.daemonPid)) {
        throw new Error(`Codex session "${name}" daemon is not running (pid ${meta.daemonPid})`);
    }

    if (
        control.op === "steer" &&
        control.expectedTarget &&
        (meta.threadId !== control.expectedTarget.threadId ||
            !meta.home ||
            workerSourceHome(meta.home) !== workerSourceHome(control.expectedTarget.home))
    ) {
        throw new WorkerDeliveryRejectedError("The Codex thread or source home changed; no prompt was sent.");
    }

    const generation = meta.generation ?? meta.startedAt;
    const request = await appendControlRequest(name, generation, control);
    return waitForControlResponse(name, request.id, timeoutMs);
}
