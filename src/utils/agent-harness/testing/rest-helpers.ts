// Helpers for the settings, delivery, recovery, fork, unavailable-tool and stop-integration twins.
//
// `LocalStore` is an in-memory twin of the Go `sessionstore/localfile.Store` RULES (turn chain,
// owned turns, first-append operation initialization, Resume filtering, Fork inheritance,
// observers). It does not write the JSONL file format; the Go tests only rely on the rules,
// and "reopening" a directory is modelled by reusing the same instance, whose reads return
// deep copies the way a decode would.

import { SafeJSON } from "@genesiscz/utils/json";
import type { Builder, BuildResult } from "../contextbuilder";
import type { CoordinatorInternals } from "../coordinator";
import { type ControlMessage, type Input, type InputID, type Settings, validateInput } from "../inbox";
import type { Model, Reasoning, Response, Tool, ToolResultOutput } from "../llm";
import { isTerminal, type Operation, type OperationID, UnsupportedOperationError } from "../operation";
import type {
    Fork,
    Item,
    ModelResponse,
    Page,
    ResumeState,
    Sequence,
    SessionID,
    Store,
    ToolCallStatus,
    Turn,
    TurnID,
} from "../sessionstore";
import type { CallStatus } from "../tool";
import { FakeOperationManager, type StopTestRun } from "./driver";

// ─────────────────────────────── inputs ───────────────────────────────

/** `settingsInput(t, id, settings)`: Go marshals `ControlMessage{Mode, Reason: "", Parameters}`. */
export function settingsInput(id: InputID, settings: Settings): Input {
    const message: ControlMessage = { Mode: "settings", Reason: "", Parameters: settings };
    return { ID: id, Kind: "control", Payload: SafeJSON.stringify(message, { strict: true }) };
}

// ─────────────────────────────── errors ───────────────────────────────

/** `errors.Is(err, want)`: walks the `cause` chain. */
export function errorIs(error: unknown, want: unknown): boolean {
    let current: unknown = error;

    for (let depth = 0; depth < 32 && current !== undefined && current !== null; depth++) {
        if (current === want) {
            return true;
        }

        current = current instanceof Error ? current.cause : undefined;
    }

    return false;
}

/** `errors.Is(err, sentinel)` for a sentinel TypeScript models as an error class. */
export function errorChainHas(error: unknown, predicate: (candidate: Error) => boolean): boolean {
    let current: unknown = error;

    for (let depth = 0; depth < 32 && current instanceof Error; depth++) {
        if (predicate(current)) {
            return true;
        }

        current = current.cause;
    }

    return false;
}

// ─────────────────────────────── item narrowing ───────────────────────────────

export function turnAt(items: Item[], index: number): Turn {
    const item = items[index];

    if (item?.Kind !== "turn") {
        throw new Error(`item ${index} is ${item?.Kind ?? "missing"}, want turn`);
    }

    return item.Data;
}

export function responseAt(items: Item[], index: number): ModelResponse {
    const item = items[index];

    if (item?.Kind !== "model_response") {
        throw new Error(`item ${index} is ${item?.Kind ?? "missing"}, want model_response`);
    }

    return item.Data;
}

export function statusAt(items: Item[], index: number): ToolCallStatus {
    const item = items[index];

    if (item?.Kind !== "tool_call_status") {
        throw new Error(`item ${index} is ${item?.Kind ?? "missing"}, want tool_call_status`);
    }

    return item.Data;
}

// ─────────────────────────────── local file store twin ───────────────────────────────

export type Observer = (id: SessionID, item: Item) => void;

interface SessionHead {
    operations: Operation[];
    positions: Map<OperationID, number>;
    itemSequence: Sequence;
    latestTurnID: TurnID;
    turns: Set<TurnID>;
    ownedTurns: Set<TurnID>;
    respondedTurns: Set<TurnID>;
    toolCallStatuses: Set<string>;
}

interface StoredState {
    id: SessionID;
    createdAt: string;
    head: SessionHead;
    items: Item[];
}

function newHead(): SessionHead {
    return {
        operations: [],
        positions: new Map(),
        itemSequence: 0,
        latestTurnID: "",
        turns: new Set(),
        ownedTurns: new Set(),
        respondedTurns: new Set(),
        toolCallStatuses: new Set(),
    };
}

function statusKey(turnID: TurnID, callID: string): string {
    return `${turnID}\u0000${callID}`;
}

function clone<T>(value: T): T {
    return structuredClone(value);
}

function validateOperation(value: Operation): void {
    if (!value.ID) {
        throw new Error("operation ID is empty");
    }

    if (!value.Type) {
        throw new Error(`operation "${value.ID}" type is empty`);
    }

    if (value.Version === 0) {
        throw new Error(`operation "${value.ID}" version is zero`);
    }

    const statuses = ["ready", "awaiting", "canceling", "completed", "failed", "canceled"];

    if (!statuses.includes(value.Status)) {
        throw new Error(`operation "${value.ID}" has unsupported status "${value.Status}"`);
    }
}

function validateStatusOperationReferences(status: CallStatus, operations: Operation[]): void {
    const waitingFor = status.WaitingFor ?? [];

    if (status.Error !== "") {
        if (waitingFor.length !== 0) {
            throw new Error("error status cannot wait for operations");
        }

        if (operations.length !== 0) {
            throw new Error("error status cannot initialize operations");
        }

        return;
    }

    if (operations.length === 0) {
        throw new Error("successful status must initialize at least one operation");
    }

    if (waitingFor.length !== operations.length) {
        throw new Error(`status waits for ${waitingFor.length} operations, initialized ${operations.length}`);
    }

    const initialized = new Set(operations.map((operation) => operation.ID));
    const waiting = new Set<OperationID>();

    for (const id of waitingFor) {
        if (waiting.has(id)) {
            throw new Error(`status repeats operation "${id}"`);
        }

        waiting.add(id);

        if (!initialized.has(id)) {
            throw new Error(`status waits for operation "${id}" that was not initialized`);
        }
    }
}

export class LocalStore implements Store {
    private readonly sessions = new Map<SessionID, StoredState>();
    private readonly observers = new Map<number, Observer>();
    private nextObserver = 0;

    constructor(private readonly now: () => string = () => "2026-09-23T00:00:00.000Z") {}

    addObserver(observer: Observer): number {
        const id = ++this.nextObserver;
        this.observers.set(id, observer);
        return id;
    }

    removeObserver(id: number): void {
        this.observers.delete(id);
    }

    async create(id: SessionID): Promise<void> {
        if (!id) {
            throw new Error("session ID is empty");
        }

        if (this.sessions.has(id)) {
            throw new Error(`create session "${id}": file already exists`);
        }

        this.sessions.set(id, { id, createdAt: this.now(), head: newHead(), items: [] });
    }

    private read(id: SessionID): StoredState {
        const state = this.sessions.get(id);

        if (!state) {
            throw new Error(`read session "${id}": no such file or directory`);
        }

        return state;
    }

    private appendItem(state: StoredState, item: Item): Item {
        state.head.itemSequence++;
        const stored = clone({ ...item, Sequence: state.head.itemSequence, RecordedAt: this.now() });
        state.items.push(stored);
        return stored;
    }

    private notify(id: SessionID, item: Item): void {
        for (const observer of [...this.observers.values()]) {
            observer(id, clone(item));
        }
    }

    async items(id: SessionID, after: Sequence, limit: number): Promise<Page> {
        if (limit <= 0) {
            throw new Error("item page limit must be positive");
        }

        const state = this.read(id);
        const start = Math.min(after, state.items.length);
        const end = Math.min(start + limit, state.items.length);
        const items = clone(state.items.slice(start, end));
        return {
            Items: items,
            NextAfter: items.length > 0 ? (items[items.length - 1].Sequence ?? after) : after,
            More: end < state.items.length,
        };
    }

    async appendInput(id: SessionID, input: Input): Promise<void> {
        const state = this.read(id);

        try {
            validateInput(input);
        } catch (error) {
            throw new Error(`append input to session "${id}": ${String(error)}`, { cause: error });
        }

        this.notify(id, this.appendItem(state, { Kind: "input", Data: input }));
    }

    async appendTurn(id: SessionID, turn: Turn): Promise<void> {
        const state = this.read(id);
        const head = state.head;

        if (!turn.ID) {
            throw new Error(`append turn to session "${id}": turn ID is empty`);
        }

        if (turn.PreviousTurnID !== head.latestTurnID) {
            throw new Error(
                `append turn "${turn.ID}" to session "${id}": previous turn is "${turn.PreviousTurnID}", want "${head.latestTurnID}"`
            );
        }

        if (head.turns.has(turn.ID)) {
            throw new Error(`append turn "${turn.ID}": file already exists`);
        }

        head.turns.add(turn.ID);
        head.ownedTurns.add(turn.ID);
        head.latestTurnID = turn.ID;
        this.notify(id, this.appendItem(state, { Kind: "turn", Data: turn }));
    }

    async appendModelResponse(id: SessionID, response: ModelResponse): Promise<void> {
        const state = this.read(id);
        const head = state.head;

        if (!head.ownedTurns.has(response.TurnID)) {
            throw new Error(
                `append model response to session "${id}" for turn "${response.TurnID}": file does not exist`
            );
        }

        if (head.respondedTurns.has(response.TurnID)) {
            throw new Error(`append model response for turn "${response.TurnID}": file already exists`);
        }

        head.respondedTurns.add(response.TurnID);
        this.notify(id, this.appendItem(state, { Kind: "model_response", Data: response }));
    }

    async appendToolCallStatus(id: SessionID, status: ToolCallStatus): Promise<void> {
        const state = this.read(id);
        const head = state.head;
        const operations = status.Operations ?? [];

        if (!head.ownedTurns.has(status.TurnID)) {
            throw new Error(
                `append tool-call status to session "${id}" for turn "${status.TurnID}": file does not exist`
            );
        }

        if (!status.CallID) {
            throw new Error(`append tool-call status for turn "${status.TurnID}": call ID is empty`);
        }

        const key = statusKey(status.TurnID, status.CallID);

        if (!head.toolCallStatuses.has(key)) {
            const seen = new Set<OperationID>();

            for (const [index, value] of operations.entries()) {
                try {
                    validateOperation(value);
                } catch (error) {
                    throw new Error(`initialize operation ${index}: ${String(error)}`, { cause: error });
                }

                if (seen.has(value.ID) || head.positions.has(value.ID)) {
                    throw new Error(`initialize operation "${value.ID}": file already exists`);
                }

                seen.add(value.ID);
            }

            validateStatusOperationReferences(status.Status, operations);
            head.toolCallStatuses.add(key);

            for (const value of operations) {
                head.positions.set(value.ID, head.operations.length);
                head.operations.push(clone(value));
            }
        }

        // `ToolCallStatus.Operations` is `omitempty`, so an empty list does not survive a decode.
        const data: ToolCallStatus =
            operations.length > 0 ? { ...status, Operations: operations } : withoutOperations(status);
        this.notify(id, this.appendItem(state, { Kind: "tool_call_status", Data: data }));
    }

    async saveOperation(id: SessionID, operation: Operation): Promise<void> {
        validateOperation(operation);
        const head = this.read(id).head;
        const index = head.positions.get(operation.ID);

        if (index === undefined) {
            throw new Error(`save operation "${operation.ID}" in session "${id}": file does not exist`);
        }

        const existing = head.operations[index];

        if (existing.Type !== operation.Type || existing.Version !== operation.Version) {
            throw new Error(`save operation "${operation.ID}": type and version cannot change`);
        }

        head.operations[index] = clone(operation);
    }

    /** `storedState.resume()`: unfinished operations plus terminal states missing from tool-call history. */
    async resume(id: SessionID): Promise<ResumeState> {
        const state = this.read(id);
        const externalInputIDs: InputID[] = [];
        const pending = new Set<OperationID>();

        for (const item of state.items) {
            if (item.Kind === "input" && item.Data.Kind === "external") {
                externalInputIDs.push(item.Data.ID);
            }

            if (item.Kind === "tool_call_status") {
                for (const value of item.Data.Operations ?? []) {
                    if (isTerminal(value.Status)) {
                        pending.delete(value.ID);
                    } else {
                        pending.add(value.ID);
                    }
                }
            }
        }

        const operations = state.head.operations.filter((value) => !isTerminal(value.Status) || pending.has(value.ID));
        return {
            Snapshot: { Session: { ID: state.id, CreatedAt: state.createdAt } },
            Operations: clone(operations),
            ExternalInputIDs: externalInputIDs,
        };
    }

    /** `forkStoredState`: inherit the parent up to `previousTurnID`, then append a fork item. */
    async fork(id: SessionID, parentID: SessionID, previousTurnID: TurnID): Promise<void> {
        if (!id) {
            throw new Error("session ID is empty");
        }

        if (id === parentID) {
            throw new Error(`fork session "${id}" onto itself`);
        }

        const parent = this.read(parentID);
        let boundary = -1;

        for (const [index, item] of parent.items.entries()) {
            if (boundary >= 0 && item.Kind === "turn") {
                break;
            }

            if (
                (item.Kind === "turn" && item.Data.ID === previousTurnID) ||
                (item.Kind === "model_response" && item.Data.TurnID === previousTurnID) ||
                (item.Kind === "tool_call_status" && item.Data.TurnID === previousTurnID)
            ) {
                boundary = index;
            }
        }

        if (boundary < 0) {
            throw new Error(`fork session "${parentID}" at turn "${previousTurnID}": file does not exist`);
        }

        const state: StoredState = { id, createdAt: this.now(), head: newHead(), items: [] };

        for (const item of parent.items.slice(0, boundary + 1)) {
            inheritItem(state, clone(item));
        }

        const fork: Fork = { ParentID: parentID, PreviousTurnID: previousTurnID };
        const forkItem = this.appendItem(state, { Kind: "fork", Data: fork });
        resetOwnedState(state.head);
        this.sessions.set(id, state);
        this.notify(id, forkItem);
    }
}

function withoutOperations(status: ToolCallStatus): ToolCallStatus {
    const { Operations: _dropped, ...rest } = status;
    return rest;
}

function inheritItem(state: StoredState, item: Item): void {
    const head = state.head;
    head.itemSequence = item.Sequence ?? head.itemSequence;

    switch (item.Kind) {
        case "turn":
            head.turns.add(item.Data.ID);
            head.ownedTurns.add(item.Data.ID);
            head.latestTurnID = item.Data.ID;
            break;
        case "model_response":
            head.respondedTurns.add(item.Data.TurnID);
            break;
        case "tool_call_status":
            // Go: "TODO: Preserve status snapshots in forked history without making inherited operations dispatchable."
            item.Data = withoutOperations(item.Data);
            head.toolCallStatuses.add(statusKey(item.Data.TurnID, item.Data.CallID));
            break;
        case "fork":
            resetOwnedState(head);
            break;
        default:
            break;
    }

    state.items.push(item);
}

function resetOwnedState(head: SessionHead): void {
    head.ownedTurns = new Set();
    head.respondedTurns = new Set();
    head.toolCallStatuses = new Set();
    head.operations = [];
    head.positions = new Map();
}

/** `persistTestRun`: copy a `stopTestRun`'s fake history into a fresh local store. */
export async function persistTestRun(run: StopTestRun): Promise<LocalStore> {
    const store = new LocalStore();
    await store.create("session-1");
    await store.appendTurn("session-1", turnAt(run.store.items, 0));
    await store.appendModelResponse("session-1", responseAt(run.store.items, 1));

    for (let index = 2; index < run.store.items.length; index++) {
        await store.appendToolCallStatus("session-1", statusAt(run.store.items, index));
    }

    return store;
}

/**
 * `restoreTestRun`: `Sessions, Restored = store, store.Resume()`. `StopTestRun.start()` keeps a
 * `deps.restored` the test replaced, so the run starts with plain `run.start()`.
 */
export async function restoreTestRun(run: StopTestRun, store: Store): Promise<void> {
    run.deps.restored = await store.resume("session-1");
    run.deps.sessions = store;
}

/** `current.storeItemInSessionStore(ctx, item)` for a test that commits items itself. */
export async function storeItemInSessionStore(store: Store, id: SessionID, item: Item): Promise<void> {
    switch (item.Kind) {
        case "input":
            return store.appendInput(id, item.Data);
        case "turn":
            return store.appendTurn(id, item.Data);
        case "model_response":
            return store.appendModelResponse(id, item.Data);
        case "tool_call_status":
            return store.appendToolCallStatus(id, item.Data);
        default:
            throw new Error(`unsupported local item kind "${item.Kind}"`);
    }
}

/**
 * Go turn and operation ids are UUIDs, so a resumed run never collides with ids its parent
 * persisted. The driver's counter restarts at `id-1`, which the local store rejects as a
 * duplicate turn; a resumed run over a shared store gets its own prefix.
 */
export function prefixIDs(run: StopTestRun, prefix: string): void {
    let next = 0;
    run.deps.newID = () => `${prefix}-${++next}`;
}

// ─────────────────────────────── dependency stand-ins ───────────────────────────────

/** `recoveryFailureStore`: a store whose status or turn appends fail. */
export class RecoveryFailureStore implements Store {
    statusErr: Error | null = null;
    turnErr: Error | null = null;

    constructor(readonly inner: Store) {}

    items(id: SessionID, after: Sequence, limit: number): Promise<Page> {
        return this.inner.items(id, after, limit);
    }

    appendInput(id: SessionID, input: Input): Promise<void> {
        return this.inner.appendInput(id, input);
    }

    async appendTurn(id: SessionID, turn: Turn): Promise<void> {
        if (this.turnErr) {
            throw this.turnErr;
        }

        return this.inner.appendTurn(id, turn);
    }

    appendModelResponse(id: SessionID, response: ModelResponse): Promise<void> {
        return this.inner.appendModelResponse(id, response);
    }

    async appendToolCallStatus(id: SessionID, status: ToolCallStatus): Promise<void> {
        if (this.statusErr) {
            throw this.statusErr;
        }

        return this.inner.appendToolCallStatus(id, status);
    }

    saveOperation(id: SessionID, operation: Operation): Promise<void> {
        return this.inner.saveOperation(id, operation);
    }

    resume(id: SessionID): Promise<ResumeState> {
        return this.inner.resume(id);
    }
}

/** `failingBuilder{Builder, err}`: everything delegates except `Build`, which fails. */
export class FailingBuilder implements Builder {
    constructor(
        private readonly inner: Builder,
        private readonly error: Error
    ) {}

    addExternalInput(input: Input): void {
        this.inner.addExternalInput(input);
    }

    addControlMessage(request: ControlMessage): void {
        this.inner.addControlMessage(request);
    }

    setModel(model: Model): void {
        this.inner.setModel(model);
    }

    setSystemPrompt(prompt: string): void {
        this.inner.setSystemPrompt(prompt);
    }

    addModelResponse(response: Response): void {
        this.inner.addModelResponse(response);
    }

    addReasoning(reasoning: Reasoning): void {
        this.inner.addReasoning(reasoning);
    }

    addTool(tool: Tool): void {
        this.inner.addTool(tool);
    }

    addToolResult(callID: string, payload: ToolResultOutput[], running: boolean): void {
        this.inner.addToolResult(callID, payload, running);
    }

    commit(): void {
        this.inner.commit();
    }

    build(): BuildResult {
        throw this.error;
    }
}

/**
 * Stand-in for `operation.NewLocalOperationManager` in the one test that only needs its
 * rejection path: the local manager supports `value` and `skill_use` operations and rejects
 * every other type with `ErrUnsupported` (`advanceLocalOperation`, local_manager.go).
 */
export function newLocalManagerStandIn(): FakeOperationManager {
    const manager = new FakeOperationManager();
    manager.addError = (operation) => {
        if (operation.Type === "value" || operation.Type === "skill_use") {
            return null;
        }

        return new UnsupportedOperationError(
            `local operation manager does not support type "${operation.Type}": unsupported operation`
        );
    };
    return manager;
}

// ─────────────────────────────── state snapshots ───────────────────────────────

/**
 * The observable part of Go's `loopState`, for `reflect.DeepEqual(replayed.state, want)`.
 * `availableInputs` is derived: `pendingInputs()` is `availableInputs - deliveredInputs`.
 * `grace` (a channel in Go) is represented by armed-or-not plus the generation counter.
 */
export function stateSnapshot(internals: CoordinatorInternals) {
    const byKey = (a: { turnID: string; callID: string }, b: { turnID: string; callID: string }) =>
        `${a.turnID}\u0000${a.callID}`.localeCompare(`${b.turnID}\u0000${b.callID}`);
    return {
        currentTurnID: internals.currentTurnID,
        currentTurnType: internals.currentTurnType,
        currentTurnInputs: internals.currentTurnInputs,
        availableInputs: internals.pendingInputs() + internals.deliveredInputs,
        deliveredInputs: internals.deliveredInputs,
        toolCalls: internals
            .toolCallStates()
            .map((state) => ({ ...state, operations: [...state.operations].sort() }))
            .sort(byKey),
        operations: [...internals.operationStates().entries()].sort(([a], [b]) => a.localeCompare(b)),
        callModel: internals.callModel,
        graceActive: internals.graceActive,
        graceToolCalls: internals.graceToolCallKeys().sort(byKey),
    };
}
