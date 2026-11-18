import { join } from "node:path";
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

export function genesisToolsServiceDir(): string {
    return toolDataDir("genesis-tools");
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
    await client.call("hello", {
        methods: [],
        caller: isTestProcess() ? "person" : LIVE_FACTS.isAgent() ? "agent" : "person",
    });
    return client;
}

/** The service's deadline for one action call: the action's budget plus 10 s, never under 130 s. */
export function serviceActionDeadlineMs(actionTimeoutMs: number | undefined): number {
    return Math.max(130_000, (actionTimeoutMs ?? 120_000) + 10_000);
}

/** How long a client waits for one action call: 10 s past the service's deadline, so the service always answers first. */
export function serviceActionClientTimeoutMs(actionTimeoutMs: number | undefined): number {
    return serviceActionDeadlineMs(actionTimeoutMs) + 10_000;
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
