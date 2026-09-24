// The TypeScript twin of the Go coordinator test harness: `stopTestRun`, `fakeStore`,
// `fakeOperationManager`, `fakeAdapter` and the helper functions the Go tests share
// (`externalEvent`, `stopInput`, `textResponse`, `assertStopResult`, `independentToolCalls`,
// the grace and heartbeat helpers). Names follow the Go ones so a ported test reads the same.
//
// Time is virtual (`VirtualClock`), standing in for `testing/synctest`: `settle()` is the
// `synctest.Wait(); synctest.Sleep(2*slurpIdleTimeout); synctest.Wait()` sequence every driver
// step ends with, and `sleep(ms)` is `synctest.Sleep`.

import { expect } from "bun:test";
import { SafeJSON } from "@genesiscz/utils/json";
import { AsyncQueue } from "../async-queue";
import { type Clock, drainTasks as drainPortTasks, realClock, VirtualClock } from "../clock";
import { type Builder, newBuilder } from "../contextbuilder";
import {
    type Coordinator,
    coordinatorInternals,
    type Dependencies,
    newCoordinator,
    SLURP_IDLE_MS,
} from "../coordinator";
import { type ControlMode, decodeControlMessage, Inbox, type Input } from "../inbox";
import type { Adapter, Item as Item2, Request, RequestOptions, Response, ToolCall, ToolResult } from "../llm";
import { isTerminal, type Manager, type Operation, type OperationID, type Spec, type Status } from "../operation";
import { isOracleMode, newGoCoordinator, settleLiveGoCoordinators } from "../oracle/go-coordinator";
import type { Item, ModelResponse, Page, ResumeState, Sequence, ToolCallStatus, Turn } from "../sessionstore";
import { type CallStatus, MapRegistry, type Registry, type ToolContext, type Translator } from "../tool";

export const BASH_NAME = "Bash";
export const VIEW_IMAGE_NAME = "ViewImage";
export const SKILL_USE_NAME = "SkillUse";
export const TYPE_VALUE = "value";
export const VERSION_VALUE = 1;
export const TYPE_SHELL = "shell";

// ─────────────────────────────── fakes ───────────────────────────────

export class FakeStore {
    resume: ResumeState;
    items: Item[] = [];
    itemsErr: Error | null = null;
    itemsPage: Page | null = null;
    itemRequests: Array<{ After: Sequence; Limit: number }> = [];
    appendedInputs: Input[] = [];
    appendedTurns: Turn[] = [];
    appendedResponses: ModelResponse[] = [];
    appendedStatuses: ToolCallStatus[] = [];
    savedOperations: Operation[] = [];
    appendInputErr: Error | null = null;
    appendTurnErr: Error | null = null;
    appendModelResponseErr: Error | null = null;
    appendStatusErr: Error | null = null;
    saveOperationErr: Error | null = null;
    onAppendInput: ((input: Input) => void) | null = null;
    onAppendTurn: ((turn: Turn) => void) | null = null;
    onAppendModelResponse: ((response: ModelResponse) => void) | null = null;
    onAppendToolCallStatus: ((status: ToolCallStatus) => void) | null = null;
    onSaveOperation: ((operation: Operation) => void) | null = null;

    constructor(sessionID = "session-1") {
        this.resume = { Snapshot: { Session: { ID: sessionID, CreatedAt: "" } }, Operations: [], ExternalInputIDs: [] };
    }

    async items_(_id: string, after: Sequence, limit: number): Promise<Page> {
        this.itemRequests.push({ After: after, Limit: limit });

        if (this.itemsErr) {
            throw this.itemsErr;
        }

        if (this.itemsPage) {
            return this.itemsPage;
        }

        const start = this.items.findIndex((item) => (item.Sequence ?? 0) > after);
        const from = start < 0 ? this.items.length : start;
        const end = Math.min(from + limit, this.items.length);
        const page = this.items.slice(from, end);
        return {
            Items: page,
            NextAfter: page.length ? (page[page.length - 1].Sequence ?? after) : after,
            More: end < this.items.length,
        };
    }

    /** The `Store` view of this fake, so a `FakeStore` can be handed to the coordinator. */
    asStore() {
        return {
            items: (id: string, after: Sequence, limit: number) => this.items_(id, after, limit),
            appendInput: async (_id: string, input: Input) => {
                this.appendedInputs.push(input);
                this.onAppendInput?.(input);

                if (this.appendInputErr) {
                    throw this.appendInputErr;
                }
            },
            appendTurn: async (_id: string, turn: Turn) => {
                this.appendedTurns.push(turn);
                this.onAppendTurn?.(turn);

                if (this.appendTurnErr) {
                    throw this.appendTurnErr;
                }
            },
            appendModelResponse: async (_id: string, response: ModelResponse) => {
                this.appendedResponses.push(response);
                this.onAppendModelResponse?.(response);

                if (this.appendModelResponseErr) {
                    throw this.appendModelResponseErr;
                }
            },
            appendToolCallStatus: async (_id: string, status: ToolCallStatus) => {
                this.appendedStatuses.push(status);
                this.onAppendToolCallStatus?.(status);

                if (this.appendStatusErr) {
                    throw this.appendStatusErr;
                }
            },
            saveOperation: async (_id: string, operation: Operation) => {
                this.savedOperations.push(operation);
                this.onSaveOperation?.(operation);

                if (this.saveOperationErr) {
                    throw this.saveOperationErr;
                }
            },
            resume: async () => this.resume,
        };
    }
}

export class FakeOperationManager implements Manager {
    readonly updateQueue = new AsyncQueue<Operation>();
    adds: Operation[] = [];
    addError: ((operation: Operation) => Error | null) | null = null;
    cancels: OperationID[] = [];
    cancelReasons: string[] = [];
    cancelErr: Error | null = null;

    add(operation: Operation): void {
        this.adds.push(operation);
        const error = this.addError?.(operation);

        if (error) {
            throw error;
        }
    }

    cancel(id: OperationID, reason: string): void {
        this.cancels.push(id);
        this.cancelReasons.push(reason);

        if (this.cancelErr) {
            throw this.cancelErr;
        }
    }

    updates(): AsyncQueue<Operation> {
        return this.updateQueue;
    }
}

export type RespondFn = (request: Request, signal: AbortSignal) => Promise<Response>;

export class FakeAdapter implements Adapter {
    requests: Request[] = [];
    requestOptions: RequestOptions[] = [];

    constructor(public respondFn: RespondFn | null = null) {}

    async respond(request: Request, options: RequestOptions, signal: AbortSignal): Promise<Response> {
        this.requests.push(request);
        this.requestOptions.push(options);

        if (this.respondFn) {
            return this.respondFn(request, signal);
        }

        throw new Error("unexpected respond");
    }
}

// ─────────────────────────────── translators ───────────────────────────────

export class TestTranslator implements Translator {
    translate(): CallStatus {
        return { Error: "" };
    }

    translateResult(_callID: string, status: CallStatus): ToolResult {
        return { CallID: "", Output: [{ Kind: "text", Value: `error:${status.Error}` }] };
    }
}

export class SubmittingTranslator implements Translator {
    specs: Spec[] = [];
    calls: ToolCall[] = [];
    onTranslate: (() => void) | null = null;

    translate(context: ToolContext, call: ToolCall): CallStatus {
        this.calls.push(call);
        this.onTranslate?.();
        return { Error: "", WaitingFor: this.specs.map((spec) => context.submit(spec)) };
    }

    translateResult(callID: string, status: CallStatus, _operations: Operation[]): ToolResult {
        return { CallID: callID, Output: [{ Kind: "text", Value: status.Error }] };
    }
}

export class OperationStatusTranslator implements Translator {
    translate(): CallStatus {
        return { Error: "" };
    }

    translateResult(_callID: string, _status: CallStatus, operations: Operation[]): ToolResult {
        return {
            CallID: "",
            Output: [{ Kind: "text", Value: operations.map((operation) => operation.Status).join(",") }],
        };
    }
}

export class FailingResultTranslator implements Translator {
    constructor(readonly error: Error) {}

    translate(): CallStatus {
        return { Error: "" };
    }

    translateResult(): ToolResult {
        throw this.error;
    }
}

export class TerminalResultTranslator implements Translator {
    translate(): CallStatus {
        return { Error: "" };
    }

    translateResult(_callID: string, _status: CallStatus, operations: Operation[]): ToolResult {
        if (operations.some((operation) => isTerminal(operation.Status))) {
            throw new Error("terminal result failed");
        }

        return { CallID: "", Output: [{ Kind: "text", Value: "pending" }] };
    }
}

/** `submissionTranslator`: submits like `SubmittingTranslator`, reports like `OperationStatusTranslator`. */
export class SubmissionTranslator extends SubmittingTranslator {
    override translateResult(callID: string, status: CallStatus, operations: Operation[]): ToolResult {
        return new OperationStatusTranslator().translateResult(callID, status, operations);
    }
}

export interface StaticTranslators {
    Bash?: Translator;
    ViewImage?: Translator;
}

/** `tool.NewRegistry(configured, enabled...)` without the skill-use translator. */
export function newRegistry(configured: StaticTranslators, ...enabled: string[]): Registry {
    const map = new Map<string, Translator>();

    // Go resolves a static tool only when it is ENABLED, whatever was configured (registry.go:72-78).
    if (configured.Bash && enabled.includes(BASH_NAME)) {
        map.set(BASH_NAME, configured.Bash);
    }

    if (configured.ViewImage && enabled.includes(VIEW_IMAGE_NAME)) {
        map.set(VIEW_IMAGE_NAME, configured.ViewImage);
    }

    return new MapRegistry(map);
}

export function newValueSpec(value: string): Spec {
    return { Type: TYPE_VALUE, Version: VERSION_VALUE, State: `{"Value":${value}}` };
}

// ─────────────────────────────── inputs and responses ───────────────────────────────

export function externalEvent(id: string, text: string): Input {
    return { ID: id, Kind: "external", Payload: SafeJSON.stringify(text, { strict: true }) };
}

export function stopInput(id: string, mode: ControlMode): Input {
    return {
        ID: id,
        Kind: "control",
        Payload: SafeJSON.stringify({ Mode: mode, Reason: "user requested stop" }, { strict: true }),
    };
}

export function heartbeatInput(id: string): Input {
    return {
        ID: id,
        Kind: "control",
        Payload: SafeJSON.stringify({ Mode: "heartbeat", Reason: "Heartbeat: waiting for tools." }, { strict: true }),
    };
}

export function textResponse(text: string): Response {
    return {
        ID: "",
        Stop: "complete",
        Usage: usage(),
        Output: [{ Type: "message", Data: { Role: "assistant", Text: text } }],
    };
}

export function usage() {
    return { InputTokens: 0, CachedInputTokens: 0, CacheWriteInputTokens: 0, OutputTokens: 0, ReasoningTokens: 0 };
}

export function toolGraceResponse(...callIDs: string[]): Response {
    return {
        ID: "",
        Stop: "complete",
        Usage: usage(),
        Output: callIDs.map((id) => ({ Type: "tool_call", Data: { CallID: id, Name: BASH_NAME, Arguments: "{}" } })),
    };
}

export function storedItem(sequence: Sequence, item: Item): Item {
    return { ...item, Sequence: sequence };
}

// ─────────────────────────────── assertions ───────────────────────────────

export function assertStopResult(request: Request, callID: string, want: string): void {
    for (const item of request.Input) {
        if (item.Type === "tool_result" && item.Data.CallID === callID && item.Data.Output[0]?.Value === want) {
            return;
        }
    }

    throw new Error(`request lacks result "${want}" for "${callID}"`);
}

export function assertCompletedResults(request: Request, count: number): void {
    const completed = new Map<string, number>();

    for (const item of request.Input) {
        if (item.Type === "tool_result" && item.Data.Output[0]?.Value === "completed") {
            completed.set(item.Data.CallID, (completed.get(item.Data.CallID) ?? 0) + 1);
        }
    }

    expect(completed.size).toBe(count);

    for (let index = 0; index < count; index++) {
        expect(completed.get(`call-${index}`)).toBe(1);
    }
}

export function countHeartbeatMessages(request: Request): number {
    return request.Input.filter(
        (item) => item.Type === "message" && item.Data.Role === "user" && item.Data.Text.startsWith("Heartbeat:")
    ).length;
}

// ─────────────────────────────── the run ───────────────────────────────

export interface TestCall {
    signal: AbortSignal;
    request: Request;
    respond: (response: Response) => void;
    fail: (error: Error) => void;
}

export interface RunOutcome {
    settled: boolean;
    error: unknown;
}

export class StopTestRun {
    readonly clock: TestClock = newTestClock();
    readonly store: FakeStore;
    readonly operations = new FakeOperationManager();
    readonly inboxController = new AbortController();
    readonly inputs: Inbox;
    readonly builder: Builder;
    readonly deps: Dependencies;
    readonly calls: TestCall[] = [];
    readonly done: RunOutcome = { settled: false, error: undefined };
    current: Coordinator | null = null;
    private runController = new AbortController();
    private readonly restoredAtConstruction: ResumeState;
    private ids = 0;

    constructor(store: FakeStore, registry: Registry) {
        this.store = store;
        this.restoredAtConstruction = store.resume;
        this.inputs = new Inbox(this.inboxController.signal);
        this.builder = newBuilder();
        const adapter = new FakeAdapter((request, signal) => this.record(request, signal));
        this.deps = {
            toolHeartbeatIntervalMs: 0,
            sessionID: "session-1",
            inbox: this.inputs,
            restored: store.resume,
            sessions: store.asStore(),
            contextBuilder: this.builder,
            llm: adapter,
            tools: registry,
            operations: this.operations,
            clock: this.clock,
            newID: () => `id-${++this.ids}`,
        };
    }

    /** The default fake adapter: records the call and waits for `respond()`; an abort rejects like Go's `ctx.Err()`. */
    record(request: Request, signal: AbortSignal): Promise<Response> {
        return new Promise<Response>((resolve, reject) => {
            const call: TestCall = { signal, request, respond: resolve, fail: reject };
            this.calls.push(call);
            signal.addEventListener("abort", () => reject(signal.reason ?? new Error("aborted")), { once: true });
        });
    }

    /** A fake adapter that returns the response even after cancellation (Go tests that ignore `ctx`). */
    ignoreCancellation(): void {
        this.deps.llm = new FakeAdapter(
            (request, signal) =>
                new Promise<Response>((resolve, reject) => {
                    this.calls.push({ signal, request, respond: resolve, fail: reject });
                })
        );
    }

    get adapter(): FakeAdapter {
        return this.deps.llm as FakeAdapter;
    }

    requestCount(): number {
        return this.adapter.requests.length;
    }

    internals() {
        if (!this.current) {
            throw new Error("run has not started");
        }

        return coordinatorInternals(this.current);
    }

    /**
     * `synctest.Wait(); synctest.Sleep(2 * slurpIdleTimeout); synctest.Wait()`. Against the Go
     * oracle time is real: wait until the bridge has been quiet with no callback in flight.
     */
    async settle(): Promise<void> {
        if (oracle) {
            await drainTasks();
            await new Promise((resolve) => setTimeout(resolve, 2 * SLURP_IDLE_MS));
            await drainTasks();
            return;
        }

        await drainTasks();
        await this.clock.advance(2 * SLURP_IDLE_MS);
        await drainTasks();
    }

    async sleep(ms: number): Promise<void> {
        if (oracle) {
            await drainTasks();
            await this.clock.advance(ms);
            await this.settle();
            return;
        }

        await drainTasks();
        await this.clock.advance(ms);
        await drainTasks();
    }

    async start(signal?: AbortSignal): Promise<void> {
        // Go tests may assign `dependencies.Restored` before `start`; keep that. Otherwise follow the
        // fake store's `resume`, which a test may have replaced since construction.
        if (this.deps.restored === this.restoredAtConstruction) {
            this.deps.restored = this.store.resume;
        }

        this.current = createCoordinator(this.deps);
        const runSignal = signal ?? this.runController.signal;
        this.current.run(runSignal).then(
            () => {
                this.done.settled = true;
            },
            (error) => {
                this.done.settled = true;
                this.done.error = error;
            }
        );
        await drainTasks();

        // Go's Run restores the session before its first select; synctest.Wait() in the Go tests
        // sees that done. Against the oracle that restore is real callbacks, so wait for them.
        if (oracle) {
            await this.settle();
        }
    }

    cancel(reason?: Error): void {
        this.runController.abort(reason);
    }

    async input(...inputs: Input[]): Promise<void> {
        for (const input of inputs) {
            await this.inputs.submit(input);
        }

        await this.settle();
    }

    async update(index: number, status: Status): Promise<void> {
        const value = { ...this.store.resume.Operations[index], Status: status };
        this.operations.updateQueue.push(value);
        await this.settle();
    }

    async respond(index: number, response: Response): Promise<void> {
        const call = this.calls[index];

        if (!call) {
            const failed = this.done.error !== undefined ? `; the run already failed: ${String(this.done.error)}` : "";
            throw new Error(`request ${index} has not started${failed}`);
        }

        call.respond(response);
        await this.settle();
    }

    assertRunning(): void {
        if (this.done.settled) {
            throw new Error(`Run exited early: ${String(this.done.error ?? "ok")}`);
        }
    }

    assertStopped(): void {
        if (!this.done.settled) {
            throw new Error("Run did not stop");
        }

        if (this.done.error !== undefined) {
            throw new Error(`Run error = ${String(this.done.error)}`);
        }
    }

    /** Heartbeats the coordinator posted: control inputs the store saw with mode "heartbeat". */
    heartbeats(): Array<{ id: string; reason: string }> {
        const out: Array<{ id: string; reason: string }> = [];

        for (const input of this.store.appendedInputs) {
            if (input.Kind !== "control") {
                continue;
            }

            const control = decodeControlMessage(input);

            if (control.Mode === "heartbeat") {
                out.push({ id: input.ID, reason: control.Reason });
            }
        }

        return out;
    }

    assertHeartbeatCount(want: number): void {
        const beats = this.heartbeats();
        const ids = new Set(beats.map((beat) => beat.id));
        expect(ids.size).toBe(beats.length);
        expect(beats.every((beat) => beat.id !== "")).toBe(true);
        expect(beats.length).toBe(want);
    }
}

export interface DirectCoordinator {
    current: Coordinator;
    internals: ReturnType<typeof coordinatorInternals>;
    store: FakeStore;
    operations: FakeOperationManager;
    adapter: FakeAdapter;
    builder: Builder;
    inputs: Inbox;
    inboxController: AbortController;
    deps: Dependencies;
}

/**
 * `newTestCoordinator(store, inbox, operations, builder, registry)` for the white-box tests
 * that drive the coordinator method by method instead of through `run()`.
 */
export function newTestCoordinatorWithAdapter(
    store: FakeStore,
    registry: Registry,
    adapter: FakeAdapter,
    options: { builder?: Builder; operations?: FakeOperationManager } = {}
): DirectCoordinator {
    const inboxController = new AbortController();
    const inputs = new Inbox(inboxController.signal);
    const builder = options.builder ?? newBuilder();
    const operations = options.operations ?? new FakeOperationManager();
    let ids = 0;
    const deps: Dependencies = {
        toolHeartbeatIntervalMs: 0,
        sessionID: "session-1",
        inbox: inputs,
        restored: store.resume,
        sessions: store.asStore(),
        contextBuilder: builder,
        llm: adapter,
        tools: registry,
        operations,
        clock: new VirtualClock(1_000_000),
        newID: () => `id-${++ids}`,
    };
    const current = newCoordinator(deps);
    return {
        current,
        internals: coordinatorInternals(current),
        store,
        operations,
        adapter,
        builder,
        inputs,
        inboxController,
        deps,
    };
}

export function newTestCoordinator(
    store: FakeStore,
    registry: Registry,
    options: { builder?: Builder; operations?: FakeOperationManager } = {}
): DirectCoordinator {
    return newTestCoordinatorWithAdapter(store, registry, new FakeAdapter(), options);
}

export function emptyFakeStore(): FakeStore {
    return new FakeStore();
}

/** `HARNESS_ORACLE=go`: the twins drive the upstream Go coordinator through the bridge instead of the port. */
export const oracle = isOracleMode();

/**
 * `synctest.Wait()`: every task the coordinator can run without new input has run. Against the Go
 * oracle that means every running Go coordinator is at rest (quiet bridge, no callback in flight),
 * the same wait `run.settle()` does, so twins that drive `run.clock.advance` and `drainTasks` by
 * hand behave the same on both sides.
 */
export async function drainTasks(): Promise<void> {
    await drainPortTasks();

    if (oracle) {
        await settleLiveGoCoordinators();
        await drainPortTasks();
    }
}

/**
 * The twins' clock against the Go oracle, whose timers are real: `now()` is the wall clock, so a
 * deadline a twin computes right after a settle is measured from (almost) the moment the Go timer
 * was armed, and `advance(ms)` sleeps at least `ms`, so a Go timer armed just before the call has
 * fired when it returns (synctest fires equal deadlines together; real time needs the strict wait).
 * The twins' epsilons come from `twinTime.NS`, wide enough to absorb the settle round trips.
 */
export class RealAdvanceClock implements Clock {
    private readonly origin = Date.now();

    constructor(private readonly start = 1_000_000) {}

    now(): number {
        return this.start + (Date.now() - this.origin);
    }

    sleep(ms: number, signal?: AbortSignal): Promise<void> {
        return realClock.sleep(ms, signal);
    }

    pending(): number {
        return 0;
    }

    async advance(ms: number): Promise<void> {
        const target = Date.now() + Math.max(0, ms);

        while (Date.now() < target) {
            await new Promise((resolve) => setTimeout(resolve, target - Date.now()));
        }
    }
}

export type TestClock = VirtualClock | RealAdvanceClock;

/**
 * The long durations the heartbeat, grace and submission twins reason in. Against the Go oracle
 * they are real waits, so a minute becomes three seconds (still longer than the 1 s grace period,
 * which is a fixed real constant on the Go side) and the nanosecond epsilon becomes a 300 ms
 * margin: real timers cannot be ordered at sub-millisecond distance, and a deadline a twin computes
 * lags the Go timer by the settle round trips (about 20 ms each) that ran in between.
 */
export const twinTime = oracle
    ? { NS: 300, SECOND: 50, MINUTE: 3000, HOUR: 12_000 }
    : { NS: 1e-6, SECOND: 1000, MINUTE: 60_000, HOUR: 3_600_000 };

export function newTestClock(start = 1_000_000): TestClock {
    return oracle ? new RealAdvanceClock() : new VirtualClock(start);
}

/** The coordinator under test: the port, or the Go oracle when `HARNESS_ORACLE=go`. */
export function createCoordinator(deps: Dependencies): Coordinator {
    return oracle ? newGoCoordinator(deps) : newCoordinator(deps);
}

/** `withPreamble(t, items...)`: the items after the preamble every context builder starts with. */
export function withPreamble(...items: Item2[]): Item2[] {
    return [...newBuilder().build().Request.Input, ...items];
}

/** `independentToolCalls(t, count)`: a restored session with `count` awaiting ViewImage calls. */
export function independentToolCalls(count: number): { store: FakeStore; registry: Registry } {
    const registry = newRegistry({ ViewImage: new OperationStatusTranslator() }, VIEW_IMAGE_NAME);
    const store = new FakeStore();
    const response: ModelResponse = {
        TurnID: "turn-1",
        Response: { ID: "", Stop: "complete", Usage: usage(), Output: [] },
    };
    store.items = [
        storedItem(1, { Kind: "turn", Data: { ID: "turn-1", PreviousTurnID: "", Type: "regular" } }),
        storedItem(2, { Kind: "model_response", Data: response }),
    ];

    for (let index = 0; index < count; index++) {
        const value: Operation = { ID: `operation-${index}`, Type: TYPE_SHELL, Version: 1, Status: "awaiting" };
        const call: ToolCall = { CallID: `call-${index}`, Name: VIEW_IMAGE_NAME, Arguments: "{}" };
        response.Response.Output?.push({ Type: "tool_call", Data: call });
        store.resume.Operations.push(value);
        store.items.push(
            storedItem(store.items.length + 1, {
                Kind: "tool_call_status",
                Data: {
                    TurnID: "turn-1",
                    CallID: call.CallID,
                    Status: { Error: "", WaitingFor: [value.ID] },
                    Operations: [value],
                },
            })
        );
    }

    return { store, registry };
}

export function newStopTestRun(pending: number): StopTestRun {
    const { store, registry } = independentToolCalls(pending);
    return new StopTestRun(store, registry);
}

export function newToolGraceTestRun(): StopTestRun {
    const run = newStopTestRun(0);
    const translator = new SubmissionTranslator();
    translator.specs = [newValueSpec("1")];
    run.deps.tools = newRegistry(
        { Bash: translator, ViewImage: new OperationStatusTranslator() },
        BASH_NAME,
        VIEW_IMAGE_NAME
    );
    return run;
}

export async function updateToolGraceCall(run: StopTestRun, callID: string, terminal: Status): Promise<void> {
    for (const status of run.store.appendedStatuses) {
        if (status.CallID === callID) {
            const value = { ...(status.Operations ?? [])[0], Status: terminal };
            run.operations.updateQueue.push(value);
            await run.settle();
            return;
        }
    }

    throw new Error(`tool call "${callID}" was not scheduled`);
}

export function newHeartbeatTestRun(pending: number): StopTestRun {
    return newStopTestRun(pending);
}
