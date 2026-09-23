// The TypeScript twin of harness/coordinator/fault_fakes_test.go plus the pieces of
// fault_fuzz_test.go that are fakes rather than the test body.
//
// Mapping of what is not ported:
// - The Go fuzz drives the real `responsesapi` adapter over an `http.RoundTripper`
//   (`coordinatorFaultTransport`). The Responses API client is not ported, so `FaultAdapter` is an
//   `llm.Adapter` that fails at the same three sites ("transport", "http", "body") and returns
//   the same two responses the transport would have decoded to.
// - The skill-use translator and `operation.DecodeSkillUse` are not ported, so
//   `SkillUseTranslator` reproduces `tool/skill_use.go` for the fixture's needs.
// - Goroutines and `time.After` become async tasks on the shared `VirtualClock`.

import { SafeJSON } from "@genesiscz/utils/json";
import { AsyncQueue } from "../async-queue";
import type { Clock } from "../clock";
import type { Input } from "../inbox";
import type { Adapter, Request, RequestOptions, Response, ToolCall, ToolResult } from "../llm";
import type { Manager, Operation, OperationID, Spec } from "../operation";
import type {
    Item,
    ModelResponse,
    Page,
    ResumeState,
    Sequence,
    SessionID,
    Store,
    ToolCallStatus,
    Turn,
} from "../sessionstore";
import type { CallStatus, Registry, ToolContext, Translator } from "../tool";

export const errCoordinatorFuzzFault = new Error("injected coordinator dependency failure");

export type FaultEvent =
    | { kind: "failure"; value: string }
    | { kind: "commit"; value: Item }
    | { kind: "request"; value: Request }
    | { kind: "add" | "start" | "update" | "save"; value: Operation }
    | { kind: "cancel"; value: OperationID };

export class CoordinatorFaultTrace {
    readonly events: FaultEvent[] = [];
    failed = false;

    constructor(
        readonly site: string,
        private remaining: number
    ) {}

    record(event: FaultEvent): void {
        this.events.push(event);
    }

    fail(site: string): Error | null {
        if (this.failed || site !== this.site) {
            return null;
        }

        if (this.remaining > 0) {
            this.remaining--;
            return null;
        }

        this.failed = true;
        this.events.push({ kind: "failure", value: site });
        return errCoordinatorFuzzFault;
    }
}

function clone<T>(value: T): T {
    return structuredClone(value);
}

export type FaultObserver = (id: SessionID, item: Item) => void;

/**
 * This single-session store commits whole values or returns an error without changing
 * history. It has no coordinator lifecycle or scheduling logic. (Go: `faultMemoryStore`.)
 */
export class FaultMemoryStore implements Store {
    private sessionID: SessionID = "";
    private readonly itemList: Item[] = [];
    private readonly operations = new Map<OperationID, Operation>();
    private readonly observers = new Map<number, FaultObserver>();
    private nextObserver = 0;

    constructor(
        private readonly trace: CoordinatorFaultTrace,
        private readonly now: () => string
    ) {}

    addObserver(observer: FaultObserver): number {
        const id = ++this.nextObserver;
        this.observers.set(id, observer);
        return id;
    }

    removeObserver(id: number): void {
        this.observers.delete(id);
    }

    async create(id: SessionID): Promise<void> {
        if (!id || this.sessionID) {
            throw new Error("fuzz store needs one fresh session");
        }

        this.sessionID = id;
    }

    private check(id: SessionID): void {
        if (!id || id !== this.sessionID) {
            throw new Error("unknown fuzz session");
        }
    }

    async items(id: SessionID, after: Sequence, limit: number): Promise<Page> {
        this.check(id);
        const failure = this.trace.fail("history");

        if (failure) {
            throw failure;
        }

        if (limit <= 0) {
            throw new Error("invalid page size");
        }

        const start = Math.min(after, this.itemList.length);
        const end = Math.min(start + limit, this.itemList.length);
        const page: Page = { Items: [], NextAfter: after, More: end < this.itemList.length };

        for (const item of this.itemList.slice(start, end)) {
            page.Items.push(clone(item));
            page.NextAfter = item.Sequence ?? page.NextAfter;
        }

        return page;
    }

    appendInput(id: SessionID, value: Input): Promise<void> {
        return this.append(id, "input", { Kind: "input", Data: value });
    }

    appendTurn(id: SessionID, value: Turn): Promise<void> {
        return this.append(id, "turn", { Kind: "turn", Data: value });
    }

    appendModelResponse(id: SessionID, value: ModelResponse): Promise<void> {
        return this.append(id, "response", { Kind: "model_response", Data: value });
    }

    appendToolCallStatus(id: SessionID, value: ToolCallStatus): Promise<void> {
        return this.append(id, "status", { Kind: "tool_call_status", Data: value });
    }

    private async append(id: SessionID, site: string, item: Item): Promise<void> {
        this.check(id);
        const failure = this.trace.fail(site);

        if (failure) {
            throw failure;
        }

        const stored: Item = clone({ ...item, Sequence: this.itemList.length + 1, RecordedAt: this.now() });

        if (stored.Kind === "tool_call_status") {
            for (const value of stored.Data.Operations ?? []) {
                this.operations.set(value.ID, clone(value));
            }
        }

        this.itemList.push(stored);
        this.trace.record({ kind: "commit", value: clone(stored) });

        for (const observe of [...this.observers.values()]) {
            observe(id, clone(stored));
        }
    }

    async saveOperation(id: SessionID, value: Operation): Promise<void> {
        this.check(id);

        if (!this.operations.has(value.ID)) {
            throw new Error(`operation "${value.ID}" was never committed`);
        }

        const failure = this.trace.fail("save");

        if (failure) {
            throw failure;
        }

        this.operations.set(value.ID, clone(value));
        this.trace.record({ kind: "save", value: clone(value) });
    }

    async resume(): Promise<ResumeState> {
        throw new Error("fuzz store does not support resume");
    }

    async fork(): Promise<void> {
        throw new Error("fuzz store does not support forks");
    }
}

// ─────────────────────────────── skill-use operations ───────────────────────────────

export const TYPE_SKILL_USE = "skill_use";
export const VERSION_SKILL_USE = 1;

/** Go `operation.SkillUseState`; `Content` is `[]byte`, which encoding/json writes as base64. */
export interface SkillUseState {
    Path: string;
    Content: string;
    TerminalError: string;
}

export function encodeSkillUse(state: { Path: string; Content: string; TerminalError: string }): string {
    const wire: SkillUseState = {
        Path: state.Path,
        Content: Buffer.from(state.Content, "utf8").toString("base64"),
        TerminalError: state.TerminalError,
    };
    return SafeJSON.stringify(wire, { strict: true });
}

/** Go `operation.DecodeSkillUse`: decoded `Content` is returned as text. */
export function decodeSkillUse(operation: Operation): { Path: string; Content: string; TerminalError: string } {
    if (operation.Type !== TYPE_SKILL_USE) {
        throw new Error(
            `decode skill-use operation "${operation.ID}": type "${operation.Type}": unsupported operation`
        );
    }

    const parsed: unknown = SafeJSON.parse(operation.State ?? "", { strict: true });

    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        throw new Error(`decode skill-use operation "${operation.ID}": state is not an object`);
    }

    const record = parsed as Record<string, unknown>;
    const text = (key: string): string => {
        const value = record[key];
        return typeof value === "string" ? value : "";
    };
    return {
        Path: text("Path"),
        Content: Buffer.from(text("Content"), "base64").toString("utf8"),
        TerminalError: text("TerminalError"),
    };
}

export function newSkillUseSpec(path: string): Spec {
    return {
        Type: TYPE_SKILL_USE,
        Version: VERSION_SKILL_USE,
        State: encodeSkillUse({ Path: path, Content: "", TerminalError: "" }),
    };
}

/** `tool.skillUseTranslator` against a registry's registered skills. */
export class SkillUseTranslator implements Translator {
    constructor(private readonly registry: Registry) {}

    translate(context: ToolContext, call: ToolCall): CallStatus {
        if (call.Name !== "" && call.Name !== "SkillUse") {
            return { Error: `skill-use call name "${call.Name}" does not match static tool "SkillUse"` };
        }

        const encoded = call.Arguments.trim() === "" ? "{}" : call.Arguments;
        let name = "";

        try {
            const parsed: unknown = SafeJSON.parse(encoded, { strict: true });

            if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
                const value = (parsed as Record<string, unknown>).name;
                name = typeof value === "string" ? value : "";
            }
        } catch (error) {
            return { Error: `decode skill-use arguments: ${String(error)}` };
        }

        if (name.trim() === "") {
            return { Error: `skill-use argument "name" must be set` };
        }

        const skill = this.registry.skills().find((candidate) => candidate.Name === name);

        if (!skill) {
            return { Error: `skill "${name}" is not registered` };
        }

        return { Error: "", WaitingFor: [context.submit(newSkillUseSpec(skill.Path))] };
    }

    translateResult(callID: string, status: CallStatus, operations: Operation[]): ToolResult {
        if (status.Error !== "") {
            return { CallID: callID, Output: [{ Kind: "text", Value: status.Error }] };
        }

        if (operations.length !== 1) {
            throw new Error(`skill-use call "${callID}" has ${operations.length} operations, want 1`);
        }

        const current = operations[0];
        const state = decodeSkillUse(current);

        switch (current.Status) {
            case "completed":
                return { CallID: callID, Output: [{ Kind: "text", Value: state.Content }] };
            case "ready":
            case "awaiting":
            case "canceling":
                return { CallID: callID, Output: [{ Kind: "text", Value: "Skill is loading." }] };
            case "canceled":
            case "failed":
                if (state.TerminalError === "") {
                    throw new Error(`skill-use call "${callID}" terminal operation "${current.ID}" has no error`);
                }

                return { CallID: callID, Output: [{ Kind: "text", Value: state.TerminalError }] };
        }
    }
}

// ─────────────────────────────── operations ───────────────────────────────

export interface FaultOperationPlan {
    path: string;
    result: string;
    delayMs: number;
    fail: boolean;
    repeat: boolean;
}

/** Go `controlledFaultOperations`: runs each skill-use operation on the virtual clock by its plan. */
export class ControlledFaultOperations implements Manager {
    readonly plans = new Map<string, FaultOperationPlan>();
    readonly updateQueue = new AsyncQueue<Operation>();
    private readonly cancels = new Map<OperationID, AbortController>();
    private startedOnce = false;
    onStarted: (() => void) | null = null;

    constructor(
        private readonly signal: AbortSignal,
        private readonly clock: Clock,
        private readonly trace: CoordinatorFaultTrace
    ) {}

    add(value: Operation): void {
        this.trace.record({ kind: "add", value: clone(value) });
        const failure = this.trace.fail("add");

        if (failure) {
            throw failure;
        }

        const state = decodeSkillUse(value);
        const plan = this.plans.get(state.Path);

        if (!plan) {
            throw new Error("operation has no execution plan");
        }

        if (this.cancels.has(value.ID)) {
            return;
        }

        const controller = new AbortController();
        const forward = () => controller.abort();
        this.signal.addEventListener("abort", forward, { once: true });
        this.cancels.set(value.ID, controller);
        this.trace.record({ kind: "start", value: clone(value) });

        if (!this.startedOnce) {
            this.startedOnce = true;
            this.onStarted?.();
        }

        void this.execute(value, state, plan, controller.signal);
    }

    private async execute(
        value: Operation,
        state: { Path: string; Content: string; TerminalError: string },
        plan: FaultOperationPlan,
        signal: AbortSignal
    ): Promise<void> {
        this.emit({ ...value, Status: "awaiting" });
        let terminal: Operation;

        try {
            await this.clock.sleep(plan.delayMs, signal);

            if (plan.fail) {
                terminal = {
                    ...value,
                    Status: "failed",
                    State: encodeSkillUse({ ...state, TerminalError: plan.result }),
                };
            } else {
                terminal = { ...value, Status: "completed", State: encodeSkillUse({ ...state, Content: plan.result }) };
            }
        } catch {
            if (this.signal.aborted) {
                return;
            }

            terminal = {
                ...value,
                Status: "canceled",
                State: encodeSkillUse({ ...state, TerminalError: "operation canceled" }),
            };
        }

        this.emit(terminal);

        if (plan.repeat) {
            this.emit(terminal);
        }
    }

    cancel(id: OperationID): void {
        this.trace.record({ kind: "cancel", value: id });
        const failure = this.trace.fail("cancel");

        if (failure) {
            throw failure;
        }

        const controller = this.cancels.get(id);

        if (!controller) {
            throw new Error("operation canceled before dispatch");
        }

        controller.abort();
    }

    private emit(value: Operation): void {
        this.trace.record({ kind: "update", value: clone(value) });

        // Go selects between the send and ctx.Done(); once the fuzz context ends the update is dropped.
        if (this.signal.aborted) {
            return;
        }

        this.updateQueue.push(clone(value));
    }

    updates(): AsyncQueue<Operation> {
        return this.updateQueue;
    }
}

// ─────────────────────────────── model ───────────────────────────────

/**
 * Stands in for `coordinatorFaultTransport` + `responsesapi.NewAdapter(MaxAttempts: 1)`.
 * Records every request, fails at the "transport", "http" and "body" sites like the Go
 * round-tripper does, and otherwise returns the prepared responses in order.
 */
export class FaultAdapter implements Adapter {
    readonly responses: Response[] = [];
    private calls = 0;
    onStarted: (() => void) | null = null;

    constructor(
        private readonly trace: CoordinatorFaultTrace,
        private readonly block: boolean
    ) {}

    async respond(request: Request, _options: RequestOptions, signal: AbortSignal): Promise<Response> {
        this.trace.record({ kind: "request", value: clone(request) });
        const index = this.calls++;

        if (index === 0) {
            this.onStarted?.();
        }

        if (this.block) {
            await new Promise<void>((resolve) => {
                if (signal.aborted) {
                    resolve();
                } else {
                    signal.addEventListener("abort", () => resolve(), { once: true });
                }
            });
            throw signal.reason ?? new Error("request canceled");
        }

        const transport = this.trace.fail("transport");

        if (transport) {
            throw transport;
        }

        if (this.trace.fail("http")) {
            // The Go transport answers 503; the adapter turns that into its own error, not the fault.
            throw new Error("responses API returned 503 Service Unavailable: injected HTTP failure");
        }

        const body = this.trace.fail("body");

        if (body) {
            throw new Error("read responses API event stream", { cause: body });
        }

        if (index >= this.responses.length) {
            throw new Error("coordinator requested an extra model response");
        }

        return clone(this.responses[index]);
    }
}

// ─────────────────────────────── invariants ───────────────────────────────

function fatal(message: string): never {
    throw new Error(message);
}

export interface FaultTraceExpectation {
    results: Map<string, string>;
    usageRaw: string;
    inputTokens: number;
    outputTokens: number;
    hardStop: boolean;
    settled: boolean;
}

/** Go `assertCoordinatorFaultTrace`: every invariant over the recorded dependency events. */
export function assertCoordinatorFaultTrace(events: FaultEvent[], want: FaultTraceExpectation): void {
    let previous = "";
    let turns = 0;
    let requests = 0;
    let responses = 0;
    let failed = false;
    const calls = new Map<string, string>();
    const committed = new Map<OperationID, Operation>();
    const started = new Set<OperationID>();
    const updates = new Map<OperationID, Operation[]>();
    const statuses = new Map<OperationID, Operation>();
    const responded = new Set<string>();

    for (const event of events) {
        if (
            failed &&
            (event.kind === "commit" || event.kind === "save" || event.kind === "request" || event.kind === "add")
        ) {
            fatal(`coordinator continued "${event.kind}" after dependency failure`);
        }

        switch (event.kind) {
            case "failure":
                failed = true;
                break;
            case "commit": {
                const item = event.value;

                if (item.Kind === "turn") {
                    if (item.Data.ID === "" || item.Data.PreviousTurnID !== previous) {
                        fatal(`broken turn chain: ${SafeJSON.stringify(item.Data, { strict: true })}`);
                    }

                    previous = item.Data.ID;
                    turns++;
                } else if (item.Kind === "model_response") {
                    const value = item.Data;

                    if (
                        responded.has(value.TurnID) ||
                        value.TurnID !== previous ||
                        value.Response.ID !== `response-${requests - 1}`
                    ) {
                        fatal(`response duplicated or associated with the wrong request: ${value.Response.ID}`);
                    }

                    responded.add(value.TurnID);
                    responses++;
                    const usage = value.Response.Usage;

                    if (
                        usage.InputTokens !== want.inputTokens ||
                        usage.OutputTokens !== want.outputTokens ||
                        usage.Raw !== want.usageRaw
                    ) {
                        fatal(`usage changed between HTTP response and persistence: ${SafeJSON.stringify(usage)}`);
                    }

                    for (const output of value.Response.Output ?? []) {
                        if (output.Type === "tool_call") {
                            calls.set(output.Data.CallID, value.TurnID);
                        }
                    }
                } else if (item.Kind === "tool_call_status") {
                    const value = item.Data;
                    const operations = value.Operations ?? [];
                    const waitingFor = value.Status.WaitingFor ?? [];

                    if (
                        calls.get(value.CallID) === undefined ||
                        value.TurnID !== calls.get(value.CallID) ||
                        value.Status.Error !== "" ||
                        operations.length !== 1 ||
                        waitingFor.length !== 1 ||
                        waitingFor[0] !== operations[0].ID
                    ) {
                        fatal(`status lacks its committed call or operation: ${SafeJSON.stringify(value)}`);
                    }

                    const op = operations[0];
                    const prior = committed.get(op.ID);

                    if (prior) {
                        if (!Bun.deepEquals(op, prior)) {
                            fatal("tool status differs from the saved operation");
                        }
                    } else if (op.Status !== "ready") {
                        fatal("operation was initialized after execution");
                    }

                    committed.set(op.ID, op);
                    statuses.set(op.ID, op);
                }

                break;
            }
            case "request": {
                requests++;

                if (requests !== turns || (want.hardStop && requests > 1)) {
                    fatal("HTTP request preceded its committed turn or followed a hard stop");
                }

                if (requests > 1) {
                    const delivered = new Map<string, string>();

                    for (const item of event.value.Input) {
                        if (item.Type !== "tool_result") {
                            continue;
                        }

                        if (delivered.has(item.Data.CallID)) {
                            fatal("tool result delivered more than once");
                        }

                        // Go: one `input_text` output per `function_call_output`.
                        if (item.Data.Output.length !== 1 || item.Data.Output[0].Kind !== "text") {
                            fatal(`unexpected tool output: ${SafeJSON.stringify(item.Data.Output)}`);
                        }

                        delivered.set(item.Data.CallID, item.Data.Output[0].Value);
                    }

                    if (!Bun.deepEquals(delivered, want.results)) {
                        fatal(
                            `model received wrong tool results: got ${SafeJSON.stringify([...delivered])}, want ${SafeJSON.stringify([...want.results])}`
                        );
                    }
                }

                break;
            }
            case "add": {
                const prior = committed.get(event.value.ID);

                if (!prior || !Bun.deepEquals(prior, event.value)) {
                    fatal("operation dispatched before its status and state committed");
                }

                break;
            }
            case "start":
                if (started.has(event.value.ID)) {
                    fatal("operation started more than once");
                }

                started.add(event.value.ID);
                break;
            case "cancel":
                if (!started.has(event.value)) {
                    fatal("operation canceled before the manager knew it");
                }

                break;
            case "update":
                updates.set(event.value.ID, [...(updates.get(event.value.ID) ?? []), event.value]);
                break;
            case "save": {
                const value = event.value;
                const found = (updates.get(value.ID) ?? []).some((update) => Bun.deepEquals(update, value));

                if (!started.has(value.ID) || !found) {
                    fatal("saved operation was never reported by the manager");
                }

                committed.set(value.ID, value);
                break;
            }
        }
    }

    if (turns !== requests) {
        fatal(`committed turns=${turns}, HTTP requests=${requests}`);
    }

    if (want.settled) {
        const wantResponses = want.hardStop ? 1 : 2;

        if (responses !== wantResponses || started.size !== want.results.size) {
            fatal(`settled execution: responses=${responses}, started operations=${started.size}`);
        }

        for (const id of started) {
            const value = committed.get(id);
            const terminal =
                value?.Status === "completed" || value?.Status === "failed" || value?.Status === "canceled";

            if (!value || !terminal || !Bun.deepEquals(statuses.get(id), value)) {
                fatal("coordinator stopped before recording terminal operation and tool status");
            }

            if (want.hardStop && value.Status !== "canceled") {
                fatal("hard stop did not cancel the pending operation");
            }
        }
    }
}
