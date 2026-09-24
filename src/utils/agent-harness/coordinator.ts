import { SafeJSON } from "@genesiscz/utils/json";
import type { AsyncQueue } from "./async-queue";
import { type Clock, realClock } from "./clock";
import type { Builder } from "./contextbuilder";
import { type ControlMessage, decodeControlMessage, type Inbox, type Input, validateInput } from "./inbox";
import type { Adapter, Request, Response, ToolCall } from "./llm";
import { isTerminal, type Manager, type Operation, type OperationID, type Spec } from "./operation";
import {
    BEFORE_FIRST,
    type Item,
    type ModelResponse,
    type ResumeState,
    type SessionID,
    type Store,
    type ToolCallStatus,
    type Turn,
    type TurnID,
    type TurnType,
} from "./sessionstore";
import { type CallStatus, errorStatus, type Registry, type ToolContext } from "./tool";

/**
 * The owner of one session's decision loop, ported 1:1 from `harness/coordinator`.
 *
 * Go runs this as a goroutine selecting over channels; here it is one async loop racing
 * event sources (inbox, operation updates, the in-flight model call, the tool grace timer,
 * the heartbeat timer, cancellation). Every state transition, error message and ordering
 * rule follows `loop.go` of the pinned upstream commit (UPSTREAM.md), so the Go test corpus
 * can be replayed against it.
 */

export const HISTORY_PAGE_SIZE = 256;
export const SLURP_IDLE_MS = 1;
export const SLURP_MAX_ITEMS = 100;
export const TOOL_CALL_RUN_GRACE_MS = 1000;

export interface Dependencies {
    toolHeartbeatIntervalMs: number;
    sessionID: SessionID;
    inbox: Inbox;
    restored: ResumeState;
    sessions: Store;
    contextBuilder: Builder;
    llm: Adapter;
    tools: Registry;
    operations: Manager;
    clock?: Clock;
    /** Turn and operation ids. Tests inject a counter so fixtures are stable. */
    newID?: () => string;
}

export interface Coordinator {
    /**
     * Owns one session's decision loop until a stop control completes (resolves) or the signal
     * aborts (rejects with its reason). Single use; the caller cancels the inbox afterwards.
     */
    run(signal: AbortSignal): Promise<void>;
}

interface ToolCallKey {
    turnID: TurnID;
    callID: string;
}

function keyOf(turnID: TurnID, callID: string): string {
    return `${turnID}\u0000${callID}`;
}

function splitKey(key: string): ToolCallKey {
    const [turnID, callID] = key.split("\u0000");
    return { turnID, callID };
}

interface ToolCallState {
    toolCall: ToolCall;
    status?: CallStatus;
    operations: Set<OperationID>;
}

interface ModelCall {
    turnID: TurnID;
    controller: AbortController;
    promise: Promise<LoopEvent>;
}

interface TimerHandle {
    controller: AbortController;
    promise: Promise<LoopEvent | null>;
    fired: boolean;
}

type LoopEvent =
    | { kind: "aborted" }
    | { kind: "input"; value: Input | undefined }
    | { kind: "operation"; value: Operation | undefined }
    | { kind: "heartbeat" }
    | { kind: "grace" }
    | { kind: "model"; call: ModelCall; response?: Response; error?: unknown };

function describe(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null;
}

function hasStrings(value: unknown, ...keys: string[]): boolean {
    return isRecord(value) && keys.every((key) => typeof value[key] === "string");
}

/** The Go type name a `Data` value looks like, for the `%T` part of the assertion message. */
function describeItemData(data: unknown): string {
    if (hasStrings(data, "ID", "PreviousTurnID", "Type")) {
        return "session.Turn";
    }

    if (hasStrings(data, "ID", "Kind")) {
        return "inbox.Input";
    }

    if (hasStrings(data, "ParentID", "PreviousTurnID")) {
        return "sessionstore.Fork";
    }

    if (hasStrings(data, "TurnID", "CallID")) {
        return "sessionstore.ToolCallStatus";
    }

    if (hasStrings(data, "TurnID") && isRecord(data) && isRecord(data.Response)) {
        return "sessionstore.ModelResponse";
    }

    return data === null ? "<nil>" : typeof data;
}

/**
 * Go's `item.Data.(T)` assertions in `addItemToLocalState` (`loop.go`): a session item whose
 * `Data` is not the type its `Kind` names fails restore with "<kind> data is %T, want T".
 * The port's `Item` union cannot express that in typed code, but a session written by another
 * writer (the Go binary shares the JSON) can, so the shape is checked at runtime.
 */
function assertItemData(item: Item): void {
    const data: unknown = item.Data;
    const want = (expected: string, ok: boolean) => {
        if (!ok) {
            throw new Error(`${item.Kind} data is ${describeItemData(data)}, want ${expected}`);
        }
    };

    switch (item.Kind) {
        case "fork":
            want("sessionstore.Fork", hasStrings(data, "ParentID", "PreviousTurnID"));
            return;
        case "input":
            want("inbox.Input", hasStrings(data, "ID", "Kind"));
            return;
        case "turn":
            want("session.Turn", hasStrings(data, "ID", "PreviousTurnID", "Type"));
            return;
        case "model_response":
            want("sessionstore.ModelResponse", hasStrings(data, "TurnID") && isRecord(data) && isRecord(data.Response));
            return;
        case "tool_call_status":
            want(
                "sessionstore.ToolCallStatus",
                hasStrings(data, "TurnID", "CallID") && isRecord(data) && isRecord(data.Status)
            );
            return;
        default:
            return;
    }
}

function wrap(prefix: string, error: unknown): Error {
    return new Error(`${prefix}: ${describe(error)}`, { cause: error });
}

class ToolCallContext implements ToolContext {
    readonly operations: Operation[] = [];

    constructor(private readonly newID: () => string) {}

    submit(spec: Spec): OperationID {
        const id = this.newID();
        const operation: Operation = {
            ...(spec.MaxOutputLength ? { MaxOutputLength: spec.MaxOutputLength } : {}),
            ID: id,
            Type: spec.Type,
            Version: spec.Version,
            Status: "ready",
            ...(spec.State !== undefined ? { State: spec.State } : {}),
            ...(spec.Idempotency !== undefined ? { Idempotency: spec.Idempotency } : {}),
        };
        this.operations.push(operation);
        return id;
    }
}

export function toolCallRequiresTranslator(status: ToolCallStatus): boolean {
    return (
        status.Status.Error === "" ||
        (status.Status.WaitingFor?.length ?? 0) !== 0 ||
        (status.Operations?.length ?? 0) !== 0
    );
}

export function toolCallStatusesRequireModelResponse(statuses: ToolCallStatus[]): boolean {
    return statuses.some((status) => status.Status.Error !== "" || (status.Status.WaitingFor?.length ?? 0) === 0);
}

class CoordinatorImpl implements Coordinator {
    private readonly clock: Clock;
    private readonly newID: () => string;

    private currentTurnID: TurnID = "";
    private currentTurnType: TurnType = "regular";
    private readonly toolCalls = new Map<string, ToolCallState>();
    private readonly operations = new Map<OperationID, Operation>();
    private availableInputs = 0;
    private deliveredInputs = 0;
    private currentTurnInputs = 0;
    private callModel = false;
    /** Counts grace timers armed, so a test can tell "still the same timer" from "re-armed". */
    private graceGeneration = 0;
    private grace: TimerHandle | null = null;
    private readonly graceToolCalls = new Set<string>();

    private stopRequest: ControlMessage | null = null;
    private cancellationRequested = false;
    private modelCall: ModelCall | null = null;

    constructor(private readonly deps: Dependencies) {
        this.clock = deps.clock ?? realClock;
        this.newID = deps.newID ?? (() => crypto.randomUUID());
    }

    internals(): CoordinatorInternals {
        const self = this;
        return {
            get currentTurnID() {
                return self.currentTurnID;
            },
            get currentTurnType() {
                return self.currentTurnType;
            },
            setCurrentTurnType(type) {
                self.currentTurnType = type;
            },
            get currentTurnInputs() {
                return self.currentTurnInputs;
            },
            get deliveredInputs() {
                return self.deliveredInputs;
            },
            get availableInputs() {
                return self.availableInputs;
            },
            get stopMode() {
                return self.stopRequest?.Mode ?? null;
            },
            get modelActive() {
                return self.modelCall !== null;
            },
            get graceActive() {
                return self.grace !== null;
            },
            get graceGeneration() {
                return self.graceGeneration;
            },
            get callModel() {
                return self.callModel;
            },
            set callModel(value: boolean) {
                self.callModel = value;
            },
            graceToolCallKeys: () => [...self.graceToolCalls].map(splitKey),
            toolCallStates: () =>
                [...self.toolCalls].map(([key, state]) => ({
                    ...splitKey(key),
                    toolCall: state.toolCall,
                    ...(state.status ? { status: state.status } : {}),
                    operations: [...state.operations],
                })),
            operationStates: () => new Map(self.operations),
            pendingInputs: () => self.pendingInputs(),
            restore: () => self.restore(),
            loadHistory: () => self.loadHistory(),
            addItemToLocalState: (item) => self.addItemToLocalState(item),
            handleModelResponse: (response) => self.handleModelResponse(response),
            handleOperationUpdate: async (update) => {
                const stored = self.addOperationToLocalState(update);
                await self.storeOperationInSessionStore(stored);
            },
            scheduleToolCalls: () => self.scheduleToolCalls(),
            reconcileToolCalls: () => self.reconcileToolCalls(),
            dispatchOperationsToManager: () => self.dispatchOperationsToManager(),
            toolCallOperationsAreTerminal: (turnID, callID) => self.toolCallOperationsAreTerminal(turnID, callID),
            addToolResultToLocalState: (status) => self.addToolResultToLocalState(status),
            addOperationToLocalState: (operation) => self.addOperationToLocalState(operation),
            addToolCallsToLocalState: (response) => self.addToolCallsToLocalState(response),
            storeItemInSessionStore: (item) => self.storeItemInSessionStore(item),
            closedInputError: (signal, name) => self.closedInputError(signal, name),
        };
    }

    // ─────────────────────────────── run loop ───────────────────────────────

    async run(signal: AbortSignal): Promise<void> {
        if (this.deps.toolHeartbeatIntervalMs < 0) {
            throw new Error("tool heartbeat interval must not be negative");
        }

        await this.restore();

        const abortEvent = new Promise<LoopEvent>((resolve) => {
            if (signal.aborted) {
                resolve({ kind: "aborted" });
            } else {
                signal.addEventListener("abort", () => resolve({ kind: "aborted" }), { once: true });
            }
        });

        // Outside the try so `finally` can disarm it: with the real clock an armed heartbeat
        // (ten minutes) would keep a host's event loop alive after the run ended.
        let heartbeat: TimerHandle | null = null;

        try {
            let statuses = await this.scheduleToolCalls();
            await this.reconcileToolCalls();
            await this.dispatchOperationsToManager();

            if (toolCallStatusesRequireModelResponse(statuses) || this.pendingInputs() > 0) {
                await this.requestModelResponse(signal);
            }

            statuses = [];
            // Read once, like Go's `inboxOutput := ...Inbox.Output()` before the loop: a dependency
            // swapped mid-run (the heartbeat submission-failure test does it) must not change what
            // the select waits on. Only the slurp in processEvents re-reads the dependency.
            const inboxQueue = this.deps.inbox.outputQueue();
            const updateQueue = this.deps.operations.updates();

            while (true) {
                if (!this.isWaitingForOnlyToolCalls()) {
                    heartbeat?.controller.abort();
                    heartbeat = null;
                } else if (heartbeat === null && this.deps.toolHeartbeatIntervalMs > 0) {
                    heartbeat = this.startTimer(this.deps.toolHeartbeatIntervalMs, "heartbeat");
                }

                // Like Go's select, the race must not CONSUME from a losing channel: it waits on
                // "something is queued" and the winner takes its item synchronously afterwards,
                // so the slurp that follows still sees everything else that arrived.
                const raceScope = new AbortController();
                const sources: Array<Promise<LoopEvent | null>> = [
                    abortEvent,
                    inboxQueue.available(raceScope.signal).then(() => ({ kind: "input" }) as LoopEvent),
                    updateQueue.available(raceScope.signal).then(() => ({ kind: "operation" }) as LoopEvent),
                ];

                if (heartbeat && !heartbeat.fired) {
                    sources.push(heartbeat.promise);
                }

                if (this.grace && !this.grace.fired) {
                    sources.push(this.grace.promise);
                }

                if (this.modelCall) {
                    sources.push(this.modelCall.promise);
                }

                const event = await Promise.race(sources);
                raceScope.abort();

                if (event === null) {
                    continue;
                }

                switch (event.kind) {
                    case "aborted":
                        throw signal.reason ?? new Error("aborted");
                    case "input": {
                        const input = inboxQueue.tryTake();

                        if (input === undefined) {
                            if (inboxQueue.closed) {
                                throw this.closedInputError(signal, "inbox output");
                            }

                            continue;
                        }

                        await this.processInputs([input]);
                        break;
                    }
                    case "operation": {
                        const update = updateQueue.tryTake();

                        if (update === undefined) {
                            if (updateQueue.closed) {
                                throw this.closedInputError(signal, "operation updates");
                            }

                            continue;
                        }

                        await this.processOperations([update]);
                        break;
                    }
                    case "heartbeat":
                        if (heartbeat) {
                            heartbeat.fired = true;
                        }

                        await this.postHeartbeat(signal);
                        break;
                    case "grace":
                        this.clearToolGrace();
                        break;
                    case "model":
                        if (
                            this.modelCall === null ||
                            event.call !== this.modelCall ||
                            event.call.turnID !== this.currentTurnID
                        ) {
                            continue;
                        }

                        await this.processModelResponse(signal, event);
                        break;
                }

                const callModel = await this.processEvents(signal);

                if (this.stopRequest?.Mode === "hard") {
                    const stopped = await this.handleStop();

                    if (stopped) {
                        if (signal.aborted) {
                            throw signal.reason ?? new Error("aborted");
                        }

                        return;
                    }

                    continue;
                }

                if (callModel) {
                    await this.requestModelResponse(signal);
                    this.clearToolGrace();
                }

                if (this.stopRequest?.Mode === "when_idle" && this.isIdle()) {
                    if (signal.aborted) {
                        throw signal.reason ?? new Error("aborted");
                    }

                    return;
                }
            }
        } finally {
            heartbeat?.controller.abort();
            this.interruptModel();
            this.clearToolGrace();
        }
    }

    private startTimer(ms: number, kind: "heartbeat" | "grace"): TimerHandle {
        const controller = new AbortController();
        const handle: TimerHandle = {
            controller,
            fired: false,
            promise: this.clock.sleep(ms, controller.signal).then(
                () => ({ kind }) as LoopEvent,
                () => null
            ),
        };
        return handle;
    }

    private async processEvents(signal: AbortSignal): Promise<boolean> {
        const inputs = await this.slurp(this.deps.inbox.outputQueue(), signal, "slurp inbox");
        await this.processInputs(inputs);
        const updates = await this.slurp(this.deps.operations.updates(), signal, "slurp operation updates");
        await this.processOperations(updates);
        await this.reconcileToolCalls();
        return (
            this.callModel || (this.pendingInputs() > 0 && this.modelCall === null && this.graceToolCalls.size === 0)
        );
    }

    /** Drain what is queued now, then keep draining while items keep arriving within the idle window. */
    private async slurp<T>(queue: AsyncQueue<T>, signal: AbortSignal, what: string): Promise<T[]> {
        const items: T[] = [];

        while (items.length < SLURP_MAX_ITEMS) {
            if (signal.aborted) {
                throw wrap(what, signal.reason ?? new Error("aborted"));
            }

            const item = queue.tryTake();

            if (item !== undefined) {
                items.push(item);
                continue;
            }

            if (queue.closed) {
                return items;
            }

            // Go's select also watches ctx.Done() here; the run signal ends the idle wait too.
            const idle = new AbortController();
            const stopIdle = () => idle.abort();
            signal.addEventListener("abort", stopIdle, { once: true });
            const arrived = await Promise.race([
                queue.available(idle.signal).then(() => true),
                this.clock.sleep(SLURP_IDLE_MS, idle.signal).then(
                    () => false,
                    () => false
                ),
            ]);
            signal.removeEventListener("abort", stopIdle);
            idle.abort();

            if (signal.aborted) {
                throw wrap(what, signal.reason ?? new Error("aborted"));
            }

            if (!arrived) {
                return items;
            }
        }

        return items;
    }

    private async processInputs(inputs: Input[]): Promise<void> {
        for (const input of inputs) {
            await this.handleInboxInput(input);

            if (input.Kind === "external") {
                this.callModel = true;
            }
        }
    }

    private async processOperations(updates: Operation[]): Promise<void> {
        for (const update of updates) {
            const stored = this.addOperationToLocalState(update);
            await this.storeOperationInSessionStore(stored);
        }
    }

    private async processModelResponse(
        signal: AbortSignal,
        event: Extract<LoopEvent, { kind: "model" }>
    ): Promise<void> {
        this.interruptModel();

        if (event.error !== undefined || event.response === undefined) {
            if (signal.aborted) {
                throw signal.reason ?? new Error("aborted");
            }

            throw wrap(`call model for turn "${event.call.turnID}"`, event.error);
        }

        const statuses = await this.handleModelResponse({ TurnID: event.call.turnID, Response: event.response });

        for (const status of statuses) {
            for (const operation of status.Operations ?? []) {
                await this.dispatchOperationToManager(operation);
            }
        }

        if (!this.callModel && statuses.length > 0) {
            for (const status of statuses) {
                this.graceToolCalls.add(keyOf(status.TurnID, status.CallID));
            }

            this.grace?.controller.abort();
            this.grace = this.startTimer(TOOL_CALL_RUN_GRACE_MS, "grace");
            this.graceGeneration++;
        }
    }

    private clearToolGrace(): void {
        this.graceToolCalls.clear();
        this.grace?.controller.abort();
        this.grace = null;
    }

    private async handleStop(): Promise<boolean> {
        if (!this.cancellationRequested) {
            this.interruptModel();
            await this.cancelOperations();
            this.cancellationRequested = true;
        }

        return !this.hasPendingOperations();
    }

    private isIdle(): boolean {
        return (
            this.modelCall === null &&
            this.pendingInputs() === 0 &&
            this.toolCalls.size === 0 &&
            !this.hasPendingOperations()
        );
    }

    private isWaitingForOnlyToolCalls(): boolean {
        return (
            this.modelCall === null &&
            this.stopRequest?.Mode !== "hard" &&
            this.pendingInputs() === 0 &&
            this.toolCalls.size !== 0
        );
    }

    private async postHeartbeat(signal: AbortSignal): Promise<void> {
        const calls = [...this.toolCalls.values()]
            .map((call) => ({
                CallID: call.toolCall.CallID,
                Name: call.toolCall.Name,
                Arguments: call.toolCall.Arguments,
            }))
            .sort((a, b) => (a.CallID < b.CallID ? -1 : a.CallID > b.CallID ? 1 : 0));
        const seconds = this.deps.toolHeartbeatIntervalMs / 1000;
        const message: ControlMessage = {
            Mode: "heartbeat",
            Reason: `Heartbeat: waited ${seconds} seconds for tool calls.\nRunning: ${SafeJSON.stringify(calls, { strict: true })}`,
        };
        await this.deps.inbox.submit(
            { ID: this.newID(), Kind: "control", Payload: SafeJSON.stringify(message, { strict: true }) },
            signal
        );
    }

    private interruptModel(): void {
        if (this.modelCall) {
            this.modelCall.controller.abort();
            this.modelCall = null;
        }
    }

    private acceptStop(request: ControlMessage): void {
        if (this.stopRequest?.Mode === "hard") {
            return;
        }

        this.stopRequest = request;
    }

    private pendingInputs(): number {
        return this.availableInputs - this.deliveredInputs;
    }

    private hasPendingOperations(): boolean {
        for (const operation of this.operations.values()) {
            if (!isTerminal(operation.Status)) {
                return true;
            }
        }

        return false;
    }

    private async cancelOperations(): Promise<void> {
        const failures: Error[] = [];

        for (const [id, operation] of this.operations) {
            if (isTerminal(operation.Status)) {
                continue;
            }

            try {
                await this.deps.operations.cancel(id, this.stopRequest?.Reason ?? "");
            } catch (error) {
                failures.push(wrap(`cancel operation "${id}"`, error));
            }
        }

        // Go's errors.Join keeps every wrapped error reachable by errors.Is; the cause chain
        // and the AggregateError list carry the same information here.
        if (failures.length > 0) {
            throw new AggregateError(failures, failures.map((failure) => failure.message).join("\n"), {
                cause: failures[0],
            });
        }
    }

    private async requestModelResponse(signal: AbortSignal): Promise<void> {
        this.interruptModel();
        let built: Request;

        try {
            built = this.deps.contextBuilder.build().Request;
        } catch (error) {
            throw wrap("build model request", error);
        }

        const turn: Turn = { ID: this.newID(), PreviousTurnID: this.currentTurnID, Type: "regular" };
        const item = this.addItemToLocalState({ Kind: "turn", Data: turn });
        await this.storeItemInSessionStore(item);

        const controller = new AbortController();
        const forward = () => controller.abort(signal.reason);
        signal.addEventListener("abort", forward, { once: true });
        const call: ModelCall = { turnID: turn.ID, controller, promise: Promise.resolve({ kind: "aborted" }) };
        call.promise = this.deps.llm
            .respond(built, { CacheKey: this.deps.sessionID }, controller.signal)
            .then(
                (response) => ({ kind: "model", call, response }) as LoopEvent,
                (error) => ({ kind: "model", call, error }) as LoopEvent
            )
            .finally(() => signal.removeEventListener("abort", forward));
        this.modelCall = call;
        this.callModel = false;
    }

    private async handleInboxInput(input: Input): Promise<void> {
        const item = this.addItemToLocalState({ Kind: "input", Data: input });
        await this.storeItemInSessionStore(item);

        if (input.Kind === "control") {
            const request = decodeControlMessage(input);

            switch (request.Mode) {
                case "settings":
                    return;
                case "hard":
                case "when_idle":
                    this.acceptStop(request);
                    break;
                default:
                    break;
            }
        }

        this.clearToolGrace();
    }

    private async handleModelResponse(response: ModelResponse): Promise<ToolCallStatus[]> {
        const item = this.addItemToLocalState({ Kind: "model_response", Data: response });
        await this.storeItemInSessionStore(item);

        if (this.currentTurnType === "compaction" && response.TurnID === this.currentTurnID) {
            return [];
        }

        const statuses = await this.scheduleToolCalls();
        this.callModel = toolCallStatusesRequireModelResponse(statuses);
        return statuses;
    }

    // ─────────────────────────────── restore ───────────────────────────────

    private async restore(): Promise<void> {
        await this.loadHistory();

        for (const operation of this.deps.restored.Operations) {
            this.addOperationToLocalState(operation);
        }
    }

    private async loadHistory(): Promise<void> {
        let after = BEFORE_FIRST;

        while (true) {
            let page: Awaited<ReturnType<Store["items"]>>;

            try {
                page = await this.deps.sessions.items(this.deps.sessionID, after, HISTORY_PAGE_SIZE);
            } catch (error) {
                throw wrap(`load session history after ${after}`, error);
            }

            for (const item of page.Items) {
                try {
                    this.restoreItem(item);
                } catch (error) {
                    throw wrap(`load session item ${item.Sequence ?? 0}`, error);
                }
            }

            if (!page.More) {
                return;
            }

            if (page.NextAfter <= after) {
                throw new Error(`load session history did not advance after ${after}`);
            }

            after = page.NextAfter;
        }
    }

    private restoreItem(item: Item): void {
        assertItemData(item);

        if (item.Kind === "tool_call_status" && toolCallRequiresTranslator(item.Data)) {
            const call = this.toolCalls.get(keyOf(item.Data.TurnID, item.Data.CallID));

            if (call && !this.deps.tools.resolve(call.toolCall.Name)) {
                throw new Error(
                    `tool "${call.toolCall.Name}" required by recorded call "${item.Data.CallID}" is not available`
                );
            }
        }

        this.addItemToLocalState(item);
    }

    // ─────────────────────────────── local state ───────────────────────────────

    private addItemToLocalState(item: Item): Item {
        // Go asserts the concrete Data type per kind; a session written by another writer can carry
        // the wrong one, so the port checks the shape at runtime with the same "want" wording.
        assertItemData(item);

        switch (item.Kind) {
            case "fork":
                // Upstream marks this unfinished (loop.go "FIXME"): forks leave inherited calls without results and
                // retain pending-input accounting. Kept as is for parity; fix it upstream first.
                this.toolCalls.clear();
                this.operations.clear();
                this.clearToolGrace();
                break;

            case "input": {
                const input = item.Data;

                try {
                    validateInput(input);
                } catch (error) {
                    throw wrap("invalid input", error);
                }

                if (input.Kind === "external") {
                    try {
                        this.deps.contextBuilder.addExternalInput(input);
                    } catch (error) {
                        throw wrap(`add input "${input.ID}" to context`, error);
                    }

                    this.availableInputs++;
                }

                if (input.Kind === "control") {
                    const request = decodeControlMessage(input);
                    this.deps.contextBuilder.addControlMessage(request);

                    if (request.Mode === "heartbeat") {
                        this.availableInputs++;
                    }
                }

                break;
            }

            case "turn":
                this.currentTurnID = item.Data.ID;
                this.currentTurnType = item.Data.Type;
                this.currentTurnInputs = this.availableInputs;
                this.deps.contextBuilder.commit();
                break;

            case "model_response": {
                const response = item.Data;

                if (this.currentTurnType === "compaction" && response.TurnID === this.currentTurnID) {
                    return item;
                }

                this.deps.contextBuilder.addModelResponse(response.Response);

                if (response.TurnID === this.currentTurnID) {
                    this.deliveredInputs = this.currentTurnInputs;
                }

                this.addToolCallsToLocalState(response);
                break;
            }

            case "tool_call_status": {
                const status = item.Data;

                for (const operation of status.Operations ?? []) {
                    this.addOperationToLocalState(operation);
                }

                this.addToolCallOperationsToLocalState(status);
                this.addToolResultToLocalState(status);
                break;
            }

            default:
                throw new Error(`unsupported item kind "${String((item as { Kind: unknown }).Kind)}"`);
        }

        return item;
    }

    private addToolCallsToLocalState(response: ModelResponse): void {
        for (const output of response.Response.Output ?? []) {
            if (output.Type !== "tool_call") {
                continue;
            }

            this.toolCalls.set(keyOf(response.TurnID, output.Data.CallID), {
                toolCall: output.Data,
                operations: new Set(),
            });
        }
    }

    private addToolCallOperationsToLocalState(status: ToolCallStatus): void {
        const call = this.toolCalls.get(keyOf(status.TurnID, status.CallID));

        if (!call) {
            return;
        }

        call.status = { ...status.Status };

        for (const id of status.Status.WaitingFor ?? []) {
            call.operations.add(id);
        }
    }

    private finishToolCall(turnID: TurnID, callID: string): void {
        const key = keyOf(turnID, callID);
        this.toolCalls.delete(key);
        this.graceToolCalls.delete(key);

        if (this.graceToolCalls.size === 0) {
            this.clearToolGrace();
        }

        this.availableInputs++;
    }

    private toolCallOperationsAreTerminal(turnID: TurnID, callID: string): boolean {
        const call = this.toolCalls.get(keyOf(turnID, callID));

        for (const id of call?.operations ?? []) {
            const operation = this.operations.get(id);

            if (!operation || !isTerminal(operation.Status)) {
                return false;
            }
        }

        return true;
    }

    private addToolResultToLocalState(status: ToolCallStatus): void {
        const call = this.toolCalls.get(keyOf(status.TurnID, status.CallID));

        if (!call) {
            return;
        }

        const translator = this.deps.tools.resolve(call.toolCall.Name);

        if (!translator) {
            if (!toolCallRequiresTranslator(status)) {
                this.deps.contextBuilder.addToolResult(
                    status.CallID,
                    [{ Kind: "text", Value: status.Status.Error }],
                    false
                );
                this.finishToolCall(status.TurnID, status.CallID);
            }

            return;
        }

        const operations: Operation[] = [];

        for (const id of status.Status.WaitingFor ?? []) {
            if (!call.operations.has(id)) {
                return;
            }

            const operation = this.operations.get(id);

            if (!operation) {
                return;
            }

            operations.push(operation);
        }

        let result: ReturnType<typeof translator.translateResult>;

        try {
            result = translator.translateResult(status.CallID, status.Status, operations);
        } catch (error) {
            throw wrap(`add tool call "${status.CallID}" result to context`, error);
        }

        const running = !this.toolCallOperationsAreTerminal(status.TurnID, status.CallID);
        this.deps.contextBuilder.addToolResult(status.CallID, result.Output, running);

        if (!running) {
            this.finishToolCall(status.TurnID, status.CallID);
        }
    }

    private addOperationToLocalState(operation: Operation): Operation {
        this.operations.set(operation.ID, operation);
        return operation;
    }

    // ─────────────────────────────── scheduling ───────────────────────────────

    private async scheduleToolCalls(): Promise<ToolCallStatus[]> {
        const statuses: ToolCallStatus[] = [];

        for (const [key, call] of [...this.toolCalls]) {
            if (call.status !== undefined) {
                continue;
            }

            statuses.push(await this.scheduleToolCall(splitKey(key), call.toolCall));
        }

        return statuses;
    }

    private async scheduleToolCall(key: ToolCallKey, call: ToolCall): Promise<ToolCallStatus> {
        const translator = this.deps.tools.resolve(call.Name);
        const context = new ToolCallContext(this.newID);
        const status = translator
            ? translator.translate(context, call)
            : errorStatus(`tool "${call.Name}" is not available`, 0);
        const operations = context.operations.map((operation) => this.addOperationToLocalState(operation));
        const toolCallStatus: ToolCallStatus = {
            TurnID: key.turnID,
            CallID: key.callID,
            Status: status,
            Operations: operations,
        };
        const item = this.addItemToLocalState({ Kind: "tool_call_status", Data: toolCallStatus });
        await this.storeItemInSessionStore(item);
        return toolCallStatus;
    }

    private async reconcileToolCalls(): Promise<ToolCallStatus[]> {
        const completed: ToolCallStatus[] = [];

        for (const key of [...this.toolCalls.keys()]) {
            const { turnID, callID } = splitKey(key);

            if (!this.toolCallOperationsAreTerminal(turnID, callID)) {
                continue;
            }

            const call = this.toolCalls.get(key);

            if (!call?.status) {
                throw new Error(`reconcile untranslated tool call "${callID}" in turn "${turnID}"`);
            }

            const operations = (call.status.WaitingFor ?? [])
                .map((id) => this.operations.get(id))
                .filter((operation): operation is Operation => operation !== undefined);
            const status: ToolCallStatus = {
                TurnID: turnID,
                CallID: callID,
                Status: { ...call.status },
                Operations: operations,
            };
            const item = this.addItemToLocalState({ Kind: "tool_call_status", Data: status });
            await this.storeItemInSessionStore(item);

            if (!this.toolCalls.has(key)) {
                completed.push(status);
            }
        }

        return completed;
    }

    // ─────────────────────────────── persistence ───────────────────────────────

    private async storeItemInSessionStore(item: Item): Promise<void> {
        const sessions = this.deps.sessions;
        const id = this.deps.sessionID;

        switch (item.Kind) {
            case "input":
                await sessions.appendInput(id, item.Data).catch((error) => {
                    throw wrap(`store input "${item.Data.ID}"`, error);
                });
                break;
            case "turn":
                await sessions.appendTurn(id, item.Data).catch((error) => {
                    throw wrap(`store turn "${item.Data.ID}"`, error);
                });
                break;
            case "model_response":
                await sessions.appendModelResponse(id, item.Data).catch((error) => {
                    throw wrap(`store turn "${item.Data.TurnID}" response`, error);
                });
                break;
            case "tool_call_status":
                await sessions.appendToolCallStatus(id, item.Data).catch((error) => {
                    throw wrap(`store tool call "${item.Data.CallID}" status`, error);
                });
                break;
            default:
                throw new Error(`unsupported local item kind "${item.Kind}"`);
        }
    }

    private async storeOperationInSessionStore(operation: Operation): Promise<void> {
        await this.deps.sessions.saveOperation(this.deps.sessionID, operation).catch((error) => {
            throw wrap(`store operation "${operation.ID}"`, error);
        });
    }

    private async dispatchOperationsToManager(): Promise<void> {
        for (const operation of this.operations.values()) {
            await this.dispatchOperationToManager(operation);
        }
    }

    private async dispatchOperationToManager(operation: Operation): Promise<void> {
        if (isTerminal(operation.Status)) {
            return;
        }

        try {
            await this.deps.operations.add({ ...operation });
        } catch (error) {
            throw wrap(`dispatch operation "${operation.ID}"`, error);
        }
    }

    private closedInputError(signal: AbortSignal, name: string): Error {
        if (signal.aborted) {
            return signal.reason instanceof Error ? signal.reason : new Error(String(signal.reason ?? "aborted"));
        }

        return new Error(`${name} closed`);
    }
}

export interface ToolCallStateView {
    turnID: TurnID;
    callID: string;
    toolCall: ToolCall;
    status?: CallStatus;
    operations: OperationID[];
}

/**
 * The white-box surface the Go tests use through `run.current.state`, `run.current.cancelModel`
 * and direct calls such as `current.restore(ctx)` or `current.addItemToLocalState(item)`.
 * Production code never needs it; it exists so the twins stay 1:1 with the Go corpus.
 */
export interface CoordinatorInternals {
    readonly currentTurnID: TurnID;
    readonly currentTurnType: TurnType;
    setCurrentTurnType(type: TurnType): void;
    readonly currentTurnInputs: number;
    readonly deliveredInputs: number;
    readonly availableInputs: number;
    readonly stopMode: string | null;
    /** True while a model request is in flight (Go: `cancelModel != nil`). */
    readonly modelActive: boolean;
    /** True while a tool grace timer is armed (Go: `state.grace != nil`). */
    readonly graceActive: boolean;
    /** How many grace timers were armed so far; equal values mean the same timer (Go: channel identity). */
    readonly graceGeneration: number;
    /** Go `state.callModel`, readable and settable for the replay tests. */
    callModel: boolean;
    graceToolCallKeys(): Array<{ turnID: TurnID; callID: string }>;
    toolCallStates(): ToolCallStateView[];
    operationStates(): Map<OperationID, Operation>;
    pendingInputs(): number;
    restore(): Promise<void>;
    loadHistory(): Promise<void>;
    addItemToLocalState(item: Item): Item;
    handleModelResponse(response: ModelResponse): Promise<ToolCallStatus[]>;
    handleOperationUpdate(update: Operation): Promise<void>;
    scheduleToolCalls(): Promise<ToolCallStatus[]>;
    reconcileToolCalls(): Promise<ToolCallStatus[]>;
    dispatchOperationsToManager(): Promise<void>;
    toolCallOperationsAreTerminal(turnID: TurnID, callID: string): boolean;
    addToolResultToLocalState(status: ToolCallStatus): void;
    addOperationToLocalState(operation: Operation): Operation;
    addToolCallsToLocalState(response: ModelResponse): void;
    storeItemInSessionStore(item: Item): Promise<void>;
    /** Go's package-level `closedInputError(ctx, name)`. */
    closedInputError(signal: AbortSignal, name: string): Error;
}

const INTERNALS = Symbol("coordinator internals");

export function coordinatorInternals(coordinator: Coordinator): CoordinatorInternals {
    const carrier = coordinator as unknown as Record<symbol, (() => CoordinatorInternals) | undefined>;
    const accessor = carrier[INTERNALS];

    if (!accessor) {
        throw new Error("not a harness coordinator");
    }

    return accessor();
}

/** Attaches a white-box view to another Coordinator implementation (the Go oracle wrapper). */
export function provideCoordinatorInternals(coordinator: Coordinator, accessor: () => CoordinatorInternals): void {
    Object.defineProperty(coordinator, INTERNALS, { value: accessor, enumerable: false });
}

export function newCoordinator(deps: Dependencies): Coordinator {
    const impl = new CoordinatorImpl(deps);
    provideCoordinatorInternals(impl, () => impl.internals());
    return impl;
}
