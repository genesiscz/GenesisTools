// Twin of harness/coordinator/fault_fuzz_test.go (fakes in testing/fault-helpers.ts, from
// fault_fakes_test.go).
//
// `FuzzCoordinatorFaults` becomes a DETERMINISTIC sweep. The case list is the Go seed corpus
// (`f.Add` for every mode, plus the empty seed) followed by every occurrence index of every
// fault site for one fixed action list, so each injection point is hit on purpose rather than
// by chance. No randomness. Each case keeps every Go invariant (`assertCoordinatorFaultTrace`).

import { describe, expect, test } from "bun:test";
import { SafeJSON } from "@genesiscz/utils/json";
import { AbortedError, drainTasks, VirtualClock } from "./clock";
import { newBuilder } from "./contextbuilder";
import { newCoordinator } from "./coordinator";
import { Inbox } from "./inbox";
import type { Item as LlmItem } from "./llm";
import { emptyResume } from "./sessionstore";
import { SKILL_USE_NAME } from "./testing/driver";
import {
    assertCoordinatorFaultTrace,
    ControlledFaultOperations,
    CoordinatorFaultTrace,
    errCoordinatorFuzzFault,
    FaultAdapter,
    FaultMemoryStore,
    SkillUseTranslator,
} from "./testing/fault-helpers";
import { errorIs } from "./testing/rest-helpers";
import { type Definition, MapRegistry, type Translator } from "./tool";

const MAX_INT64 = (1n << 63n) - 1n;
const SITES = [
    "",
    "history",
    "input",
    "turn",
    "response",
    "status",
    "save",
    "add",
    "cancel",
    "transport",
    "http",
    "body",
    "",
    "",
];

interface FaultSeed {
    actions: number[];
    mode: number;
    occurrence: number;
    text: string;
    tokens: bigint;
}

function siteCounts(actions: number): number[] {
    return [1, 1, 2, 2, 2, 2 * actions, 2 * actions, actions, actions, 2, 2, 2, 1, 1];
}

function seeds(): FaultSeed[] {
    const list: FaultSeed[] = [];

    for (let mode = 0; mode < 14; mode++) {
        list.push({ actions: [0, 17, 35], mode, occurrence: 0, text: 'result\n"会話', tokens: (1n << 53n) + 1n });
        list.push({ actions: [48, 2, 19], mode, occurrence: 255, text: "", tokens: MAX_INT64 });
    }

    list.push({ actions: [], mode: 0, occurrence: 0, text: "", tokens: 0n });
    const sweep = [0, 17, 35];

    for (let mode = 0; mode < 14; mode++) {
        for (let occurrence = 0; occurrence < siteCounts(sweep.length)[mode]; occurrence++) {
            list.push({ actions: sweep, mode, occurrence, text: "sweep", tokens: 42n });
        }
    }

    return list;
}

function faultJSON(value: unknown): string {
    return SafeJSON.stringify(value, { strict: true });
}

const SKILL_USE_DEFINITION: Definition = {
    Tool: {
        Type: "function",
        Name: SKILL_USE_NAME,
        Description: "Load a registered skill file.",
        Parameters: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
    },
};

async function runFaultCase(seed: FaultSeed): Promise<void> {
    const actions = seed.actions.length === 0 ? [0] : seed.actions;
    const mode = seed.mode % 14;
    const text = seed.text;
    const tokens = seed.tokens;
    const hardStop = mode === 8 || mode === 12;
    const clock = new VirtualClock(1_000_000);
    const controller = new AbortController();
    const counts = siteCounts(actions.length);
    const trace = new CoordinatorFaultTrace(SITES[mode], seed.occurrence % counts[mode]);
    const store = new FaultMemoryStore(trace, () => new Date(clock.now()).toISOString());
    const id = "faults";
    await store.create(id);
    const inputs = new Inbox(controller.signal);
    await inputs.submit({ ID: "user", Kind: "external", Payload: faultJSON(text) });
    await inputs.submit({ ID: "idle", Kind: "control", Payload: faultJSON({ Mode: "when_idle", Reason: "" }) });
    const translators = new Map<string, Translator>();
    const registry = new MapRegistry(translators, [SKILL_USE_DEFINITION]);
    translators.set(SKILL_USE_NAME, new SkillUseTranslator(registry));
    const manager = new ControlledFaultOperations(controller.signal, clock, trace);
    const wireCalls: LlmItem[] = [];
    const results = new Map<string, string>();

    for (const [index, action] of actions.entries()) {
        const name = `skill-${index}`;
        const plan = {
            path: `/fuzz/${name}`,
            result: `result-${index}: ${text}`,
            delayMs: hardStop ? 60 * 60 * 1000 : 1 + (action % 16),
            fail: (action & 16) !== 0,
            repeat: (action & 32) !== 0,
        };
        manager.plans.set(plan.path, plan);
        registry.registerSkill({ Name: name, Description: "Controlled operation fixture.", Path: plan.path });
        const callID = `call-${index}`;
        results.set(callID, plan.result);
        wireCalls.push({
            ProviderID: `provider-${callID}`,
            Type: "tool_call",
            Data: { CallID: callID, Name: SKILL_USE_NAME, Arguments: faultJSON({ name }) },
        });
    }

    // Usage is `number` in the port; JSON keeps the exact 64-bit digits in `Raw`.
    const inputTokens = Number(tokens & MAX_INT64);
    const outputTokens = Number(tokens % 997n);
    const usageRaw = `{"input_tokens":${tokens & MAX_INT64},"output_tokens":${tokens % 997n}}`;
    const adapter = new FaultAdapter(trace, mode === 13);

    for (const [index, output] of [wireCalls, []].entries()) {
        adapter.responses.push({
            ID: `response-${index}`,
            Stop: "complete",
            Output: output,
            Usage: {
                InputTokens: inputTokens,
                CachedInputTokens: 0,
                CacheWriteInputTokens: 0,
                OutputTokens: outputTokens,
                ReasoningTokens: 0,
                Raw: usageRaw,
            },
        });
    }

    const builder = newBuilder(...registry.skills());
    builder.setModel({ ID: "fuzz-model" });

    for (const definition of registry.staticDefinitions()) {
        builder.addTool(definition.Tool);
    }

    let ids = 0;
    const current = newCoordinator({
        toolHeartbeatIntervalMs: 0,
        sessionID: id,
        inbox: inputs,
        restored: emptyResume(id),
        sessions: store,
        contextBuilder: builder,
        llm: adapter,
        tools: registry,
        operations: manager,
        clock,
        newID: () => `id-${++ids}`,
    });

    if (hardStop) {
        manager.onStarted = () => {
            queueMicrotask(() => {
                inputs
                    .submit({ ID: "hard", Kind: "control", Payload: `{"Mode":"hard","Reason":"fuzz stop"}` })
                    .catch(() => undefined);
            });
        };
    }

    const canceled = new AbortedError("context canceled");
    const deadlineExceeded = new AbortedError("context deadline exceeded");

    if (mode === 13) {
        adapter.onStarted = () => queueMicrotask(() => controller.abort(canceled));
    }

    const outcome: { settled: boolean; error: unknown } = { settled: false, error: undefined };
    current.run(controller.signal).then(
        () => {
            outcome.settled = true;
        },
        (error) => {
            outcome.settled = true;
            outcome.error = error;
        }
    );
    // `context.WithTimeout(t.Context(), time.Minute)` on the virtual clock.
    const deadline = clock.now() + 60_000;

    while (!outcome.settled && clock.now() < deadline) {
        await clock.advance(100);
    }

    if (!outcome.settled) {
        controller.abort(deadlineExceeded);
        await drainTasks();
    }

    controller.abort(canceled);
    await drainTasks();
    const error = outcome.error;

    if (mode === 13) {
        if (!errorIs(error, canceled)) {
            throw new Error(`canceled HTTP request: ${String(error)}`);
        }
    } else if (trace.site !== "") {
        if (!trace.failed || error === undefined || errorIs(error, deadlineExceeded)) {
            throw new Error(`fault "${trace.site}" reached=${trace.failed}, coordinator error=${String(error)}`);
        }

        if (mode < 9 && !errorIs(error, errCoordinatorFuzzFault)) {
            throw new Error(`coordinator lost dependency error: ${String(error)}`);
        }
    } else if (error !== undefined) {
        throw new Error(String(error));
    }

    assertCoordinatorFaultTrace(trace.events, {
        results,
        usageRaw,
        inputTokens,
        outputTokens,
        hardStop,
        settled: error === undefined,
    });
}

async function sweep(filter: (seed: FaultSeed) => boolean): Promise<string[]> {
    const failures: string[] = [];

    for (const seed of seeds().filter(filter)) {
        try {
            await runFaultCase(seed);
        } catch (error) {
            const label = `actions=[${seed.actions.join(",")}] mode=${seed.mode} occurrence=${seed.occurrence}`;
            failures.push(`${label}: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    return failures;
}

/** Mode 8 injects the fault at `Operations.Cancel`; see the PORT-DEFECT below. */
const CANCEL_SITE_MODE = 8;

describe("fault_fuzz_test.go", () => {
    test("FuzzCoordinatorFaults", async () => {
        expect(await sweep((seed) => seed.mode % 14 !== CANCEL_SITE_MODE)).toEqual([]);
    });

    // Was a PORT-DEFECT (notes-rest.md #1): cancel failures were joined as message strings with no
    // `cause`, so `errors.Is` could not find the injected fault. Fixed: `cancelOperations` now throws
    // an AggregateError whose `cause` chain keeps every wrapped error, like Go's errors.Join.
    test("FuzzCoordinatorFaults (cancel site)", async () => {
        expect(await sweep((seed) => seed.mode % 14 === CANCEL_SITE_MODE)).toEqual([]);
    });
});
