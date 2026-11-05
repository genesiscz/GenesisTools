import { logger } from "@genesiscz/utils/logger";
import { RpcSocketClient } from "@genesiscz/utils/rpc/socket-client";
import { HeadlessHost, type HostCallContext, hostAnswer, type RecorderHost } from "./host";
import type { EditorPlace, ExportAnswer, SheetAnswer, StillAnswer, StillRequest } from "./library";
import {
    HOST_TIMEOUT_MS,
    type HostMethod,
    type HostParams,
    type HostResult,
    readLiveService,
    SERVICE_PROTOCOL,
    type ServiceEntry,
} from "./service-protocol";

const { log } = logger.scoped("recorder-service-client");

/** Connects to the service as a client (`hello`), runs `work`, and closes. */
export async function withServiceClient<T>(
    entry: ServiceEntry,
    work: (client: RpcSocketClient) => Promise<T>
): Promise<T> {
    const client = await RpcSocketClient.connect({
        socket: entry.socket,
        logScope: "recorder-service-client",
        label: "recorder service",
    });

    try {
        await client.call("hello", { role: "client", protocol: SERVICE_PROTOCOL, pid: process.pid });
        return await work(client);
    } finally {
        client.close();
    }
}

/** The host methods through the running service: it forwards them to the connected app, or runs the headless face. */
export class ServiceHost implements RecorderHost {
    readonly kind = "service";

    constructor(private readonly entry: ServiceEntry) {}

    answers(): boolean {
        return true;
    }

    call<M extends HostMethod>(
        method: M,
        params: HostParams<M>,
        context: HostCallContext = {}
    ): Promise<HostResult<M>> {
        return withServiceClient(this.entry, async (client) =>
            hostAnswer(
                method,
                await client.call(method, params, {
                    timeoutMs: HOST_TIMEOUT_MS[method],
                    ...(context.signal ? { signal: context.signal } : {}),
                    ...(context.onProgress ? { onProgress: context.onProgress } : {}),
                })
            )
        );
    }
}

let resolver: (() => RecorderHost) | undefined;

/** The recorder service answers its own process's host calls in process; it sets this while it runs. */
export function setRecorderHostResolver(next: (() => RecorderHost) | undefined): void {
    resolver = next;
}

/** Where this process's host calls go: the service it runs, the service another process runs, or the headless face. */
export function recorderHost(options: { dir?: string } = {}): RecorderHost {
    if (resolver) {
        return resolver();
    }

    const entry = readLiveService(options.dir);
    return entry ? new ServiceHost(entry) : new HeadlessHost();
}

function message(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

/** The editor window on an edit, through the host. */
export async function hostOpenEditor(path: string, place: EditorPlace = {}): Promise<HostResult<"window.open">> {
    return recorderHost().call("window.open", {
        path,
        ...(place.focus !== undefined ? { focus: place.focus } : {}),
        ...(place.atSeconds !== undefined ? { atSeconds: place.atSeconds } : {}),
        ...(place.tab ? { tab: place.tab } : {}),
    });
}

/**
 * Closes the editor window of an edit (`path`) or of a window number, through the host. A window with a drag not saved
 * yet or an export running refuses (`RPC_ERRORS.windowBusy`); `closed: false` when no window shows it.
 */
export async function hostCloseEditor(target: { path?: string; window?: number }): Promise<HostResult<"window.close">> {
    return recorderHost().call("window.close", {
        ...(target.path !== undefined ? { path: target.path } : {}),
        ...(target.window !== undefined ? { window: target.window } : {}),
    });
}

/** One frame of the edit, through the host; the answer has the headless face's shape (`ok`, or `error`). */
export async function hostStill(request: StillRequest): Promise<StillAnswer> {
    try {
        return await recorderHost().call("render.still", request);
    } catch (error) {
        log.debug({ error, request }, "the still was refused");
        return { ok: false, error: message(error) };
    }
}

export async function hostSheet(request: { path: string; times: number[]; out?: string }): Promise<SheetAnswer> {
    try {
        return await recorderHost().call("render.sheet", request);
    } catch (error) {
        log.debug({ error, request }, "the sheet was refused");
        return { ok: false, error: message(error) };
    }
}

export async function hostExport(path: string, out?: string): Promise<ExportAnswer> {
    try {
        return await recorderHost().call("render.export", { path, ...(out ? { out } : {}) });
    } catch (error) {
        log.debug({ error, path, out }, "the export was refused");
        return { ok: false, error: message(error) };
    }
}
