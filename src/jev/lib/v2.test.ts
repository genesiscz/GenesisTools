import { describe, expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Observation } from "@app/control/lib/decision/observation";
import { compactStream, pinIndexes } from "@genesiscz/utils/ai/compact";
import { authenticationBarrier, sameOrigin } from "./browser/auth";
import type { BrowserDriver } from "./browser/types";
import { bool, choice, fakeEvaluator, score } from "./fake-evaluate";
import { listenDaemonPlan } from "./listen-daemon";
import { runListenPipeline } from "./listen-pipeline";
import { runGoalLoop } from "./loop";
import { observeFanout } from "./observe-fanout";
import { parseObservePack } from "./observe-packs";
import { runReel } from "./reel";
import { applyBindings, bindFlagValue } from "./route-flags";
import { routePlan, splitPlanUtterance, zshRouteWidget } from "./route-plan";
import { VERIFY_TEMPLATES, verifyClaims } from "./verify-claims";
import { customTemplateSchema, listFiles, mergeTemplates, toSarif } from "./verify-sarif";

const observation: Observation = {
    ok: true,
    app: "Fixture",
    pid: 42,
    snapshot: "snap",
    window: { id: 1, title: "Fixture" },
    scope: "window",
    elements: [{ index: 0, depth: 0, role: "AXButton", AXTitle: "Save", actions: ["AXPress"], visible: true }],
};

function driver(): BrowserDriver {
    return {
        async observe() {
            return {
                url: "http://127.0.0.1/login",
                title: "Login",
                headings: [],
                candidates: [
                    { uid: "e1", role: "textbox", name: "Username", fillable: true, clickable: false },
                    { uid: "e2", role: "button", name: "Sign in", fillable: false, clickable: true },
                ],
            };
        },
        async dispatch() {
            return { ok: true, overlay: false };
        },
    };
}

describe("listen v2", () => {
    test("stop phrase disarms without a decision", async () => {
        const events = (async function* () {
            yield { type: "final" as const, text: "hey genesis open atlas", tMs: 1, provider: "mock" as const };
            yield { type: "final" as const, text: "stop", tMs: 2, provider: "mock" as const };
        })();
        const seen: string[] = [];
        for await (const event of runListenPipeline({
            events,
            driver: driver(),
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
        expect(seen).toContain("wake");
        expect(seen).toContain("idle");
    });

    test("partial go ba prefetches back without dispatching", async () => {
        const events = (async function* () {
            yield { type: "partial" as const, text: "go ba", tMs: 1, provider: "mock" as const };
        })();
        const seen = [];
        for await (const event of runListenPipeline({
            events,
            driver: driver(),
            wakeMode: "off",
            evaluate: fakeEvaluator({}),
        })) {
            seen.push(event);
        }
        expect(seen.some((event) => event.prefetch === "back")).toBe(true);
        expect(seen.some((event) => event.type === "decision")).toBe(false);
    });

    test("jev wake below complete threshold stays idle", async () => {
        const events = (async function* () {
            yield { type: "final" as const, text: "genesis maybe open", tMs: 1, provider: "mock" as const };
        })();
        const seen: string[] = [];
        for await (const event of runListenPipeline({
            events,
            driver: driver(),
            wakeMode: "jev",
            evaluate: fakeEvaluator({
                woke: bool(0.9),
                remainder: choice("after-wake", { "after-wake": 0.8, whole: 0.1, none: 0.1 }),
                destructive: bool(0.1),
                complete: bool(0.4),
            }),
        })) {
            seen.push(event.type);
        }
        expect(seen).toContain("idle");
        expect(seen).not.toContain("decision");
    });

    test("daemon install is dry-run off Darwin", () => {
        const plan = listenDaemonPlan({ stt: "grok-live", account: "work", wake: "hey genesis", wakeMode: "jev" });
        expect(plan.name).toBe("jev-listen");
        expect(plan.command).toContain("listen");
        expect(plan.dryRun).toBe(process.platform !== "darwin");
    });
});

describe("route v2", () => {
    test("omits flag values that are not spans of the utterance", () => {
        expect(
            bindFlagValue({ utterance: "open the report", flags: "--file <path>", proposed: "/tmp/x" }).omitted
        ).toBe("not-in-utterance");
        expect(
            bindFlagValue({ utterance: "format xml please", flags: "--format <fmt>", proposed: "xml", enums: ["json"] })
                .omitted
        ).toBe("enum-mismatch");
        const applied = applyBindings(
            ["tools", "github"],
            [
                { flag: "--pr", value: "409" },
                { flag: "--format", omitted: "enum-mismatch" },
            ]
        );
        expect(applied.argv).toEqual(["tools", "github", "--pr", "409"]);
        expect(applied.warnings).toHaveLength(1);
    });

    test("plans split on then and stop on destructive without allow", async () => {
        expect(splitPlanUtterance("login then open atlas then click save")).toHaveLength(3);
        const result = await routePlan({
            utterance: "inspect then click the button",
            srcDir: "/tmp",
            run: true,
            tools: [
                { name: "github", description: "prs", hasReadme: true, path: "g" },
                { name: "apoptosis", description: "kill", hasReadme: true, path: "a" },
            ],
            evaluate: fakeEvaluator({
                tool: choice("apoptosis", { github: 0.1, apoptosis: 0.85, none: 0.05 }),
                destructive: bool(0.2),
                needs_args: bool(0.1),
            }),
        });
        expect(result.blocked).toBe("destructive_blocked");
        expect(zshRouteWidget()).toContain("jev-route");
    });
});

describe("compact v2", () => {
    test("streaming two batches keeps the #pin and last user", async () => {
        const result = await compactStream({
            minReduction: 0.01,
            evaluate: fakeEvaluator({
                keep_call_old: bool(0.1),
                keep_result_old: bool(0.1),
            }),
            batches: [
                [
                    { role: "user", content: "keep #pin this" },
                    {
                        role: "assistant",
                        content: "x",
                        toolCalls: [
                            { id: "old", name: "read", result: "z".repeat(500) },
                            { id: "a", name: "read", result: "1" },
                            { id: "b", name: "read", result: "2" },
                            { id: "c", name: "read", result: "3" },
                            { id: "d", name: "read", result: "4" },
                        ],
                    },
                ],
                [{ role: "user", content: "second" }],
            ],
        });
        const pins = pinIndexes(result.messages);
        expect([...pins].length).toBeGreaterThan(0);
        expect(result.messages.some((message) => message.content.includes("#pin"))).toBe(true);
    });
});

describe("observe / verify / loop v2", () => {
    test("unknown pack lists the catalogue", () => {
        expect(() => parseObservePack("mail")).toThrow("browser-chrome");
    });

    test("form pack asks extra questions", async () => {
        const result = await observeFanout({
            observation,
            goal: "fill the form",
            pack: "form",
            evaluate: fakeEvaluator({
                target: choice("c0", { c0: 0.9, none: 0.1 }),
                verb: choice("press", { press: 0.9, set: 0.02, scroll: 0.02, wait: 0.02, stop: 0.04 }),
                done: bool(0.1),
                blocked: bool(0.05),
                wait: bool(0.05),
                risk: score(0, { "0": 0.8, "1": 0.15, "2": 0.05 }),
                missing_required: bool(0.7),
                submit_safe: bool(0.2),
            }),
        });
        expect(result.pack).toBe("form");
        expect(result.packAnswers.missing_required).toBe(0.7);
    });

    test("custom template collision and SARIF", async () => {
        expect(() => mergeTemplates(VERIFY_TEMPLATES, [{ id: "secrets", type: "boolean", instructions: "x" }])).toThrow(
            "collides"
        );
        customTemplateSchema.parse({ id: "tone", type: "boolean", instructions: "Is it rude?", gate: 0.8 });
        const listed = listFiles(["a", "b", "c"], 2);
        expect(listed.remainder).toBe(1);
        const sarif = toSarif({
            document: { secrets: 0.9 },
            gate: { block: true, reasons: ["secrets"] },
            uri: "doc.txt",
        });
        expect(sarif.runs[0].results[0].ruleId).toBe("secrets");
        const verified = await verifyClaims({
            against: "hello",
            claims: [{ id: "c1", text: "hello" }],
            purposes: ["accuracy"],
            custom: [{ id: "tone", type: "boolean", instructions: "rude?", gate: 0.5 }],
            evaluate: fakeEvaluator({ accuracy_c1: bool(0.9), tone: bool(0.8) }),
        });
        expect(verified.gate.reasons).toContain("tone");
    });

    test("auth wall and origin pin", () => {
        expect(
            authenticationBarrier(
                {
                    url: "https://x/login",
                    title: "Login",
                    headings: [],
                    candidates: [{ uid: "p", role: "textbox", name: "Password", fillable: true, clickable: false }],
                },
                { Username: "qa-user" }
            )
        ).toBe(true);
        expect(sameOrigin("https://a.example/x", "https://b.example/y")).toBe(false);
        expect(sameOrigin("https://a.example/x", "https://a.example/y")).toBe(true);
    });

    test("hybrid without both drivers fails; auto still errors", async () => {
        await expect(runGoalLoop({ goal: "x", surface: "hybrid", evaluate: fakeEvaluator({}) })).rejects.toThrow(
            "hybrid"
        );
        await expect(runGoalLoop({ goal: "x", surface: "auto", evaluate: fakeEvaluator({}) })).rejects.toThrow(
            "auto surface"
        );
    });
});

describe("demo reel", () => {
    test("dry-run writes every chapter", async () => {
        const dir = await mkdtemp(join(tmpdir(), "jev-reel-"));
        const result = await runReel({ dir, dryRun: true });
        expect(result.failed).toBe(0);
        expect(result.chapters.map((chapter) => chapter.name)).toEqual([
            "listen",
            "route",
            "compact",
            "verify",
            "observe",
            "loop",
        ]);
        await writeFile(join(dir, "ok"), "1");
    });
});
