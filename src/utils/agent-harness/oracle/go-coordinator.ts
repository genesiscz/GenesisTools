import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { env } from "@genesiscz/utils/env";
import { SafeJSON } from "@genesiscz/utils/json";
import { AbortedError } from "../clock";
import {
    type Coordinator,
    type CoordinatorInternals,
    type Dependencies,
    provideCoordinatorInternals,
    type ToolCallStateView,
} from "../coordinator";
import type { ControlMode, Input } from "../inbox";
import type { Request, RequestOptions, Response, ToolCall, ToolResult } from "../llm";
import { type Operation, type OperationID, type Spec, UnsupportedOperationError } from "../operation";
import type { Item, ModelResponse, Sequence, ToolCallStatus, Turn, TurnID, TurnType } from "../sessionstore";
import type { CallStatus, ToolContext } from "../tool";
import {
    definitionToGo,
    inputFromGo,
    inputToGo,
    itemToGo,
    operationFromGo,
    operationToGo,
    reasoningFromGo,
    requestFromGo,
    requestToGo,
    responseFromGo,
    responseToGo,
    resumeToGo,
    specToGo,
} from "./raw-json";

/**
 * The port's `Coordinator` interface served by the upstream Go coordinator running in the bridge
 * process (`bridge/main.go`). Every dependency in `deps` is the same TypeScript fake the twin built:
 * the bridge calls back over stdio for the store, the model adapter, the tool registry, the
 * operation manager and the context builder. Inputs the twin submits to the TS inbox and updates it
 * pushes to the manager queue are forwarded to the Go side as they arrive.
 *
 * Ids: Go allocates turn, heartbeat-input and operation ids with uuids; the port's driver injects
 * `id-N`. To keep the twins' assertions readable on both sides, every uuid that crosses the boundary
 * is renamed to `deps.newID()`'s next value in order of first appearance, and the reverse mapping is
 * applied to what the TS side sends back (operation updates, cancel ids). The allocation order is
 * the same in both implementations, so the names line up with the port's.
 */

const BRIDGE_DIR = join(dirname(fileURLToPath(import.meta.url)), "bridge");
const BRIDGE_BINARY = join(BRIDGE_DIR, "bin", "harness-oracle-bridge");
const QUIET_MS = 15;
const ACK_TIMEOUT_MS = 1500;
/** `HARNESS_ORACLE_TRACE=1` prints every envelope to stderr. */
const TRACE = env.test.isHarnessOracleTrace();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface BridgeError {
    Message: string;
    Kind?: string;
    /** The TS error object a fake threw, so the run error can carry it as its cause. */
    Ref?: number;
}

/** The Go coordinator's private loop state, read by the bridge through reflection on request. */
interface InternalsSnapshot {
    CurrentTurnID: TurnID;
    CurrentTurnType: TurnType;
    CurrentTurnInputs: number;
    DeliveredInputs: number;
    AvailableInputs: number;
    StopMode: ControlMode | null;
    ModelActive: boolean;
    GraceActive: boolean;
    GraceGeneration: number;
    CallModel: boolean;
    GraceToolCalls: Array<{ TurnID: TurnID; CallID: string }>;
    ToolCalls: Array<{
        TurnID: TurnID;
        CallID: string;
        ToolCall: ToolCall;
        Status: CallStatus | null;
        Operations: OperationID[];
    }>;
    Operations: Operation[];
}

interface Envelope {
    id?: number;
    op?: string;
    call?: string;
    params?: unknown;
    result?: unknown;
    error?: BridgeError;
}

interface TranslateReply {
    Status: CallStatus;
    Specs: Spec[];
    Placeholders: string[];
}

export function isOracleMode(): boolean {
    return env.test.isHarnessOracle();
}

/** Builds the bridge once per checkout when the binary is missing or older than its sources. */
export function ensureBridgeBinary(): string {
    const sources = ["main.go", "go.mod", "go.sum"].map((name) => join(BRIDGE_DIR, name));
    const newest = Math.max(...sources.filter((path) => existsSync(path)).map((path) => statSync(path).mtimeMs));

    if (!existsSync(BRIDGE_BINARY) || statSync(BRIDGE_BINARY).mtimeMs < newest) {
        const build = spawnSync("go", ["build", "-o", BRIDGE_BINARY, "."], {
            cwd: BRIDGE_DIR,
            env: env.getProcessEnv(),
            stdio: ["ignore", "pipe", "pipe"],
        });

        if (build.status !== 0) {
            throw new Error(`go build of the oracle bridge failed: ${build.stderr.toString()}`);
        }
    }

    return BRIDGE_BINARY;
}

function kindOf(error: unknown): string | undefined {
    if (error instanceof UnsupportedOperationError) {
        return "unsupported";
    }

    if (error instanceof Error && (error.name === "AbortedError" || error.name === "AbortError")) {
        return "canceled";
    }

    return undefined;
}

/** Every Go coordinator whose run is in flight; `synctest.Wait()` against the oracle settles them all. */
const live = new Set<GoCoordinator>();

/** Go's zero `time.Time`; the port's fixtures use "" for "unset", which Go cannot parse. */
const GO_ZERO_TIME = "0001-01-01T00:00:00Z";

function toGoTime(value: string | undefined): string {
    return value ? value : GO_ZERO_TIME;
}

function itemForGo(item: Item): Item {
    return { ...itemToGo(item), RecordedAt: toGoTime(item.RecordedAt) };
}

function resumeForGo(state: Dependencies["restored"]): Dependencies["restored"] {
    const converted = resumeToGo(state);
    return {
        ...converted,
        Snapshot: {
            ...converted.Snapshot,
            Session: { ...converted.Snapshot.Session, CreatedAt: toGoTime(converted.Snapshot.Session.CreatedAt) },
        },
    };
}

class IdMap {
    private readonly forward = new Map<string, string>();
    private readonly backward = new Map<string, string>();

    constructor(private readonly newID: () => string) {}

    /** Go → TS: a uuid becomes the port's next id; anything else passes through. */
    rename(id: string): string {
        if (!UUID.test(id)) {
            return id;
        }

        let named = this.forward.get(id);

        if (named === undefined) {
            named = this.newID();
            this.forward.set(id, named);
            this.backward.set(named, id);
        }

        return named;
    }

    /** TS → Go: a port id that names a uuid becomes that uuid again. */
    restore(id: string): string {
        return this.backward.get(id) ?? id;
    }

    /** Go → TS: the port's id, and raw JSON fields back to the port's text form. */
    renameOperation(operation: Operation): Operation {
        return operationFromGo({ ...operation, ID: this.rename(operation.ID) });
    }

    /** TS → Go: the uuid back, and raw JSON fields embedded. */
    restoreOperation(operation: Operation): Operation {
        return operationToGo({ ...operation, ID: this.restore(operation.ID) });
    }

    renameStatus(status: ToolCallStatus): ToolCallStatus {
        return {
            ...status,
            TurnID: this.rename(status.TurnID),
            Status: {
                ...status.Status,
                ...(status.Status.WaitingFor
                    ? { WaitingFor: status.Status.WaitingFor.map((id) => this.rename(id)) }
                    : {}),
            },
            ...(status.Operations ? { Operations: status.Operations.map((op) => this.renameOperation(op)) } : {}),
        };
    }

    renameTurn(turn: Turn): Turn {
        return { ...turn, ID: this.rename(turn.ID), PreviousTurnID: this.rename(turn.PreviousTurnID) };
    }

    renameInput(input: Input): Input {
        return inputFromGo({ ...input, ID: this.rename(input.ID) });
    }

    renameResponse(response: ModelResponse): ModelResponse {
        return { ...response, TurnID: this.rename(response.TurnID), Response: responseFromGo(response.Response) };
    }
}

class GoCoordinator implements Coordinator {
    private child: ChildProcess | undefined;
    private buffer = "";
    private readonly ids: IdMap;
    private readonly pendingCalls = new Map<number, AbortController>();
    private readonly busyCalls = new Set<number>();
    private lastTraffic = Date.now();
    private readonly traceOrigin = Date.now();
    private lastStimulusAt = 0;
    private lastReceivedAt = 0;
    private runDone = false;
    private runSettled: ((error?: unknown) => void) | undefined;
    private started = false;
    private readonly thrown = new Map<number, unknown>();
    /** Ids of TS → Go requests and of thrown-error refs; 1 is the run itself. */
    private nextRequestID = 2;
    private readonly requests = new Map<number, (value: unknown) => void>();
    private snapshot: InternalsSnapshot | undefined;

    constructor(private readonly deps: Dependencies) {
        this.ids = new IdMap(deps.newID ?? (() => `id-${Math.random().toString(36).slice(2, 8)}`));
        provideCoordinatorInternals(this, () => this.internals());
    }

    private toBridgeError(error: unknown): BridgeError {
        const ref = this.nextRequestID++;
        this.thrown.set(ref, error);
        const kind = kindOf(error);
        return {
            Message: error instanceof Error ? error.message : String(error),
            ...(kind ? { Kind: kind } : {}),
            Ref: ref,
        };
    }

    /**
     * The run error as the port would raise it: the message Go built, with the fake's own error
     * object as the cause (so `errorIs` finds it) and the sentinel class Go's `errors.Is` saw.
     */
    private fromBridgeError(error: BridgeError): Error {
        const thrown = error.Ref !== undefined ? this.thrown.get(error.Ref) : undefined;
        const sentinel =
            error.Kind === "unsupported"
                ? new UnsupportedOperationError(error.Message)
                : error.Kind === "canceled"
                  ? new AbortedError(error.Message)
                  : undefined;

        if (sentinel && thrown !== undefined && !(thrown instanceof sentinel.constructor)) {
            sentinel.cause = thrown;
        }

        const cause = sentinel ?? thrown;
        return cause === undefined ? new Error(error.Message) : new Error(error.Message, { cause });
    }

    run(signal: AbortSignal): Promise<void> {
        if (this.started) {
            return Promise.reject(new Error("GoCoordinator.run is single use"));
        }

        this.started = true;

        if (signal.aborted) {
            return Promise.reject(signal.reason ?? new Error("aborted"));
        }

        const binary = ensureBridgeBinary();
        const child = spawn(binary, [], { stdio: ["pipe", "pipe", "pipe"], env: env.getProcessEnv() });
        this.child = child;
        child.stderr?.on("data", (chunk: Buffer) => {
            process.stderr.write(`[oracle bridge] ${chunk.toString()}`);
        });
        child.stdout?.on("data", (chunk: Buffer) => this.onData(chunk));

        return new Promise<void>((resolve, reject) => {
            let done = false;
            const finish = (error?: unknown) => {
                if (done) {
                    return;
                }

                done = true;
                this.runDone = true;
                this.runSettled = undefined;
                live.delete(this);
                child.stdin?.end();
                child.kill("SIGKILL");
                signal.removeEventListener("abort", onAbort);

                // A run that ends mid-settle answers nothing; the last snapshot stands.
                for (const resolve of this.requests.values()) {
                    resolve(undefined);
                }

                this.requests.clear();

                if (error !== undefined) {
                    reject(error);
                } else {
                    resolve();
                }
            };
            this.runSettled = finish;
            live.add(this);
            const onAbort = () => {
                this.send({ op: "cancel" });
            };
            signal.addEventListener("abort", onAbort, { once: true });
            child.on("exit", (code) => {
                finish(new Error(`oracle bridge exited with code ${code} before the run settled`));
            });
            child.on("error", (error) => {
                finish(new Error(`oracle bridge could not run: ${error.message}`));
            });

            this.send({
                id: 1,
                op: "run",
                params: {
                    SessionID: this.deps.sessionID,
                    Restored: resumeForGo(this.deps.restored),
                    ToolHeartbeatMs: this.deps.toolHeartbeatIntervalMs,
                },
            });
            void this.forwardInputs(signal);
            void this.forwardUpdates(signal);
        }).then(
            () => undefined,
            (error: unknown) => {
                // Go returns ctx.Err() for a canceled run, bare or as "<step>: context canceled"; the
                // port rejects with the signal's reason itself, or "<step>: <reason>" with it as the cause.
                if (signal.aborted && error instanceof Error && /context canceled/.test(error.message)) {
                    const reason: unknown = signal.reason ?? new AbortedError("aborted");

                    if (error.message === "context canceled") {
                        throw reason;
                    }

                    const text = reason instanceof Error ? reason.message : String(reason);
                    throw new Error(error.message.replace(/context canceled/, text), { cause: reason });
                }

                throw error;
            }
        );
    }

    /**
     * Resolves when the Go loop is at rest: no callback in flight, the bridge quiet for a while,
     * and the Go side heard from since the last stimulus (a run, input, update or cancel), so the
     * process's own startup gap is not mistaken for rest. A stimulus that Go answers with nothing
     * (an update for an operation it does not know) ends the wait after `ACK_TIMEOUT_MS`.
     */
    async settled(): Promise<void> {
        const started = Date.now();

        while (true) {
            const now = Date.now();
            const quiet = now - this.lastTraffic;
            const acknowledged = this.lastReceivedAt >= this.lastStimulusAt || this.runDone;

            if (this.busyCalls.size === 0 && quiet >= QUIET_MS && (acknowledged || now - started > ACK_TIMEOUT_MS)) {
                break;
            }

            await new Promise((resolve) => setTimeout(resolve, 5));
        }

        const snapshot = await this.request("internals", {});

        if (snapshot !== undefined) {
            this.snapshot = snapshot as InternalsSnapshot;
        }
    }

    /**
     * A TS → Go op the bridge answers (internals and the white-box setters). Resolves undefined
     * when the run has ended, since the bridge process is gone.
     */
    private request(op: string, params: unknown): Promise<unknown> {
        if (this.runDone) {
            return Promise.resolve(undefined);
        }

        const id = this.nextRequestID++;
        return new Promise((resolve) => {
            this.requests.set(id, resolve);
            this.send({ id, op, params });
        });
    }

    /**
     * The white-box view the driver's `run.internals()` reads: the snapshot the bridge took when the
     * run last settled. The setters go to Go and update the snapshot; the loop-driving methods the
     * loop twins use are not available (those twins are `skipIf(oracle)`).
     */
    private internals(): CoordinatorInternals {
        const snapshot = this.snapshot;

        if (!snapshot) {
            throw new Error("oracle internals: the run has not settled yet");
        }

        const unavailable = (name: string) => () => {
            throw new Error(`${name} is not available against the Go oracle`);
        };
        const ids = this.ids;
        const self = this;
        return {
            get currentTurnID() {
                return ids.rename(snapshot.CurrentTurnID);
            },
            get currentTurnType() {
                return snapshot.CurrentTurnType;
            },
            setCurrentTurnType(type: TurnType) {
                snapshot.CurrentTurnType = type;
                void self.request("setCurrentTurnType", { Type: type });
            },
            get currentTurnInputs() {
                return snapshot.CurrentTurnInputs;
            },
            get deliveredInputs() {
                return snapshot.DeliveredInputs;
            },
            get availableInputs() {
                return snapshot.AvailableInputs;
            },
            get stopMode() {
                return snapshot.StopMode;
            },
            get modelActive() {
                return snapshot.ModelActive;
            },
            get graceActive() {
                return snapshot.GraceActive;
            },
            get graceGeneration() {
                return snapshot.GraceGeneration;
            },
            get callModel() {
                return snapshot.CallModel;
            },
            set callModel(value: boolean) {
                snapshot.CallModel = value;
                void self.request("setCallModel", { Value: value });
            },
            graceToolCallKeys: () =>
                snapshot.GraceToolCalls.map((key) => ({ turnID: ids.rename(key.TurnID), callID: key.CallID })),
            toolCallStates: (): ToolCallStateView[] =>
                snapshot.ToolCalls.map((call) => ({
                    turnID: ids.rename(call.TurnID),
                    callID: call.CallID,
                    toolCall: call.ToolCall,
                    ...(call.Status ? { status: self.renameCallStatus(call.Status) } : {}),
                    operations: call.Operations.map((id) => ids.rename(id)),
                })),
            operationStates: () =>
                new Map(snapshot.Operations.map((op) => ids.renameOperation(op)).map((op) => [op.ID, op])),
            pendingInputs: () => snapshot.AvailableInputs - snapshot.DeliveredInputs,
            restore: unavailable("restore"),
            loadHistory: unavailable("loadHistory"),
            addItemToLocalState: unavailable("addItemToLocalState"),
            handleModelResponse: unavailable("handleModelResponse"),
            handleOperationUpdate: unavailable("handleOperationUpdate"),
            scheduleToolCalls: unavailable("scheduleToolCalls"),
            reconcileToolCalls: unavailable("reconcileToolCalls"),
            dispatchOperationsToManager: unavailable("dispatchOperationsToManager"),
            toolCallOperationsAreTerminal: unavailable("toolCallOperationsAreTerminal"),
            addToolResultToLocalState: unavailable("addToolResultToLocalState"),
            addOperationToLocalState: unavailable("addOperationToLocalState"),
            addToolCallsToLocalState: unavailable("addToolCallsToLocalState"),
            storeItemInSessionStore: unavailable("storeItemInSessionStore"),
            closedInputError: unavailable("closedInputError"),
        };
    }

    private send(envelope: Envelope): void {
        // After the run settled the bridge is gone; a late forward or cancel has nowhere to go.
        if (this.runDone || !this.child?.stdin || this.child.stdin.destroyed) {
            return;
        }

        this.lastTraffic = Date.now();

        // A stimulus is what the loop reacts to; a white-box read is answered by the bridge itself.
        if (envelope.op !== undefined && envelope.op !== "internals") {
            this.lastStimulusAt = this.lastTraffic;
        }

        const line = SafeJSON.stringify(envelope, { strict: true });

        if (TRACE) {
            process.stderr.write(`[oracle → ${Date.now() - this.traceOrigin}ms] ${line.slice(0, 300)}\n`);
        }

        this.child.stdin.write(`${line}\n`);
    }

    private async forwardInputs(signal: AbortSignal): Promise<void> {
        const queue = this.deps.inbox.outputQueue();

        while (!signal.aborted && !this.runDone) {
            await queue.available();
            const input = queue.tryTake();

            if (input !== undefined) {
                this.send({ op: "input", params: { Input: inputToGo({ ...input, ID: this.ids.restore(input.ID) }) } });
                continue;
            }

            if (queue.closed) {
                this.send({ op: "inboxClose" });
                return;
            }
        }
    }

    private async forwardUpdates(signal: AbortSignal): Promise<void> {
        const queue = this.deps.operations.updates();

        while (!signal.aborted && !this.runDone) {
            await queue.available();
            const update = queue.tryTake();

            if (update !== undefined) {
                this.send({ op: "operationUpdate", params: { Operation: this.ids.restoreOperation(update) } });
                continue;
            }

            if (queue.closed) {
                this.send({ op: "updatesClose" });
                return;
            }
        }
    }

    private onData(chunk: Buffer): void {
        this.lastTraffic = Date.now();
        this.lastReceivedAt = this.lastTraffic;
        this.buffer += chunk.toString();
        let newline = this.buffer.indexOf("\n");

        while (newline >= 0) {
            const line = this.buffer.slice(0, newline);
            this.buffer = this.buffer.slice(newline + 1);
            newline = this.buffer.indexOf("\n");

            if (line.trim() === "") {
                continue;
            }

            if (TRACE) {
                process.stderr.write(`[oracle ← ${Date.now() - this.traceOrigin}ms] ${line.slice(0, 300)}\n`);
            }

            const envelope = SafeJSON.parse(line, { strict: true }) as Envelope;
            void this.dispatch(envelope);
        }
    }

    private async dispatch(envelope: Envelope): Promise<void> {
        if (envelope.id === 1 && envelope.call === undefined) {
            if (envelope.result) {
                this.snapshot = envelope.result as InternalsSnapshot;
            }

            this.runSettled?.(envelope.error ? this.fromBridgeError(envelope.error) : undefined);
            return;
        }

        if (envelope.call === undefined && envelope.id !== undefined) {
            const resolve = this.requests.get(envelope.id);
            this.requests.delete(envelope.id);

            if (envelope.error) {
                process.stderr.write(`[oracle bridge] request ${envelope.id} failed: ${envelope.error.Message}\n`);
            }

            resolve?.(envelope.error ? undefined : envelope.result);
            return;
        }

        if (envelope.call === "cancelCall") {
            const { ID } = envelope.params as { ID: number };
            this.pendingCalls.get(ID)?.abort(new Error("canceled by the Go context"));
            return;
        }

        if (envelope.call === "inputRejected") {
            process.stderr.write(`[oracle bridge] input rejected: ${SafeJSON.stringify(envelope.params)}\n`);
            return;
        }

        if (envelope.call === undefined || envelope.id === undefined) {
            return;
        }

        const controller = new AbortController();
        this.pendingCalls.set(envelope.id, controller);

        // A model call stays open until the twin answers it (`run.respond`), so it is rest, not
        // work in flight; every other callback is answered from the fakes at once.
        if (envelope.call !== "llm.respond") {
            this.busyCalls.add(envelope.id);
        }

        const inboxBefore = this.deps.inbox;

        try {
            const result = await this.serve(envelope.call, envelope.params, controller.signal);

            // A twin that swaps `deps.inbox` inside a fake (heartbeat_test) swaps it on the Go side too.
            if (this.deps.inbox !== inboxBefore) {
                const reason = this.deps.inbox.closeReason;
                this.send({
                    op: "replaceInbox",
                    params: { Reason: reason === undefined ? null : this.toBridgeError(reason) },
                });
            }

            this.send({ id: envelope.id, result: result ?? null });
        } catch (error) {
            this.send({ id: envelope.id, error: this.toBridgeError(error) });
        } finally {
            this.pendingCalls.delete(envelope.id);
            this.busyCalls.delete(envelope.id);
        }
    }

    private async serve(call: string, rawParams: unknown, signal: AbortSignal): Promise<unknown> {
        const params = (rawParams ?? {}) as Record<string, unknown>;
        const { sessions, llm, tools, operations, contextBuilder } = this.deps;

        switch (call) {
            case "store.items": {
                const page = await sessions.items(
                    params.SessionID as string,
                    params.After as Sequence,
                    params.Limit as number
                );
                return { ...page, Items: page.Items.map(itemForGo) };
            }
            case "store.appendInput":
                return sessions.appendInput(params.SessionID as string, this.ids.renameInput(params.Input as Input));
            case "store.appendTurn":
                return sessions.appendTurn(params.SessionID as string, this.ids.renameTurn(params.Turn as Turn));
            case "store.appendModelResponse":
                return sessions.appendModelResponse(
                    params.SessionID as string,
                    this.ids.renameResponse(params.Response as ModelResponse)
                );
            case "store.appendToolCallStatus":
                return sessions.appendToolCallStatus(
                    params.SessionID as string,
                    this.ids.renameStatus(params.Status as ToolCallStatus)
                );
            case "store.saveOperation":
                return sessions.saveOperation(
                    params.SessionID as string,
                    this.ids.renameOperation(params.Operation as Operation)
                );
            case "store.resume":
                return resumeForGo(await sessions.resume(params.SessionID as string));
            case "llm.respond":
                return responseToGo(
                    await llm.respond(
                        requestFromGo(this.renameRequest(params.Request as Request)),
                        params.Options as RequestOptions,
                        signal
                    )
                );
            case "tools.staticDefinitions":
                return tools.staticDefinitions().map(definitionToGo);
            case "tools.resolve":
                return tools.resolve(params.Name as string) !== undefined;
            case "tools.translate":
                return this.translate(params.Name as string, params.Call as ToolCall);
            case "tools.translateResult": {
                const translator = tools.resolve(params.Name as string);

                if (!translator) {
                    throw new Error(`tool "${String(params.Name)}" is not registered`);
                }

                const result: ToolResult = translator.translateResult(
                    params.CallID as string,
                    this.renameCallStatus(params.Status as CallStatus),
                    (params.Operations as Operation[]).map((op) => this.ids.renameOperation(op))
                );
                return result;
            }
            case "tools.skills":
                return tools.skills();
            case "tools.registerSkill":
                throw new Error("registerSkill is not proxied by the oracle bridge");
            case "operations.add":
                return operations.add(this.ids.renameOperation(params.Operation as Operation));
            case "operations.cancel":
                return operations.cancel(this.ids.rename(params.ID as OperationID), params.Reason as string);
            case "builder.addExternalInput":
                return contextBuilder.addExternalInput(this.ids.renameInput(params.Input as Input));
            case "builder.addControlMessage":
                return contextBuilder.addControlMessage(
                    params.Request as Parameters<typeof contextBuilder.addControlMessage>[0]
                );
            case "builder.setModel":
                return contextBuilder.setModel(params.Model as Parameters<typeof contextBuilder.setModel>[0]);
            case "builder.setSystemPrompt":
                return contextBuilder.setSystemPrompt(params.Prompt as string);
            case "builder.addModelResponse":
                return contextBuilder.addModelResponse(responseFromGo(params.Response as Response));
            case "builder.addReasoning":
                return contextBuilder.addReasoning(
                    reasoningFromGo(params.Reasoning as Parameters<typeof contextBuilder.addReasoning>[0])
                );
            case "builder.addTool":
                return contextBuilder.addTool(params.Tool as Parameters<typeof contextBuilder.addTool>[0]);
            case "builder.addToolResult":
                return contextBuilder.addToolResult(
                    params.CallID as string,
                    params.Payload as Parameters<typeof contextBuilder.addToolResult>[1],
                    params.Running as boolean
                );
            case "builder.commit":
                return contextBuilder.commit();
            case "builder.build": {
                const built = contextBuilder.build();
                return { ...built, Request: requestToGo(built.Request) };
            }
            default:
                throw new Error(`oracle bridge asked for an unknown call "${call}"`);
        }
    }

    private renameRequest(request: Request): Request {
        return request;
    }

    private renameCallStatus(status: CallStatus): CallStatus {
        return status.WaitingFor
            ? { ...status, WaitingFor: status.WaitingFor.map((id) => this.ids.rename(id)) }
            : status;
    }

    /**
     * The TS translator submits specs synchronously and expects ids back, while the Go tool context
     * allocates them on the other side. The translator runs against a recording context that hands
     * out placeholders; the bridge submits the specs in order and rewrites the placeholders.
     */
    private translate(name: string, call: ToolCall): TranslateReply {
        const translator = this.deps.tools.resolve(name);

        if (!translator) {
            throw new Error(`tool "${name}" is not registered`);
        }

        const specs: Spec[] = [];
        const placeholders: string[] = [];
        const context: ToolContext = {
            submit: (spec) => {
                const placeholder = `$${specs.length + 1}`;
                specs.push(spec);
                placeholders.push(placeholder);
                return placeholder;
            },
        };
        const status = translator.translate(context, call);
        return { Status: status, Specs: specs.map(specToGo), Placeholders: placeholders };
    }
}

export function newGoCoordinator(deps: Dependencies): Coordinator {
    return new GoCoordinator(deps);
}

/** The driver's settle hook: waits for the bridge to go quiet. */
export function settleGoCoordinator(coordinator: Coordinator): Promise<void> {
    return coordinator instanceof GoCoordinator ? coordinator.settled() : Promise.resolve();
}

/** `synctest.Wait()` against the oracle: every running Go coordinator at rest. */
export async function settleLiveGoCoordinators(): Promise<void> {
    await Promise.all([...live].map((coordinator) => coordinator.settled()));
}
