import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { type MethodDescriptor, type RpcHandler, type RpcHandlers, toRpcTable } from "@genesiscz/utils/api-descriptor";
import { createConfigStore } from "@genesiscz/utils/genesis-tools/actions/config";
import type { AnyActionDef } from "@genesiscz/utils/genesis-tools/actions/define";
import { type Area, type EngineDeps, liveEngineDeps } from "@genesiscz/utils/genesis-tools/actions/registry";
import { actionBudgetMs, explainAction, runAreaAction } from "@genesiscz/utils/genesis-tools/actions/run";
import { createStateStore } from "@genesiscz/utils/genesis-tools/actions/state";
import { AREAS } from "@genesiscz/utils/genesis-tools/areas";
import { createRequestJournal } from "@genesiscz/utils/genesis-tools/areas/person/journal";
import { type RequestOutcome, requestOutcomeSchema } from "@genesiscz/utils/genesis-tools/areas/person/request";
import { logger } from "@genesiscz/utils/logger";
import { JSON_RPC_ERRORS, RpcError } from "@genesiscz/utils/rpc/errors";
import { type ServiceHost, startServiceHost } from "@genesiscz/utils/rpc/service-host";
import type { RpcCall, RpcConnection } from "@genesiscz/utils/rpc/socket-server";
import { genesisToolsDir } from "@genesiscz/utils/storage/root";
import { isTestProcess } from "@genesiscz/utils/test-process";
import { z } from "zod";
import { personConfigSchema } from "../areas/person/deliveries";
import { genesisToolsApi, type serviceMethods } from "./api";
import { genesisToolsServiceDir, type ServiceDoor, serviceActionDeadlineMs } from "./clients";

interface FaceState {
    methods: string[];
    caller: "person" | "agent" | "face";
}

/** What a handler gets: the connection it answers, and a signal that aborts at its deadline or the caller's cancel. */
interface ServiceCall {
    connection: RpcConnection<FaceState>;
    signal: AbortSignal;
}

/**
 * Runs a handler under its deadline. At the deadline the handler's signal aborts (a write checks it right before the
 * file is replaced, an action starts no further step), and the caller is told that the outcome is unknown: a step
 * already under way can still finish.
 */
async function boundedCall(
    call: RpcCall<FaceState>,
    timeoutMs: number,
    handle: (signal: AbortSignal) => Promise<unknown>
): Promise<unknown> {
    const { method } = call;
    const controller = new AbortController();
    const onCallerAbort = (): void => controller.abort(call.context.signal.reason);
    call.context.signal.addEventListener("abort", onCallerAbort, { once: true });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
            const message = `GenesisTools service request failed: ${method} exceeded its ${timeoutMs} ms deadline; it was told to stop, and whether it changed anything is unknown`;
            logger.error({ method }, message);
            try {
                const dir = genesisToolsDir("logs");
                mkdirSync(dir, { recursive: true });
                const time = new Date().toLocaleTimeString("en-GB", { timeZone: "Europe/Prague", hour12: false });
                appendFileSync(join(dir, "app-perf.log"), `[${time}] [genesis-tools] ${message}\n`);
            } catch (error) {
                logger.warn({ error, method }, "Service deadline could not be written to the app monitor");
            }
            const error = new RpcError(1001, message);
            controller.abort(error);
            reject(error);
        }, timeoutMs);
    });
    try {
        return await Promise.race([handle(controller.signal), expired]);
    } finally {
        clearTimeout(timer);
        call.context.signal.removeEventListener("abort", onCallerAbort);
    }
}

/** A call that is not an action (config, state, requests) finishes in seconds; this bounds a wedged one. */
const DEFAULT_CALL_DEADLINE_MS = 130_000;

const actionRunParams = z.object({ id: z.string(), timeoutMs: z.number().optional() });

/** The action `<area>.<action>` names, or null for every other method. */
function actionOf(id: string): AnyActionDef | null {
    const registry: Record<string, Area> = AREAS;
    const dot = id.indexOf(".");
    const area = dot > 0 && Object.hasOwn(registry, id.slice(0, dot)) ? registry[id.slice(0, dot)] : undefined;
    const name = id.slice(dot + 1);
    return area && Object.hasOwn(area.actions, name) ? (area.actions[name] ?? null) : null;
}

export async function startGenesisToolsService(
    options: {
        dir?: string;
        deps?: Partial<EngineDeps>;
        idleMs?: number;
        checkEveryMs?: number;
        /** The checkout to watch: a changed module under it retires the service once no call runs. */
        sourceRoot?: string;
    } = {}
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
    const callerDeps = (connection: RpcConnection<FaceState>): EngineDeps => ({
        ...deps,
        facts: { ...deps.facts, isAgent: () => connection.state.caller === "agent" },
    });
    const handlers: Record<string, RpcHandler<MethodDescriptor, ServiceCall>> = {};
    for (const [area, definition] of Object.entries(AREAS)) {
        for (const name of Object.keys(definition.actions)) {
            const id = `${area}.${name}`;
            handlers[id] = (params, call) =>
                runAreaAction(AREAS, id, params, callerDeps(call.connection), { signal: call.signal });
        }
    }
    /** An action call's host deadline: the engine's own budget, plus the time to send its expiry outcome back. */
    const callDeadlineMs = (method: string, params: unknown): number => {
        const run = method === "actions.run" ? actionRunParams.safeParse(params) : null;
        // requests.present runs person.showWindow inside the call, so it gets that action's deadline.
        const action = actionOf(
            run?.success ? run.data.id : method === "requests.present" ? "person.showWindow" : method
        );

        if (!action) {
            return DEFAULT_CALL_DEADLINE_MS;
        }

        return serviceActionDeadlineMs(actionBudgetMs(action, run?.success ? run.data.timeoutMs : undefined));
    };
    const extra: RpcHandlers<{ methods: typeof serviceMethods }, ServiceCall> = {
        hello: (params, { connection }) => {
            connection.state.methods = params.methods;
            connection.state.caller = params.caller;
            return { protocol: 1, methods: genesisToolsApi.methods.map((m) => m.name) };
        },
        "actions.run": (params, call) => {
            if (!actionOf(params.id)) {
                throw new RpcError(JSON_RPC_ERRORS.invalidParams, `actions.run: no action "${params.id}"`);
            }

            return runAreaAction(AREAS, params.id, params.args ?? {}, callerDeps(call.connection), {
                timeoutMs: params.timeoutMs,
                signal: call.signal,
            });
        },
        "actions.explain": (params) => explainAction(AREAS, params.id, deps, params),
        "config.get": (params) => (params.path.includes(".") ? config.get(params.path) : config.resolve(params.path)),
        "config.set": async (params, { signal }) => {
            await config.set(params.path, params.value, { signal });
            return { changed: true };
        },
        "config.unset": async (params, { signal }) => {
            await config.unset(params.path, { signal });
            return { changed: true };
        },
        "state.report": async (params, { signal }) => {
            await state.report(params.area, params.key, params.value, { signal });
            return { reported: true };
        },
        "requests.post": (params) => journal.post(params),
        "requests.get": (params) => journal.get(params.id),
        "requests.list": (params) => journal.list({ limit: params.limit }),
        "requests.present": async (params, call) => {
            const view = journal.get(params.id);
            if (!view) {
                throw new Error(`request ${params.id} does not exist`);
            }

            if (view.outcome.status !== "pending") {
                return view.outcome;
            }

            // The service presents the request itself and records only the answer of that presentation, so no
            // client can hand in an answer for the person. A click on the notification passes takesFocus.
            const takesFocus =
                params.takesFocus ?? personConfigSchema.parse(config.resolve("person")).dialog.takesFocus;
            const shown = await runAreaAction(
                AREAS,
                "person.showWindow",
                { ...view.request, takesFocus },
                callerDeps(call.connection),
                { signal: call.signal }
            );
            const outcome: RequestOutcome =
                shown.status === "ran"
                    ? requestOutcomeSchema.parse(shown.value)
                    : {
                          id: view.id,
                          status: "unreachable",
                          reason:
                              shown.skipped.map((skip) => skip.reason).join("; ") || "No request surface could run.",
                      };
            if (outcome.status === "done" || outcome.status === "declined") {
                return journal.settle(view.id, outcome.status, outcome.reason, {
                    via: outcome.via,
                    method: outcome.method,
                });
            }

            return outcome;
        },
        "requests.withdraw": (params) => journal.withdraw(params.id),
    };
    Object.assign(handlers, extra);
    const table = toRpcTable<typeof genesisToolsApi, ServiceCall>(genesisToolsApi, handlers);
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
            boundedCall(call, callDeadlineMs(call.method, call.params), (signal) =>
                table.call(call.method, call.params, { connection: call.connection, signal })
            ),
        idleMs: options.idleMs ?? 600_000,
        checkEveryMs,
        sourceRoot: options.sourceRoot,
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
