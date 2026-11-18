import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { type MethodDescriptor, type RpcHandler, type RpcHandlers, toRpcTable } from "@genesiscz/utils/api-descriptor";
import { createConfigStore } from "@genesiscz/utils/genesis-tools/actions/config";
import { type EngineDeps, liveEngineDeps } from "@genesiscz/utils/genesis-tools/actions/registry";
import { explainAction, runAreaAction } from "@genesiscz/utils/genesis-tools/actions/run";
import { createStateStore } from "@genesiscz/utils/genesis-tools/actions/state";
import { AREAS } from "@genesiscz/utils/genesis-tools/areas";
import { createRequestJournal } from "@genesiscz/utils/genesis-tools/areas/person/journal";
import { requestOutcomeSchema } from "@genesiscz/utils/genesis-tools/areas/person/request";
import { logger } from "@genesiscz/utils/logger";
import { RpcError } from "@genesiscz/utils/rpc/errors";
import { type ServiceHost, startServiceHost } from "@genesiscz/utils/rpc/service-host";
import type { RpcCall, RpcConnection } from "@genesiscz/utils/rpc/socket-server";
import { genesisToolsDir } from "@genesiscz/utils/storage/root";
import { isTestProcess } from "@genesiscz/utils/test-process";
import { personConfigSchema } from "../areas/person/deliveries";
import { genesisToolsApi, type serviceMethods } from "./api";
import { genesisToolsServiceDir, type ServiceDoor, serviceActionDeadlineMs } from "./clients";

interface FaceState {
    methods: string[];
    caller: "person" | "agent" | "face";
}

async function boundedCall(work: Promise<unknown>, method: string, timeoutMs: number): Promise<unknown> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
            const message = `GenesisTools service request failed: ${method} exceeded its ${timeoutMs} ms deadline`;
            logger.error({ method }, message);
            try {
                const dir = genesisToolsDir("logs");
                mkdirSync(dir, { recursive: true });
                const time = new Date().toLocaleTimeString("en-GB", { timeZone: "Europe/Prague", hour12: false });
                appendFileSync(join(dir, "app-perf.log"), `[${time}] [genesis-tools] ${message}\n`);
            } catch (error) {
                logger.warn({ error, method }, "Service deadline could not be written to the app monitor");
            }
            reject(new RpcError(1001, message));
        }, timeoutMs);
    });
    try {
        return await Promise.race([work, expired]);
    } finally {
        clearTimeout(timer);
    }
}
export async function startGenesisToolsService(
    options: { dir?: string; deps?: Partial<EngineDeps>; idleMs?: number; checkEveryMs?: number } = {}
): Promise<{ status: "running" } | { status: "started"; host: ServiceHost<FaceState>; deps: EngineDeps }> {
    if (isTestProcess() && (!options.dir || options.dir === genesisToolsServiceDir())) {
        throw new Error("in-test: the user's service cannot start in a test");
    }
    const dir = options.dir ?? genesisToolsServiceDir();
    const checkEveryMs = Math.max(100, options.checkEveryMs ?? 60_000);
    let host: ServiceHost<FaceState> | undefined;
    let offJournal: (() => void) | undefined;
    const journal = createRequestJournal({ dir: join(dir, "requests") });
    const config = createConfigStore({ registry: AREAS, file: join(dir, "config.json") });
    const state = createStateStore({
        file: join(dir, "state.json"),
        onChange: (change) => host?.emit("state.changed", change),
    });
    const door: ServiceDoor = {
        journal,
        hasClient: (method) => host?.connections.some((c) => !c.closed && c.state.methods.includes(method)) ?? false,
        present: async (request, timeoutMs) => {
            const face = host?.connections.find((c) => !c.closed && c.state.methods.includes("request.present"));
            if (!face) {
                throw new Error("The request face disconnected.");
            }
            return {
                ...requestOutcomeSchema.parse(
                    await face.request("request.present", request, {
                        timeoutMs: Math.max(
                            1,
                            Math.min(timeoutMs, (request.deadlineSeconds ?? timeoutMs / 1000) * 1000)
                        ),
                    })
                ),
                via: "app-window",
                method: "click",
            };
        },
    };
    const deps = liveEngineDeps(AREAS, { ...options.deps, config, state, service: door });
    const handlers: Record<string, RpcHandler<MethodDescriptor, RpcConnection<FaceState>>> = {};
    const deadlines = new Map<string, number>();
    for (const [area, definition] of Object.entries(AREAS)) {
        for (const [name, action] of Object.entries(definition.actions)) {
            const id = `${area}.${name}`;
            deadlines.set(id, serviceActionDeadlineMs(action.timeoutMs));
            handlers[id] = (params, connection) =>
                runAreaAction(
                    AREAS,
                    id,
                    params,
                    { ...deps, facts: { ...deps.facts, isAgent: () => connection.state.caller === "agent" } },
                    { timeoutMs: (deadlines.get(id) ?? 130_000) - 10_000 }
                );
        }
    }
    const extra: RpcHandlers<{ methods: typeof serviceMethods }, RpcConnection<FaceState>> = {
        hello: (params, connection) => {
            connection.state.methods = params.methods;
            connection.state.caller = params.caller;
            return { protocol: 1, methods: genesisToolsApi.methods.map((m) => m.name) };
        },
        "actions.explain": (params) => explainAction(AREAS, params.id, deps, params),
        "config.get": (params) => (params.path.includes(".") ? config.get(params.path) : config.resolve(params.path)),
        "config.set": async (params) => {
            await config.set(params.path, params.value);
            return { changed: true };
        },
        "config.unset": async (params) => {
            await config.unset(params.path);
            return { changed: true };
        },
        "state.report": async (params) => {
            await state.report(params.area, params.key, params.value);
            return { reported: true };
        },
        "requests.post": (params) => journal.post(params),
        "requests.get": (params) => journal.get(params.id),
        "requests.list": (params) => journal.list({ limit: params.limit }),
        "requests.answer": (params) => journal.settle(params.id, params.status, params.reason),
        "requests.withdraw": (params) => journal.withdraw(params.id),
    };
    Object.assign(handlers, extra);
    const table = toRpcTable<typeof genesisToolsApi, RpcConnection<FaceState>>(genesisToolsApi, handlers);
    let repeating = false;
    async function repeatNotices(): Promise<void> {
        if (repeating) {
            return;
        }
        repeating = true;
        try {
            const minutes = personConfigSchema.parse(config.resolve("person")).notification.repeatAfterMinutes;
            if (minutes <= 0) {
                return;
            }
            for (const view of journal.pending()) {
                const last = view.events.findLast((event) => event.type === "delivered");
                if (
                    view.state !== "waiting" ||
                    last?.type !== "delivered" ||
                    last.channel !== "notification" ||
                    Date.now() - Date.parse(last.at) < minutes * 60_000
                ) {
                    continue;
                }

                // An earlier notification of this loop awaited; the request may have been answered or withdrawn since.
                if (journal.get(view.id)?.state !== "waiting") {
                    continue;
                }

                const result = await runAreaAction(AREAS, "person.notifyThenAsk", view.request, deps, {
                    timeoutMs: 15_000,
                });
                if (
                    result.status === "ran" &&
                    typeof result.value === "object" &&
                    result.value !== null &&
                    "status" in result.value &&
                    result.value.status === "pending" &&
                    journal.get(view.id)?.state === "waiting"
                ) {
                    journal.append(view.id, {
                        type: "delivered",
                        at: new Date().toISOString(),
                        channel: "notification",
                        noticeId: view.id,
                    });
                }
            }
        } catch (error) {
            logger.warn({ error }, "GenesisTools request repeat failed");
        } finally {
            repeating = false;
        }
    }
    const offConfig = config.onChange((change) => host?.emit("config.changed", { ...change }));
    const offEvents = deps.events.on((event) =>
        host?.emit(`${event.area}.${event.event}`, { payload: event.payload, at: event.at })
    );
    const started = await startServiceHost({
        dir,
        label: "GenesisTools service",
        logScope: "genesis-tools-service",
        protocol: 1,
        state: (): FaceState => ({ methods: [], caller: "person" }),
        call: async (call: RpcCall<FaceState>) =>
            boundedCall(
                table.call(call.method, call.params, call.connection),
                call.method,
                deadlines.get(call.method) ?? 130_000
            ),
        idleMs: options.idleMs ?? 600_000,
        checkEveryMs,
        onCheck: () => {
            void repeatNotices();
        },
        keepAlive: { idle: () => journal.pending().length > 0 },
        onStopped: () => {
            offConfig();
            offJournal?.();
            offEvents();
        },
    });
    if (started.status === "running") {
        offConfig();
        offEvents();
        return { status: "running" };
    }
    host = started.host;
    try {
        offJournal = journal.followChanges((view) => started.host.emit("request.changed", view), checkEveryMs);
    } catch (error) {
        host.stop("request journal watcher failed to start");
        throw error;
    }
    return { status: "started", host, deps };
}
