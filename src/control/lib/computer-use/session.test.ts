import { describe, expect, test } from "bun:test";
import { evaluationSchema } from "@genesiscz/utils/ai/evaluation/evaluate";
import type { EvaluationResponse, Evaluator } from "@genesiscz/utils/ai/evaluation/service";
import { SafeJSON } from "@genesiscz/utils/json";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { createComputerMcpServer, invokeComputerTool } from "../../mcp/server";
import type { Observation } from "../decision/observation";
import { ComputerReplEngine } from "./repl";
import { ComputerUse, type NativeBridge } from "./session";

function fixture(options: { evaluate?: Evaluator } = {}) {
    const elements: Observation["elements"] = [
        { index: 0, depth: 0, role: "AXWindow", actions: ["AXRaise"], x: -500, y: 100, width: 400, height: 300 },
        {
            index: 1,
            depth: 1,
            role: "AXButton",
            AXTitle: "Save",
            AXIdentifier: "save",
            actions: ["AXPress", "AXShowMenu"],
        },
        {
            index: 2,
            depth: 1,
            role: "AXTextField",
            AXIdentifier: "name",
            AXValue: "old",
            AXFocused: true,
            valueSettable: true,
        },
        {
            index: 3,
            depth: 1,
            role: "AXTextField",
            AXSubrole: "AXSecureTextField",
            AXValue: "SECRET",
            AXSelectedText: "SECRET",
        },
    ];
    const snapshot = {
        ok: true,
        app: "Fixture",
        pid: 7,
        processLaunch: 123,
        scope: "window",
        snapshot: "s0",
        window: { id: 10, title: "Fixture", x: -500, y: 100, width: 400, height: 300 },
        screenshot: { path: "/fixture.png", width: 800, height: 600 },
        elements,
    };
    const calls: string[][] = [];
    const native: NativeBridge = {
        run: async ({ args }) => {
            calls.push(args);
            const pathIndex = args.indexOf("--path");
            if (pathIndex >= 0) {
                snapshot.screenshot.path = args[pathIndex + 1];
            }
            if (args[0] === "apps") {
                return { ok: true, apps: [{ pid: 7, name: "Fixture", bundleId: "example.fixture", frontmost: true }] };
            }
            if (args[0] === "see") {
                snapshot.scope = args[args.indexOf("--scope") + 1];
                return structuredClone(snapshot);
            }
            const action = args[args.indexOf("--action") + 1];
            if (action === "set") {
                const row = (snapshot.elements as Observation["elements"]).find(
                    (element) => element.index === Number(args[args.indexOf("--element") + 1])
                );
                if (row) {
                    row.AXValue = args[args.indexOf("--value") + 1];
                }
            }
            if (action === "paste" && args.includes("--replace")) {
                const row = (snapshot.elements as Observation["elements"]).find(
                    (element) => element.index === Number(args[args.indexOf("--element") + 1])
                );
                if (row) {
                    row.AXValue = args[args.indexOf("--text") + 1];
                }
            }
            snapshot.snapshot = `s${calls.length}`;
            return {
                ok: true,
                after: structuredClone(snapshot),
                clipboardRestore: action === "paste" ? "restored" : undefined,
            };
        },
    };
    return { calls, native, computer: new ComputerUse({ native, evaluate: options.evaluate }), snapshot };
}
function evaluation(answers: EvaluationResponse["answers"]): EvaluationResponse {
    return {
        model: "fixture",
        answers,
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        warnings: [],
        rounding: undefined,
        providerMetadata: undefined,
    };
}
test("standalone host replies reread native evidence and consume no additional model request", async () => {
    let requests = 0;
    const f = fixture({
        evaluate: async () => {
            if (++requests > 1) {
                throw new Error("Host reply called Jev again");
            }
            return evaluation({
                target: { type: "choice", choice: "abstain", probabilities: { c0: 0.2, abstain: 0.8 } },
                coverage: { type: "boolean", probability: 0.4 },
                conflict: { type: "boolean", probability: 0 },
            });
        },
    });
    await f.computer.get_app_state({ app: "Fixture", image: false });
    const first = await f.computer.resolve_target({ app: "Fixture", intent: "Save this", chooser: "auto" });
    const packet = first.packet;
    if (!packet) {
        throw new Error("Expected host packet");
    }
    const host_decision = { packet, answer: { packetId: packet.packetId, choice: "c0", evidence: ["e1"] } };
    const accepted = await f.computer.resolve_target({ app: "Fixture", intent: "Save this", host_decision });
    expect(accepted.source).toBe("host");
    expect(accepted.selected?.identifier).toBe("save");
    expect(accepted.metrics.requests).toBe(0);
    expect(f.calls.filter((args) => args[0] === "see")).toHaveLength(2);
    f.snapshot.elements[1].AXTitle = "Delete";
    await expect(f.computer.resolve_target({ app: "Fixture", intent: "Save this", host_decision })).rejects.toThrow(
        "changed"
    );
    expect(requests).toBe(1);
    expect(f.calls.every((args) => args[0] === "see")).toBe(true);
});
test("standalone assist gates Jev before observation and exact assist spends no requests", async () => {
    const f = fixture({
        evaluate: async () => {
            throw new Error("Exact assist must not call Jev");
        },
    });
    await expect(
        invokeComputerTool({
            computer: f.computer,
            name: "assist_task",
            input: {
                app: "Fixture",
                goal: "Save",
                chooser: "jev",
            },
        })
    ).rejects.toThrow("jev:true");
    await expect(f.computer.assist_task({ app: "Fixture", goal: "Save" })).rejects.toThrow("exact completion");
    expect(f.calls).toHaveLength(0);
    await f.computer.get_app_state({ app: "Fixture", image: false });
    const result = await f.computer.assist_task({
        app: "Fixture",
        goal: "Save",
        exact: { identifier: "name", value: "old" },
        max_requests: 0,
    });
    expect(result.status).toBe("verified");
    expect(result.metrics.requests).toBe(0);
    expect(result.metrics.actions).toBe(0);
    expect(() => f.computer.find({ app: "Fixture", query: "Save" })).toThrow("get_app_state");
});
test("standalone assist routes one Jev choice without preparing native AX and verifies exact readback", async () => {
    const evaluations: Parameters<Evaluator>[0][] = [];
    const f = fixture({
        evaluate: async (call) => {
            evaluations.push(call);
            const input = evaluationSchema.parse(call.input);
            const target = input.questions.target;
            if (target.type !== "choice") {
                throw new Error("Expected target choice");
            }
            const choices = Object.keys(target.criteria);
            const choice = choices.find((key) => key !== "abstain")!;
            return evaluation({
                target: {
                    type: "choice",
                    choice,
                    probabilities: Object.fromEntries(choices.map((key) => [key, key === choice ? 1 : 0])),
                },
            });
        },
    });
    const run = f.native.run;
    f.native.run = async (call) => {
        if (call.args[0] === "act") {
            f.snapshot.elements[2].AXValue = "saved";
        }
        return run(call);
    };
    const result = await f.computer.assist_task({
        app: "Fixture",
        goal: "Save changes",
        chooser: "jev",
        jev: true,
        provider: "typesafe",
        exact: { identifier: "name", value: "saved" },
        max_steps: 1,
        max_requests: 1,
    });
    expect(result.status).toBe("verified");
    expect(result.metrics.actions).toBe(1);
    expect(result.metrics.requests).toBe(1);
    expect(evaluations[0].provider).toBe("typesafe");
    expect(f.calls.find((args) => args[0] === "act")).not.toContain("--prepare");
    expect(() => f.computer.find({ app: "Fixture", query: "Save" })).toThrow("get_app_state");
});
test("standalone assist cannot recover uncertain delivery or spend above its request cap", async () => {
    const f = fixture({
        evaluate: async () => {
            throw new Error("No request is permitted");
        },
    });
    const run = f.native.run;
    f.native.run = async (call) => {
        const result = await run(call);
        if (call.args[0] === "act") {
            return { ...result, ok: false, dispatchState: "uncertain", error: "Lost reply" };
        }
        return result;
    };
    const capped = await f.computer.assist_task({
        app: "Fixture",
        goal: "Save changes",
        chooser: "jev",
        jev: true,
        exact: { identifier: "name", value: "saved" },
        max_requests: 0,
    });
    expect(capped.status).toBe("stopped");
    expect(capped.metrics.actions).toBe(0);
    const uncertain = await f.computer.assist_task({
        app: "Fixture",
        goal: "Save",
        chooser: "auto",
        jev: true,
        exact: { identifier: "name", value: "saved" },
        max_requests: 0,
        recovery: { mode: "bounded" },
    });
    // This fixture contains a secure field; recovery must stop before dispatch.
    expect(uncertain.status).toBe("stopped");
    expect(uncertain.reason).toContain("Authentication");
    f.snapshot.elements.splice(3, 1);
    const lost = await f.computer.assist_task({
        app: "Fixture",
        goal: "Save",
        chooser: "auto",
        jev: true,
        exact: { identifier: "name", value: "saved" },
        max_requests: 0,
        recovery: { mode: "bounded" },
    });
    expect(lost.status).toBe("unknown");
    expect(lost.metrics.actions).toBe(1);
    expect(lost.metrics.requests).toBe(0);
    expect(lost.recoveries[0].category).toBe("transport_uncertainty");
    expect(f.calls.filter((args) => args[0] === "act")).toHaveLength(1);
    const controller = new AbortController();
    controller.abort();
    await expect(
        f.computer.assist_task({
            app: "Fixture",
            goal: "Save",
            signal: controller.signal,
            exact: { identifier: "name", value: "saved" },
        })
    ).rejects.toThrow();
    expect(f.calls.filter((args) => args[0] === "act")).toHaveLength(1);
});
test("standalone semantic form fill requires Jev, keeps supplied values local and invalidates old refs", async () => {
    const calls: Parameters<Evaluator>[0][] = [];
    const evaluate: Evaluator = async (call) => {
        calls.push(call);
        const input = evaluationSchema.parse(call.input);
        const target = input.questions.target;
        if (target.type !== "choice") {
            throw new Error("Expected a target choice.");
        }
        const choices = Object.keys(target.criteria);
        const choice = choices.find((value) => value !== "abstain") ?? "abstain";
        return evaluation({
            target: {
                type: "choice",
                choice,
                probabilities: Object.fromEntries(choices.map((value) => [value, value === choice ? 1 : 0])),
            },
        });
    };
    const f = fixture({ evaluate });
    await expect(
        invokeComputerTool({
            computer: f.computer,
            name: "fill_form",
            input: { app: "Fixture", data: { name: "Private Person" } },
        })
    ).rejects.toThrow();
    const wrongDocument = await f.computer.fill_form({
        app: "Fixture",
        data: { name: "Private Person" },
        window_id: 10,
        expected_url: "https://example.test/form",
        jev: true,
        provider: "typesafe",
    });
    expect(wrongDocument.status).toBe("stopped");
    expect(wrongDocument.reason).toContain("expected_url");
    expect(calls).toHaveLength(0);
    const result = await f.computer.fill_form({
        app: "Fixture",
        data: { name: "Private Person" },
        window_id: 10,
        jev: true,
        provider: "typesafe",
    });
    expect(result.status).toBe("filled");
    expect(result.reason).toContain("not submitted");
    expect(f.snapshot.elements[2].AXValue).toBe("Private Person");
    expect(calls).toHaveLength(1);
    expect(calls[0].provider).toBe("typesafe");
    expect(SafeJSON.stringify(calls[0].input)).not.toContain("Private Person");
    expect(f.calls.find((args) => args.includes("--action") && args.includes("set"))).not.toContain("--prepare");
    expect(() => f.computer.find({ app: "Fixture", query: "name" })).toThrow("get_app_state");
});
test("structured fill admits dropdowns once and never sends selected or supplied values to Jev", async () => {
    const inputs: unknown[] = [];
    const f = fixture({
        evaluate: async (call) => {
            inputs.push(call.input);
            const input = evaluationSchema.parse(call.input);
            const target = input.questions.target;
            if (target.type !== "choice") {
                throw new Error("Expected target choice");
            }
            const entries = Object.entries(target.criteria);
            const dropdown = entries.find(
                ([, value]) =>
                    typeof value === "object" && value !== null && "role" in value && value.role === "AXPopUpButton"
            );
            const choice = dropdown?.[0] ?? entries.find(([key]) => key !== "abstain")?.[0] ?? "abstain";
            return evaluation({
                target: {
                    type: "choice",
                    choice,
                    probabilities: Object.fromEntries(entries.map(([key]) => [key, key === choice ? 1 : 0])),
                },
            });
        },
    });
    f.snapshot.elements.push({
        index: 4,
        depth: 1,
        role: "AXPopUpButton",
        AXIdentifier: "priority",
        AXDescription: "Priority",
        AXValue: "Current private option",
        valueSettable: false,
        actions: ["AXPress"],
    });
    const result = await f.computer.fill_form({
        app: "Fixture",
        data: { priority: "Private selected option", name: "Private name" },
        jev: true,
    });
    expect(result.status).toBe("filled");
    expect(result.filled.map((item) => item.binding)).toEqual(["id:priority", "id:name"]);
    expect(f.snapshot.elements[4].AXValue).toBe("Private selected option");
    expect(inputs).toHaveLength(2);
    for (const value of ["Current private option", "Private selected option", "Private name"]) {
        expect(SafeJSON.stringify(inputs)).not.toContain(value);
    }
});
test("form fill stops on native validation errors even when the supplied value reads back exactly", async () => {
    const f = fixture({
        evaluate: async (call) => {
            const input = evaluationSchema.parse(call.input);
            const target = input.questions.target;
            if (target.type !== "choice") {
                throw new Error("Expected target choice");
            }
            return evaluation({ target: { type: "choice", choice: "c0", probabilities: { c0: 1, abstain: 0 } } });
        },
    });
    const run = f.native.run;
    f.native.run = async (call) => {
        if (call.args[0] === "act") {
            f.snapshot.elements[2].AXInvalid = "1";
        }
        return run(call);
    };
    const result = await f.computer.fill_form({
        app: "Fixture",
        data: { name: "Rejected value", next: "Must not be written" },
        jev: true,
    });
    expect(result.status).toBe("stopped");
    expect(result.reason).toContain("validation error");
    expect(f.snapshot.elements[2].AXValue).toBe("Rejected value");
    expect(f.calls.filter((args) => args[0] === "act")).toHaveLength(1);
});
test("standalone workflows use native writes without preparation and require Jev before selector repair", async () => {
    let evaluationCalls = 0;
    const evaluate: Evaluator = async () => {
        evaluationCalls++;
        throw new Error("Exact workflow must not call Jev.");
    };
    const f = fixture({ evaluate });
    await expect(
        invokeComputerTool({
            computer: f.computer,
            name: "run_workflow",
            input: {
                plan: {
                    version: 1,
                    app: "Fixture",
                    steps: [
                        {
                            id: "name",
                            action: "set",
                            selector: { identifier: "name" },
                            intent: "Fill the name",
                            valueRef: "name",
                            postcondition: {
                                expect: "Name was filled",
                                exact: { identifier: "name", valueRef: "name" },
                            },
                        },
                    ],
                },
                values: { name: "Local Value" },
                rebind: true,
            },
        })
    ).rejects.toThrow("jev:true");
    f.snapshot.elements.splice(3, 1);
    const result = await f.computer.run_workflow({
        plan: {
            version: 1,
            app: "Fixture",
            steps: [
                {
                    id: "focus-name",
                    action: "focus",
                    selector: { label: "name" },
                    intent: "Focus the name",
                    postcondition: {
                        expect: "Name is focused",
                        exact: { label: "name", role: "AXTextField", attribute: "AXFocused", value: "true" },
                    },
                },
                {
                    id: "name",
                    action: "set",
                    selector: { label: "name" },
                    intent: "Fill the name",
                    valueRef: "name",
                    postcondition: {
                        expect: "Name was filled",
                        exact: { label: "name", role: "AXTextField", valueRef: "name" },
                    },
                },
            ],
        },
        values: { name: "Local Value" },
        max_requests: 0,
    });
    expect(result.status, SafeJSON.stringify(result)).toBe("verified");
    expect(result.metrics.actions).toBe(2);
    expect(f.snapshot.elements[2].AXValue).toBe("Local Value");
    const focus = f.calls.find((args) => args.includes("--action") && args.includes("focus"));
    const set = f.calls.find((args) => args.includes("--action") && args.includes("set"));
    expect(focus).not.toContain("--prepare");
    expect(set).not.toContain("--prepare");
    expect(evaluationCalls).toBe(0);
});
test("workflow document pin applies to action readback, even when the new page satisfies the postcondition", async () => {
    for (const changed of [false, true]) {
        const f = fixture({
            evaluate: async () => {
                throw new Error("Exact workflow must not call Jev");
            },
        });
        f.snapshot.elements.splice(3, 1);
        f.snapshot.elements.push({ index: 4, depth: 1, role: "AXWebArea", AXURL: "https://example.test/form" });
        const computer = new ComputerUse({
            native: {
                run: async (call) => {
                    if (changed && call.args[0] === "act") {
                        f.snapshot.elements[3].AXURL = "https://example.test/other-form";
                    }
                    return f.native.run(call);
                },
            },
        });
        const result = await computer.run_workflow({
            plan: {
                version: 1,
                app: "Fixture",
                steps: [
                    {
                        id: "name",
                        action: "set",
                        selector: { identifier: "name" },
                        intent: "Fill name",
                        valueRef: "name",
                        postcondition: { expect: "Name filled", exact: { identifier: "name", valueRef: "name" } },
                    },
                ],
            },
            values: { name: "Local Value" },
            expected_url: "https://example.test/form",
            max_requests: 0,
        });
        expect(result.status).toBe(changed ? "unknown" : "verified");
        if (changed) {
            expect(SafeJSON.stringify(result)).toContain("expected_url");
        }
        expect(f.calls.filter((args) => args[0] === "act")).toHaveLength(1);
        expect(f.calls.filter((args) => args[0] === "see")).toHaveLength(1);
    }
});
test("automatic preparation keeps native writes unfocused and still prepares browser inputs", async () => {
    for (const mode of ["native", "web"] as const) {
        const f = fixture({
            evaluate: async () => {
                throw new Error("Exact workflow must not call Jev");
            },
        });
        f.snapshot.elements.splice(3, 1);
        const field = f.snapshot.elements[2];
        if (mode === "web") {
            f.snapshot.elements.splice(2, 0, { index: 4, depth: 1, role: "AXWebArea" });
            field.depth = 2;
        }
        const result = await f.computer.run_workflow({
            plan: {
                version: 1,
                app: "Fixture",
                steps: [
                    {
                        id: "fill",
                        action: "set",
                        selector: { identifier: "name" },
                        intent: "Fill name",
                        valueRef: "name",
                        postcondition: { expect: "Name is filled", exact: { identifier: "name", valueRef: "name" } },
                    },
                ],
            },
            values: { name: "Local name" },
            max_requests: 0,
        });
        expect(result.status, SafeJSON.stringify(result)).toBe("verified");
        const action = f.calls.find((args) => args[0] === "act")!;
        expect(action.includes("--prepare")).toBe(mode !== "native");
        expect(action[action.indexOf("--action") + 1]).toBe(mode === "web" ? "paste" : "set");
        expect(action.includes("--replace")).toBe(mode === "web");
    }
});
test("standalone semantic waits require explicit Jev and reject changed scope before any request", async () => {
    const f = fixture();
    await expect(
        invokeComputerTool({
            computer: f.computer,
            name: "await_condition",
            input: { app: "Fixture", condition: "Ready" },
        })
    ).rejects.toThrow();
    expect(f.calls).toHaveLength(0);
    await f.computer.get_app_state({ app: "Fixture", image: false });
    f.snapshot.pid = 8;
    const result = await f.computer.await_condition({ app: "Fixture", condition: "Ready", jev: true, max_requests: 1 });
    expect(result.status).toBe("stopped");
    expect(result.reason).toContain("instance or window changed");
    expect(result.metrics.requests).toBe(0);
    expect(result.refreshRequired).toBe(true);
    expect(() => f.computer.find({ app: "Fixture", query: "Save" })).toThrow("get_app_state");
    f.computer.close_session();
});

test("standalone exact waits use no AI and enforce the expected document", async () => {
    const f = fixture({
        evaluate: async () => {
            throw new Error("Exact wait must not call Jev");
        },
    });
    await f.computer.get_app_state({ app: "Fixture", image: false });
    const ready = await f.computer.await_condition({
        app: "Fixture",
        condition: "Name unchanged",
        exact: { identifier: "name", value: "old" },
        max_requests: 0,
    });
    expect(ready.status).toBe("ready");
    expect(ready.metrics.requests).toBe(0);
    expect(ready.metrics.actions).toBe(0);
    expect(ready.refreshRequired).toBe(true);
    await f.computer.get_app_state({ app: "Fixture", image: false });
    const wrongDocument = await f.computer.await_condition({
        app: "Fixture",
        condition: "Name unchanged",
        exact: { identifier: "name", value: "old" },
        expected_url: "https://example.test/form",
        max_requests: 0,
    });
    expect(wrongDocument.status).toBe("stopped");
    expect(wrongDocument.reason).toContain("expected_url");
    expect(f.calls.every((args) => args[0] === "see")).toBe(true);
});
test("public wait evidence scopes select one subtree and refuse an ambiguous container", async () => {
    const f = fixture({
        evaluate: async () => {
            throw new Error("Exact scoped wait must not call Jev");
        },
    });
    for (const duplicate of [false, true]) {
        if (duplicate) {
            f.snapshot.elements.push({ ...f.snapshot.elements[2], index: 4 });
        }
        await f.computer.get_app_state({ app: "Fixture", image: false });
        const result = await f.computer.await_condition({
            app: "Fixture",
            condition: "Name unchanged",
            exact: { identifier: "name", value: "old" },
            evidence_scope: { identifier: "name", role: "AXTextField" },
            max_requests: 0,
        });
        expect(result.status).toBe(duplicate ? "stopped" : "ready");
        expect(result.metrics.requests).toBe(0);
        if (duplicate) {
            expect(result.reason).toContain("ambiguous");
        }
    }
    expect(f.calls.every((args) => args[0] === "see")).toBe(true);
});
test("prepared clicks use AXPress when exposed and reserve pointer dispatch for explicit physical clicks", async () => {
    const f = fixture();
    const state = await f.computer.get_app_state({ app: "Fixture", image: false });
    const result = await f.computer.click({ app: "Fixture", element_ref: state.elements[1].ref, prepare: true });
    expect(result.ok).toBe(true);
    const dispatch = f.calls.at(-1)!;
    expect(dispatch).toContain("--prepare");
    expect(dispatch).not.toContain("--background");
    expect(dispatch[dispatch.indexOf("--action") + 1]).toBe("press");
    const physicalState = await f.computer.get_app_state({ app: "Fixture", image: false });
    await f.computer.click({
        app: "Fixture",
        element_ref: physicalState.elements[1].ref,
        prepare: true,
        physical: true,
    });
    const physicalDispatch = f.calls.at(-1)!;
    expect(physicalDispatch).toContain("--prepare");
    expect(physicalDispatch[physicalDispatch.indexOf("--action") + 1]).toBe("click");
    const fresh = await f.computer.get_app_state({ app: "Fixture", image: false });
    await expect(
        f.computer.click({ app: "Fixture", revision: fresh.revision, x: 10, y: 20, prepare: true })
    ).rejects.toThrow("observed element");
    f.computer.close_session();
});

test("prepared web activation uses the focused keyboard contract instead of an unreliable browser AXPress", async () => {
    const f = fixture();
    f.snapshot.elements.push(
        { index: 4, depth: 1, role: "AXWebArea", AXTitle: "Fixture page", actions: [] },
        { index: 5, depth: 2, role: "AXButton", AXTitle: "Continue", actions: ["AXPress"] }
    );
    const state = await f.computer.get_app_state({ app: "Fixture", image: false });
    const target = f.computer.find({ app: "Fixture", query: "Continue", role: "AXButton" }).elements[0];
    const result = await f.computer.click({ app: "Fixture", element_ref: target.ref, prepare: true });
    expect(result.ok).toBe(true);
    const dispatch = f.calls.at(-1)!;
    expect(dispatch[dispatch.indexOf("--action") + 1]).toBe("key");
    expect(dispatch[dispatch.indexOf("--keys") + 1]).toBe("space");
    expect(dispatch).toContain("--prepare");
    expect(state.page.total).toBe(6);
});

test("an unprepared click that takes AXPress pins its row by identity, as a background click does", async () => {
    const f = fixture();
    const stable = "a".repeat(64);
    Object.assign(f.snapshot.elements[1], { stableKey: stable, targetKey: "b".repeat(64) });
    const state = await f.computer.get_app_state({ app: "Fixture", image: false });
    const result = await f.computer.click({ app: "Fixture", element_ref: state.elements[1].ref });
    expect(result.ok).toBe(true);
    const dispatch = f.calls.at(-1)!;
    expect(dispatch[dispatch.indexOf("--action") + 1]).toBe("press");
    expect(dispatch).not.toContain("--prepare");
    // The stable key first: a live window re-renders between observe and act, and the whole-window
    // digest would refuse the press with "UI changed".
    expect(dispatch[dispatch.indexOf("--target-key") + 1]).toBe(stable);
    expect(dispatch[dispatch.indexOf("--revalidate-scope") + 1]).toBe("element");
});

test("prepared web form writes replace through clipboard-safe paste while native fields retain AXValue", async () => {
    const f = fixture();
    f.snapshot.elements.push(
        { index: 4, depth: 1, role: "AXWebArea", AXTitle: "Fixture page", actions: [] },
        {
            index: 5,
            depth: 2,
            role: "AXTextArea",
            AXTitle: "Notes",
            AXValue: "old",
            valueSettable: true,
        }
    );
    const state = await f.computer.get_app_state({ app: "Fixture", image: false });
    const webField = f.computer.find({ app: "Fixture", query: "Notes", role: "AXTextArea" }).elements[0];
    await f.computer.set_value({ app: "Fixture", element_ref: webField.ref, value: "new", prepare: true });
    const webDispatch = f.calls.at(-1)!;
    expect(webDispatch[webDispatch.indexOf("--action") + 1]).toBe("paste");
    expect(webDispatch).toContain("--replace");
    expect(webDispatch).toContain("--prepare");
    const nativeState = await f.computer.get_app_state({ app: "Fixture", image: false });
    const nativeField = f.computer.find({ app: "Fixture", query: "name", role: "AXTextField" }).elements[0];
    await f.computer.set_value({ app: "Fixture", element_ref: nativeField.ref, value: "native", prepare: true });
    const nativeDispatch = f.calls.at(-1)!;
    expect(nativeDispatch[nativeDispatch.indexOf("--action") + 1]).toBe("set");
    expect(nativeDispatch).not.toContain("--replace");
    expect(state.page.total).toBe(6);
    expect(nativeState.page.total).toBe(6);
});

test("explicit paste replacement requires preparation and does not alter default insert semantics", async () => {
    const f = fixture();
    let state = await f.computer.get_app_state({ app: "Fixture", image: false });
    const field = state.elements.find((row) => row.identifier === "name")!;
    await expect(
        f.computer.paste({ app: "Fixture", element_ref: field.ref, text: "replacement", replace: true })
    ).rejects.toThrow("prepare:true");
    expect(f.calls.filter((args) => args[0] === "act")).toHaveLength(0);
    const replaced = await f.computer.paste({
        app: "Fixture",
        element_ref: field.ref,
        text: "replacement",
        replace: true,
        prepare: true,
    });
    expect(replaced.ok).toBe(true);
    expect(f.snapshot.elements[2].AXValue).toBe("replacement");
    expect(f.calls.at(-1)).toContain("--replace");
    expect(replaced.clipboardRestore).toBe("restored");
    state = await f.computer.get_app_state({ app: "Fixture", image: false });
    await f.computer.paste({
        app: "Fixture",
        element_ref: state.elements.find((row) => row.identifier === "name")!.ref,
        text: "insert",
    });
    expect(f.calls.at(-1)).not.toContain("--replace");
});

test("Jev target admission excludes controls behind a visible sheet", async () => {
    const f = fixture({
        evaluate: async (call) => {
            const input = evaluationSchema.parse(call.input);
            const question = input.questions.target;
            if (question.type !== "choice") {
                throw new Error("Expected choice");
            }
            const options = SafeJSON.stringify(question.criteria);
            expect(options).not.toContain("Save");
            expect(options).toContain("OK");
            return evaluation({ target: { type: "choice", choice: "c0", probabilities: { c0: 1, abstain: 0 } } });
        },
    });
    f.snapshot.elements.push(
        { index: 4, depth: 1, role: "AXSheet", visible: true },
        { index: 5, depth: 2, role: "AXButton", AXTitle: "OK", actions: ["AXPress"] }
    );
    await f.computer.get_app_state({ app: "Fixture", image: false });
    const result = await f.computer.resolve_target({
        app: "Fixture",
        intent: "Acknowledge the displayed error",
        chooser: "jev",
    });
    expect(result.selected?.label).toBe("OK");
    const blocked = await f.computer.resolve_target({
        app: "Fixture",
        intent: "Save",
        query: "Save",
        chooser: "exact",
        binding: { label: "Save" },
    });
    expect(blocked.selected).toBeNull();
});

test("explicit role and text narrowing keeps large-page target resolution bounded", async () => {
    const f = fixture();
    for (let i = 4; i < 410; i++) {
        f.snapshot.elements.push({ index: i, depth: 1, role: "AXStaticText", AXValue: "Unrelated page content" });
    }
    await f.computer.get_app_state({ app: "Fixture", image: false });
    const result = await f.computer.resolve_target({ app: "Fixture", intent: "Save", query: "Save", role: "AXButton" });
    expect(result.status).toBe("resolved");
    expect(result.selected?.label).toBe("Save");
    expect(result.metrics.requests).toBe(0);
    f.computer.close_session();
});

test("unstable read-only observations settle internally without dispatching actions", async () => {
    const f = fixture();
    let calls = 0;
    const computer = new ComputerUse({
        native: {
            run: async (call) => {
                calls++;
                if (calls === 1) {
                    return { ok: false, error: "UI changed during observation; run see again" };
                }
                return f.native.run(call);
            },
        },
    });
    const state = await computer.get_app_state({ app: "Fixture", image: false });
    expect(state.elements[1].label).toBe("Save");
    expect(calls).toBe(2);
    expect(f.calls.every((args) => args[0] === "see")).toBe(true);
    computer.close_session();
});

describe("independent Computer Use session", () => {
    test("retains state, returns differences and masks secure values", async () => {
        const { computer, snapshot } = fixture();
        snapshot.elements.push({
            index: 4,
            depth: 1,
            role: "AXWebArea",
            AXTitle: "Fixture page",
            AXURL: "https://example.test/form",
        });
        snapshot.elements.push({
            index: 5,
            depth: 3,
            role: "AXWebArea",
            AXTitle: "Extension frame",
            AXURL: "chrome-extension://fixture/popup.html",
        });
        const first = await computer.get_app_state({ app: "Fixture", image: false });
        expect(first.text).not.toContain("SECRET");
        expect(first.elements[3].value).toBe("[secure]");
        expect(first.document).toEqual({
            url: "https://example.test/form",
            title: "Fixture page",
            ref: first.elements[4].ref,
        });
        snapshot.elements[1].AXTitle = "Save changes";
        const next = await computer.get_app_state({ app: "Fixture", image: false });
        expect(next.revision).not.toBe(first.revision);
        expect(next.changes?.added).toHaveLength(1);
        expect(next.text).toContain("Save changes");
        expect(computer.find({ app: "Fixture", query: "save" }).elements[0].ref).toBe(next.elements[1].ref);
    });
    test("dispatches observed AXPress and refuses old refs or implicit reuse", async () => {
        const { computer, calls } = fixture();
        const state = await computer.get_app_state({ app: "Fixture", image: false });
        const click = await computer.click({ app: "Fixture", element_ref: state.elements[1].ref });
        expect(click.ok).toBe(true);
        expect(click.action.native).toBe("press");
        expect(calls[1]).toContain("--no-image");
        await expect(computer.click({ app: "Fixture", element_ref: state.elements[1].ref })).rejects.toThrow(
            "different observation"
        );
        await expect(computer.click({ app: "Fixture", element_index: 1 })).rejects.toThrow("After an action");
        expect(calls).toHaveLength(2);
        expect(click.state).toBeDefined();
        const next = await computer.click({ app: "Fixture", element_ref: click.state!.elements[1].ref });
        expect(next.ok).toBe(true);
    });
    test("converts source pixels to Retina screen coordinates with a negative origin", async () => {
        const { computer, calls } = fixture();
        await computer.get_app_state({ app: "Fixture" });
        await computer.click({ app: "Fixture", x: 200, y: 100 });
        expect(calls[1]).toContain("-400,150");
        expect(calls[1]).toContain("--background");
        const state = await computer.get_app_state({ app: "Fixture" });
        await expect(computer.click({ app: "Fixture", revision: state.revision, x: 801, y: 10 })).rejects.toThrow(
            "outside"
        );
        expect(calls).toHaveLength(3);
    });
    test("literal values, context selection and normalized secondary actions keep native argv separate", async () => {
        const { computer, calls } = fixture();
        let state = await computer.get_app_state({ app: "Fixture", image: false });
        let result = await computer.set_value({
            app: "Fixture",
            element_ref: state.elements[2].ref,
            value: "--background",
        });
        expect(calls[1].slice(calls[1].indexOf("--value"), calls[1].indexOf("--value") + 2)).toEqual([
            "--value",
            "--background",
        ]);
        state = result.state!;
        result = await computer.select_text({
            app: "Fixture",
            element_ref: state.elements[2].ref,
            text: "background",
            prefix: "--",
            selection_type: "cursor_after",
        });
        expect(calls[2]).toContain("cursor_after");
        state = result.state!;
        await computer.perform_secondary_action({
            app: "Fixture",
            element_ref: state.elements[1].ref,
            action: "show_menu",
        });
        expect(calls[3]).toContain("AXShowMenu");
        const fresh = await computer.get_app_state({ app: "Fixture", image: false });
        await expect(
            computer.perform_secondary_action({
                app: "Fixture",
                element_ref: fresh.elements[1].ref,
                action: "launch anything",
            })
        ).rejects.toThrow("exposed");
    });
    test("focused typing and app key aliases use snapshot-scoped input without global fallback", async () => {
        const { computer, calls } = fixture();
        const state = await computer.get_app_state({ app: "Fixture", image: false });
        const typed = await computer.type_text({ app: "Fixture", text: "Příliš 🐈" });
        expect(calls[1]).toContain("Příliš 🐈");
        expect(calls[1]).toContain("2");
        await computer.press_key({ app: "Fixture", revision: typed.state!.revision, key: "super+a" });
        expect(calls[2]).toContain("cmd,a");
        await expect(
            computer.type_text({ app: "Fixture", revision: state.revision, text: "line\nsubmit" })
        ).rejects.toThrow("multiline");
        expect(calls).toHaveLength(3);
    });
    test("retains explicit chrome scope and rejects app replacement", async () => {
        const { computer, snapshot, calls } = fixture();
        await computer.get_app_state({ app: "Fixture", scope: "chrome", image: false });
        await computer.get_app_state({ app: "Fixture", image: false });
        expect(calls[1]).toContain("chrome");
        snapshot.processLaunch = 124;
        await expect(computer.get_app_state({ app: "Fixture", image: false })).rejects.toThrow("process changed");
        await expect(computer.click({ app: "Fixture", element_index: 1 })).rejects.toThrow("get_app_state");
    });
    test("close_session drops references without quitting the actual app", async () => {
        const { computer, calls } = fixture();
        await computer.get_app_state({ app: "Fixture", image: false });
        computer.close_session({ app: "Fixture" });
        await expect(computer.click({ app: "Fixture", element_index: 1 })).rejects.toThrow("get_app_state");
        expect(calls).toHaveLength(1);
        expect(await computer.list_apps()).toEqual([
            { id: "example.fixture", displayName: "Fixture", pid: 7, isRunning: true, frontmost: true, hidden: false },
        ]);
    });
});
test("native MCP advertises and dispatches its own tools; unknown names use protocol errors", async () => {
    const { computer, calls } = fixture();
    const server = createComputerMcpServer({ computer });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "fixture-client", version: "1" });
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
    try {
        const listed = await client.listTools();
        expect(listed.tools.map((tool) => tool.name)).toContain("get_app_state");
        expect(listed.tools.map((tool) => tool.name)).toContain("paste");
        expect(listed.tools.map((tool) => tool.name)).toContain("fill_form");
        expect(listed.tools.map((tool) => tool.name)).toContain("run_workflow");
        expect(listed.tools.map((tool) => tool.name)).toContain("assist_task");
        const state = await client.callTool({ name: "get_app_state", arguments: { app: "Fixture", image: false } });
        expect(state.isError).toBe(false);
        const acted = await client.callTool({ name: "click", arguments: { app: "Fixture", element_index: 1 } });
        expect(acted.isError).toBe(false);
        expect(calls).toHaveLength(2);
        await expect(client.callTool({ name: "unknown", arguments: {} })).rejects.toThrow("Unknown tool");
    } finally {
        await client.close();
        await server.close();
    }
});
test("window inventory preserves native IDs independently of duplicate titles and ordering", async () => {
    const rows = [101, 202].map((window_id) => ({
        window_id,
        title: "Same title",
        x: 0,
        y: 0,
        width: 800,
        height: 600,
    }));
    const computer = new ComputerUse({ native: { run: async () => ({ ok: true, windows: rows }) } });
    const first = await computer.list_windows({ app: "Fixture" });
    rows.reverse();
    const second = await computer.list_windows({ app: "Fixture" });
    expect(first.windows.map((window) => window.window_id)).toEqual([101, 202]);
    expect(second.windows.map((window) => window.window_id)).toEqual([202, 101]);
    expect(second.windows.map((window) => window.window_index)).toEqual([0, 1]);
});
test("unnamed browser status text has an exact readable label without treating editable values as labels", async () => {
    const f = fixture({
        evaluate: async () => {
            throw new Error("Exact text check must not call Jev");
        },
    });
    f.snapshot.elements.push({ index: 4, depth: 1, role: "AXStaticText", AXValue: "0 items left!" });
    const state = await f.computer.get_app_state({ app: "Fixture", image: false });
    expect(state.elements.find((row) => row.index === 4)?.label).toBe("0 items left!");
    expect(state.elements.find((row) => row.index === 2)?.label).toBe("name");
    const verified = await f.computer.verify_state({
        app: "Fixture",
        expect: "Nothing remains",
        exact: { label: "0 items left!", role: "AXStaticText", value: "0 items left!" },
    });
    expect(verified.status).toBe("verified");
    f.snapshot.elements[4].AXValue = "1 item left!";
    const changed = await f.computer.verify_state({
        app: "Fixture",
        expect: "Nothing remains",
        exact: { label: "0 items left!", role: "AXStaticText", value: "0 items left!" },
    });
    expect(changed.status).not.toBe("verified");
});
test("Computer Use REPL bootstraps its own API and retains bindings across cells", async () => {
    const engine = new ComputerReplEngine();
    try {
        const first = await engine.run("const retained = computer; computer.target");
        expect(first.ok).toBe(true);
        expect(first.text).toBe("mac");
        const next = await engine.run("retained === computer");
        expect(next.ok).toBe(true);
        expect(next.text).toBe("true");
    } finally {
        engine.dispose();
    }
});

test("a thrown native transport invalidates all old refs without repeating the action", async () => {
    const f = fixture();
    const original = f.native.run;
    let attempts = 0;
    f.native.run = async (call) => {
        if (call.args[0] === "act") {
            attempts++;
            throw new Error("Lost delivery");
        }
        return original(call);
    };
    const state = await f.computer.get_app_state({ app: "Fixture", image: false });
    const result = await f.computer.click({ app: "Fixture", element_ref: state.elements[1].ref });
    expect(result.ok).toBe(false);
    expect(result.action.effect).toBe("unknown");
    await expect(f.computer.click({ app: "Fixture", element_ref: state.elements[1].ref })).rejects.toThrow(
        "get_app_state"
    );
    expect(attempts).toBe(1);
});

test("Computer Use exposes exact choices and readbacks without enabling Jev implicitly", async () => {
    const { computer, calls } = fixture();
    await computer.get_app_state({ app: "Fixture", image: false });
    const choice = await computer.resolve_target({ app: "Fixture", intent: "Save" });
    expect(choice.source).toBe("exact");
    expect(choice.ref).not.toBeNull();
    expect(choice.metrics.requests).toBe(0);
    await expect(computer.verify_state({ app: "Fixture", expect: "Saved" })).rejects.toThrow("explicitly enable Jev");
    expect(calls).toHaveLength(1);
    const readback = await computer.verify_state({
        app: "Fixture",
        expect: "Original value",
        exact: { identifier: "name", value: "old" },
    });
    expect(readback.status).toBe("verified");
    expect(readback.metrics.requests).toBe(0);
    expect(calls).toHaveLength(2);
});

test("native lifecycle uses exact launch targets and observed quit identity without force termination", async () => {
    const f = fixture();
    const run = f.native.run;
    f.native.run = async (call) => {
        if (call.args[0] === "launch-app" || call.args[0] === "quit-app") {
            f.calls.push(call.args);
            return { ok: true, requestAccepted: true, terminated: false };
        }
        return run(call);
    };
    await expect(
        f.computer.launch_app({ bundle_id: "example.fixture", path: "/Applications/Fixture.app" })
    ).rejects.toThrow("Choose");
    expect(f.calls).toHaveLength(0);
    await f.computer.launch_app({ bundle_id: "example.fixture", activate: false });
    expect(f.calls[0]).toEqual(["launch-app", "--bundle-id", "example.fixture", "--background"]);
    await expect(f.computer.quit_app({ app: "Fixture" })).rejects.toThrow("get_app_state");
    const state = await f.computer.get_app_state({ app: "Fixture", image: false });
    await expect(f.computer.quit_app({ app: "Fixture", revision: "stale" })).rejects.toThrow("replaced");
    const result = await f.computer.quit_app({ app: "Fixture", revision: state.revision });
    expect(result.terminated).toBe(false);
    expect(f.calls.at(-1)).toEqual(["quit-app", "--pid", "7", "--launch", "123"]);
    expect(() => f.computer.find({ app: "Fixture", query: "Save" })).toThrow("get_app_state");
});

test("large states page without extra native calls and find still searches beyond display limits", async () => {
    const f = fixture();
    f.snapshot.elements.push(
        ...Array.from({ length: 250 }, (_, offset) => ({
            index: offset + 4,
            depth: 1,
            role: "AXButton",
            AXTitle: `Item ${offset}`,
            AXIdentifier: `item-${offset}`,
            AXValue: offset === 249 ? `${"x".repeat(900)}rare suffix` : "ready",
            actions: ["AXPress"],
        }))
    );
    const state = await f.computer.get_app_state({ app: "Fixture", image: false });
    expect(state.elements).toHaveLength(100);
    expect(state.page).toEqual({ offset: 0, limit: 100, total: 254, nextOffset: 100 });
    const page = f.computer.get_elements({
        app: "Fixture",
        revision: state.revision,
        offset: 250,
        limit: 4,
        text_limit: 1000,
    });
    expect(page.elements.at(-1)?.identifier).toBe("item-249");
    expect(page.elements.at(-1)?.value).toContain("rare suffix");
    expect(page.observedAt).toBe(state.observedAt);
    expect(f.calls).toHaveLength(1);
    const found = f.computer.find({ app: "Fixture", query: "rare suffix" });
    expect(found.total).toBe(1);
    expect(found.elements[0].truncated).toContain("value");
    expect(found.elements[0].value).toHaveLength(500);
    expect(f.calls).toHaveLength(1);
    const result = await f.computer.click({ app: "Fixture", element_ref: found.elements[0].ref });
    expect(result.ok).toBe(true);
    expect(result.state?.elements).toHaveLength(100);
    expect(() => f.computer.get_elements({ app: "Fixture", revision: state.revision, offset: 100 })).toThrow(
        "replaced"
    );
});

test("session screenshots are replaced and closed without touching unowned paths", async () => {
    const f = fixture();
    const run = f.native.run;
    const paths: string[] = [];
    f.native.run = async (call) => {
        const result = await run(call);
        const index = call.args.indexOf("--path");
        if (index >= 0) {
            const file = call.args[index + 1];
            paths.push(file);
            await Bun.write(file, "owned image");
        }
        return result;
    };
    const first = await f.computer.get_app_state({ app: "Fixture" });
    expect(await Bun.file(paths[0]).exists()).toBe(true);
    await f.computer.click({ app: "Fixture", element_ref: first.elements[1].ref });
    expect(await Bun.file(paths[0]).exists()).toBe(false);
    expect(await Bun.file(paths[1]).exists()).toBe(true);
    f.computer.close_session();
    expect(await Bun.file(paths[1]).exists()).toBe(false);
    expect(paths[0]).not.toBe(paths[1]);
    await f.computer.get_app_state({ app: "Fixture" });
    f.computer.close_session();
    expect(await Bun.file(paths[2]).exists()).toBe(false);
});

test("menu references are scoped separately, require observed actions and expire after an attempt", async () => {
    const calls: string[][] = [];
    const computer = new ComputerUse({
        native: {
            run: async ({ args }) => {
                calls.push(args);
                if (args[0] === "menu-see") {
                    return {
                        ok: true,
                        app: "Fixture",
                        surface: "menu",
                        pid: 7,
                        processLaunch: 123,
                        snapshot: "menu-token",
                        elements: [
                            { index: 0, depth: 0, role: "AXMenuBar", actions: [] },
                            { index: 1, depth: 1, role: "AXMenuBarItem", AXTitle: "File", actions: ["AXPress"] },
                            { index: 2, depth: 2, role: "AXMenuItem", AXTitle: "Open", actions: ["AXPress"] },
                        ],
                    };
                }
                return { ok: true, dispatchState: "dispatched" };
            },
        },
    });
    const first = await computer.get_menu({ app: "Fixture", query: "Open" });
    expect(first.items[0].path).toEqual(["File", "Open"]);
    await expect(
        computer.perform_menu_action({ app: "Fixture", menu_ref: first.items[0].ref, action: "AXInvented" })
    ).rejects.toThrow("does not expose");
    expect(calls).toHaveLength(1);
    const next = await computer.get_menu({ app: "Fixture", query: "Open" });
    await expect(computer.perform_menu_action({ app: "Fixture", menu_ref: first.items[0].ref })).rejects.toThrow(
        "different observation"
    );
    const result = await computer.perform_menu_action({ app: "Fixture", menu_ref: next.items[0].ref });
    expect(result.ok).toBe(true);
    expect(calls.at(-1)).toContain("menu-act");
    await expect(computer.perform_menu_action({ app: "Fixture", menu_ref: next.items[0].ref })).rejects.toThrow(
        "Inspect the menu"
    );
    expect(calls.filter((args) => args[0] === "menu-act")).toHaveLength(1);
});
