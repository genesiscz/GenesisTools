import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { isProcessAlive } from "@app/task/lib/process-alive";
import { SafeJSON } from "@genesiscz/utils/json";
import { parseJsonl } from "@genesiscz/utils/jsonl";
import { withFileLock } from "@genesiscz/utils/storage";
import { atomicWriteFileSync } from "@genesiscz/utils/storage/storage";
import type { CodexControl } from "./control";
import { sessionControlPath, sessionResponsePath } from "./paths";
import { CodexSessionStore } from "./store";

export interface ControlRequest {
    id: string;
    seq: number;
    ts: string;
    control: CodexControl;
}

export type ControlResponse = { ok: true; result?: unknown } | { ok: false; error: string };

function readRequests(path: string): ControlRequest[] {
    if (!existsSync(path)) {
        return [];
    }

    const text = readFileSync(path, "utf8");
    return text.trim() ? parseJsonl<ControlRequest>(text) : [];
}

export async function appendControlRequest(name: string, control: CodexControl): Promise<ControlRequest> {
    const path = sessionControlPath(name);
    mkdirSync(dirname(path), { recursive: true });

    return withFileLock(`${path}.lock`, async () => {
        const existing = readRequests(path);
        const request: ControlRequest = {
            id: randomUUID(),
            seq: (existing.at(-1)?.seq ?? 0) + 1,
            ts: new Date().toISOString(),
            control,
        };
        appendFileSync(path, `${SafeJSON.stringify(request, { jsonl: true })}\n`);
        return request;
    });
}

export async function readControlRequests(name: string, afterSeq: number): Promise<ControlRequest[]> {
    return readRequests(sessionControlPath(name)).filter((request) => request.seq > afterSeq);
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
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
        if (existsSync(path)) {
            return SafeJSON.parse(readFileSync(path, "utf8"), { strict: true }) as ControlResponse;
        }

        await Bun.sleep(20);
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

    const request = await appendControlRequest(name, control);
    return waitForControlResponse(name, request.id, timeoutMs);
}
