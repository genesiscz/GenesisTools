import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { RequestJournal } from "@genesiscz/utils/genesis-tools/areas/person/journal";
import type { PersonRequest, RequestOutcome } from "@genesiscz/utils/genesis-tools/areas/person/request";
import type { ServiceClientMethod } from "@genesiscz/utils/genesis-tools/capability/needs";
import { readLiveServiceEntry } from "@genesiscz/utils/rpc/service-entry";
import { launchService } from "@genesiscz/utils/rpc/service-host";
import { RpcSocketClient, type RpcSocketClientOptions } from "@genesiscz/utils/rpc/socket-client";
import { toolDataDir } from "@genesiscz/utils/storage/root";
import { isTestProcess } from "@genesiscz/utils/test-process";
import { LIVE_FACTS } from "../capability/facts";

export interface ServiceDoor {
    journal: RequestJournal;
    hasClient(method: ServiceClientMethod): boolean;
    present(request: PersonRequest, timeoutMs: number): Promise<RequestOutcome>;
}

/** The time beyond an action's own budget that a service call gets, so the action's expiry outcome comes back. */
export const SERVICE_CALL_GRACE_MS = 10_000;

/** The service answers `hello` at once; a longer wait means it is wedged. */
const HELLO_TIMEOUT_MS = 5_000;

export function genesisToolsServiceDir(): string {
    return toolDataDir("genesis-tools");
}

/**
 * The checkout this code runs from (src/utils/genesis-tools/service/ is four levels below it), as a decoded path. The
 * service exits once a module it loaded from here changed, so the next caller starts the new actions and schemas.
 */
export function genesisToolsSourceRoot(): string {
    return fileURLToPath(new URL("../../../../", import.meta.url));
}

/** An explicit isolated directory is required for transport tests; the user's service is never contacted. */
export async function connectGenesisToolsService(
    options: { dir?: string; onRequest?: RpcSocketClientOptions["onRequest"] } = {}
): Promise<RpcSocketClient | null> {
    if (isTestProcess() && (!options.dir || options.dir === genesisToolsServiceDir())) {
        return null;
    }

    const entry = readLiveServiceEntry(options.dir ?? genesisToolsServiceDir());
    if (!entry) {
        return null;
    }

    const client = await RpcSocketClient.connect({
        socket: entry.socket,
        label: "GenesisTools service",
        logScope: "genesis-tools-service",
        defaultTimeoutMs: 130_000,
        onRequest: options.onRequest,
    });
    try {
        await client.call(
            "hello",
            { methods: [], caller: isTestProcess() ? "person" : LIVE_FACTS.isAgent() ? "agent" : "person" },
            { timeoutMs: HELLO_TIMEOUT_MS }
        );
        return client;
    } catch (error) {
        // The caller gets no client to close, so a failed handshake closes its own socket.
        client.close();
        throw error;
    }
}

/** The service's deadline for one action call: the action's budget, plus the time to send its expiry outcome back. */
export function serviceActionDeadlineMs(actionBudgetMs: number | undefined): number {
    return (actionBudgetMs ?? 120_000) + SERVICE_CALL_GRACE_MS;
}

/** How long a client waits for one action call: past the service's deadline, so the service always answers first. */
export function serviceActionClientTimeoutMs(actionBudgetMs: number | undefined): number {
    return serviceActionDeadlineMs(actionBudgetMs) + SERVICE_CALL_GRACE_MS;
}

export async function callRunningService(
    method: string,
    params: unknown,
    timeoutMs = 130_000
): Promise<{ called: false } | { called: true; value: unknown }> {
    const client = await connectGenesisToolsService();
    if (!client) {
        return { called: false };
    }

    try {
        return { called: true, value: await client.call(method, params, { timeoutMs }) };
    } finally {
        client.close();
    }
}

export async function ensureGenesisToolsService(): Promise<RpcSocketClient> {
    if (isTestProcess()) {
        throw new Error("in-test: a test process never starts the GenesisTools service");
    }

    const dir = genesisToolsServiceDir();
    const launched = await launchService({
        dir,
        gates: join(dir, "start-gates"),
        command: ["genesis-tools", "serve"],
        label: "GenesisTools service",
        logScope: "genesis-tools-service",
    });
    if (launched.status === "failed") {
        throw new Error(launched.reason);
    }

    const client = await connectGenesisToolsService();
    if (!client) {
        throw new Error("GenesisTools service exited during connection");
    }

    return client;
}
