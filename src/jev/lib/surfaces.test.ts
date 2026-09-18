import { describe, expect, test } from "bun:test";
import type { Observation } from "@app/control/lib/decision/observation";
import { runBrowserGoal } from "./browser/goal";
import { mapInput, parseSnapshotText } from "./browser/snapshot";
import type { BrowserDriver, BrowserObservation } from "./browser/types";
import { compactMessages } from "./compact";
import { bool, choice, fakeEvaluator, score } from "./fake-evaluate";
import { runListenPipeline } from "./listen-pipeline";
import { runGoalLoop } from "./loop";
import { observeFanout } from "./observe-fanout";
import { isDestructive, routeUtterance } from "./route";
import { parseTemplates, VERIFY_TEMPLATES, verifyClaims } from "./verify-claims";

const observation: Observation = {
    ok: true,
    app: "Fixture",
    pid: 42,
    snapshot: "snap",
    window: { id: 1, title: "Fixture" },
    scope: "window",
    elements: [
        {
            index: 0,
            depth: 0,
            role: "AXButton",
            AXTitle: "Save",
            actions: ["AXPress"],
            visible: true,
        },
    ],
};

function browserPage(overrides?: Partial<BrowserObservation>): BrowserObservation {
    return {
        url: "http://127.0.0.1/login",
        title: "Login",
        headings: [{ level: 1, text: "Sign in" }],
        candidates: [
            { uid: "e1", role: "textbox", name: "Username", fillable: true, clickable: false },
            { uid: "e2", role: "button", name: "Sign in", fillable: false, clickable: true },
        ],
        ...overrides,
    };
}

describe("observe fan-out", () => {
    test("marks a press dispatchable when target and verb are admitted", async () => {
        const result = await observeFanout({
            observation,
            goal: "Save the document",
            evaluate: fakeEvaluator({
                target: choice("c0", { c0: 0.92, none: 0.08 }),
                verb: choice("press", { press: 0.9, set: 0.02, scroll: 0.02, wait: 0.02, stop: 0.04 }),
                done: bool(0.1),
                blocked: bool(0.05),
                wait: bool(0.05),
                risk: score(0, { "0": 0.8, "1": 0.15, "2": 0.05 }),
            }),
        });
        expect(result.dispatchable).toBe(true);
        expect(result.target.choice).toBe("c0");
    });

    test("is not dispatchable when Jev selects stop", async () => {
        const result = await observeFanout({
            observation,
            goal: "Save",
            evaluate: fakeEvaluator({
                target: choice("none", { c0: 0.1, none: 0.9 }),
                verb: choice("stop", { press: 0.05, set: 0.05, scroll: 0.05, wait: 0.05, stop: 0.8 }),
                done: bool(0.2),
                blocked: bool(0.1),
                wait: bool(0.1),
                risk: score(0, { "0": 1, "1": 0, "2": 0 }),
            }),
        });
        expect(result.dispatchable).toBe(false);
    });
});

describe("route", () => {
    test("flags destructive tools", () => {
        expect(isDestructive("github", "push")).toBe(true);
        expect(isDestructive("github", "pr")).toBe(false);
        expect(isDestructive("apoptosis")).toBe(true);
    });

    test("prints argv without running destructive commands", async () => {
        const result = await routeUtterance({
            utterance: "click the save button",
            srcDir: "/tmp",
            run: true,
            tools: [{ name: "control", description: "macOS UI", hasReadme: true, path: "/tmp/control/index.ts" }],
            evaluate: fakeEvaluator({
                tool: choice("control", { control: 0.94, none: 0.06 }),
                destructive: bool(0.9),
                needs_args: bool(0.1),
            }),
        });
        expect(result.admitted).toBe(true);
        expect(result.argv).toEqual(["tools", "control"]);
        expect(result.run).toBe(false);
        expect(result.reason).toBe("destructive_blocked");
    });
});

describe("compact", () => {
    test("keeps user text and truncates a low-value tool result", async () => {
        const messages = [
            { role: "user" as const, content: "keep me verbatim" },
            {
                role: "assistant" as const,
                content: "ok",
                toolCalls: [
                    { id: "t1", name: "read", input: "{}", result: "x".repeat(800) },
                    { id: "t2", name: "read", input: "{}", result: "fresh" },
                    { id: "t3", name: "read", input: "{}", result: "fresh" },
                    { id: "t4", name: "read", input: "{}", result: "fresh" },
                    { id: "t5", name: "read", input: "{}", result: "fresh" },
                ],
            },
        ];
        const result = await compactMessages({
            messages,
            preserveRecent: 4,
            minReduction: 0.01,
            evaluate: fakeEvaluator({
                keep_call_t1: bool(0.9),
                keep_result_t1: bool(0.1),
            }),
        });
        expect(result.stats.fellBack).toBe(false);
        expect(result.messages[0].content).toBe("keep me verbatim");
        expect(result.messages[1].toolCalls?.[0].result).toContain("truncated");
        expect(result.decisions[0].action).toBe("truncate");
    });

    test("returns original when reduction is too small", async () => {
        const messages = [{ role: "user" as const, content: "hello" }];
        const result = await compactMessages({
            messages,
            evaluate: fakeEvaluator({}),
        });
        expect(result.stats.fellBack).toBe(true);
        expect(result.messages).toEqual(messages);
    });
});

describe("verify", () => {
    test("lists builtin templates", () => {
        expect(VERIFY_TEMPLATES).toContain("pii-names");
        expect(parseTemplates("secrets,prompt-injection")).toEqual(["secrets", "prompt-injection"]);
    });

    test("gates on secrets probability", async () => {
        const result = await verifyClaims({
            against: "token sk-test-fixture-not-real",
            claims: [{ id: "c1", text: "no secrets" }],
            purposes: ["secrets", "accuracy"],
            evaluate: fakeEvaluator({
                secrets: bool(0.81),
                accuracy_c1: bool(0.2),
            }),
        });
        expect(result.gate.block).toBe(true);
        expect(result.gate.reasons).toContain("secrets");
        expect(result.claims.c1.accuracy).toBe(0.2);
    });
});

describe("browser snapshot", () => {
    test("parses uid rows and maps fill inputs", () => {
        const parsed = parseSnapshotText(
            `textbox "Username" uid=e1\nbutton "Sign in" uid=e2\nheading "Run 1842" [level=1]`,
            "http://127.0.0.1/login",
            "Login"
        );
        expect(parsed.candidates).toHaveLength(2);
        expect(parsed.candidates[0].fillable).toBe(true);
        expect(mapInput(parsed.candidates, { Username: "qa-user" }, "e1")).toBe("qa-user");
        expect(mapInput(parsed.candidates, { Username: "qa-user" }, "e2")).toBeUndefined();
        expect(parsed.headings[0]?.text).toBe("Run 1842");
    });
});

describe("browser goal", () => {
    test("fills a mapped field then stops when Jev selects stop", async () => {
        let page = browserPage();
        const driver: BrowserDriver = {
            async observe() {
                return page;
            },
            async dispatch(action) {
                if (action.verb === "fill" && action.text === "qa-user") {
                    page = browserPage({ title: "Filled" });
                    return { ok: true, overlay: false, after: page };
                }
                return { ok: false, overlay: false, error: "unexpected" };
            },
        };
        let calls = 0;
        const result = await runBrowserGoal({
            goal: "Log in as qa-user",
            driver,
            inputs: { Username: "qa-user" },
            evaluate: async () => {
                calls++;
                if (calls === 1) {
                    return fakeEvaluator({
                        target: choice("e1", { e1: 0.91, e2: 0.04, none: 0.05 }),
                        verb: choice("fill", {
                            click: 0.05,
                            fill: 0.85,
                            back: 0.02,
                            scroll: 0.02,
                            wait: 0.02,
                            stop: 0.02,
                            navigate: 0.02,
                        }),
                        done: bool(0.01),
                    })({ input: {} });
                }
                return fakeEvaluator({
                    target: choice("none", { e1: 0.05, e2: 0.05, none: 0.9 }),
                    verb: choice("stop", {
                        click: 0.04,
                        fill: 0.04,
                        back: 0.04,
                        scroll: 0.04,
                        wait: 0.04,
                        stop: 0.76,
                        navigate: 0.04,
                    }),
                    done: bool(0.2),
                })({ input: {} });
            },
        });
        expect(result.steps[0]?.action).toBe("fill");
        expect(result.steps.at(-1)?.action).toBe("stop");
        expect(result.status).toBe("stopped");
    });
});

describe("listen pipeline", () => {
    test("wakes on a phrase then runs one browser decision", async () => {
        const driver: BrowserDriver = {
            async observe() {
                return browserPage();
            },
            async dispatch() {
                return { ok: true, overlay: false, after: browserPage() };
            },
        };
        const events = (async function* () {
            yield { type: "partial" as const, text: "hey gene", tMs: 1, provider: "mock" as const };
            yield { type: "final" as const, text: "hey genesis go back", tMs: 2, provider: "mock" as const };
        })();
        const seen: string[] = [];
        for await (const event of runListenPipeline({
            events,
            driver,
            wakeMode: "contains",
            evaluate: fakeEvaluator({
                target: choice("none", { e1: 0.1, e2: 0.1, none: 0.8 }),
                verb: choice("stop", {
                    click: 0.05,
                    fill: 0.05,
                    back: 0.1,
                    scroll: 0.05,
                    wait: 0.05,
                    stop: 0.65,
                    navigate: 0.05,
                }),
                done: bool(0.1),
            }),
        })) {
            seen.push(event.type);
        }
        expect(seen).toEqual(["partial", "final", "wake", "decision", "stop"]);
    });

    test("jev wake-mode runs the noul instead of throwing", async () => {
        const driver: BrowserDriver = {
            async observe() {
                return browserPage();
            },
            async dispatch() {
                return { ok: true, overlay: false };
            },
        };
        const events = (async function* () {
            yield { type: "final" as const, text: "hey genesis go back", tMs: 1, provider: "mock" as const };
        })();
        const seen: string[] = [];
        for await (const event of runListenPipeline({
            events,
            driver,
            wakeMode: "jev",
            evaluate: fakeEvaluator({
                woke: bool(0.95),
                remainder: choice("after-wake", { "after-wake": 0.9, whole: 0.05, none: 0.05 }),
                destructive: bool(0.05),
                complete: bool(0.9),
                target: choice("none", { e1: 0.1, e2: 0.1, none: 0.8 }),
                verb: choice("stop", {
                    click: 0.05,
                    fill: 0.05,
                    back: 0.1,
                    scroll: 0.05,
                    wait: 0.05,
                    stop: 0.65,
                    navigate: 0.05,
                }),
                done: bool(0.1),
            }),
        })) {
            seen.push(event.type);
        }
        expect(seen).toContain("wake");
        expect(seen).toContain("decision");
    });
});

describe("loop surface selection", () => {
    test("auto without drivers fails closed", async () => {
        await expect(
            runGoalLoop({
                goal: "x",
                surface: "auto",
                evaluate: fakeEvaluator({}),
            })
        ).rejects.toThrow("auto surface");
    });
});
