import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import type { EvaluationResponse, Evaluator } from "@genesiscz/utils/ai/evaluation/service";
import { admittedChoice, judgeOutcome, resolveIntent } from "../lib/decision/decisions";
import { candidatesFor, type Observation } from "../lib/decision/observation";

const entry = join(import.meta.dir, "..", "index.ts");

test("snapshot inspection exposes its window selection without touching a live app", () => {
    const result = spawnSync("bun", [entry, "see", "--help"], {
        env: process.env,
        encoding: "utf8",
        timeout: 30_000,
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("--window-index");
    expect(result.stdout).toContain("--path");
});

test("action help exposes native drag selection and paste options", () => {
    const result = spawnSync("bun", [entry, "act", "--help"], {
        env: process.env,
        encoding: "utf8",
        timeout: 30_000,
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("--to");
    expect(result.stdout).toContain("--range");
    expect(result.stdout).toContain("--format");
    expect(result.stdout).toContain("256 UTF-16 units");
    expect(result.stdout).toContain("--button [name]");
});

test("an invalid drag button is rejected before native resolution", () => {
    const result = spawnSync(
        "bun",
        [
            entry,
            "act",
            "--app",
            "nonexistent-control-fixture",
            "--snapshot",
            "invalid",
            "--element",
            "0",
            "--action",
            "drag",
            "--button",
            "middleish",
        ],
        {
            env: process.env,
            encoding: "utf8",
            timeout: 30_000,
        }
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("--button");
    expect(result.stderr).not.toContain("app not found");
});

test("an unknown action is rejected before app resolution", () => {
    const result = spawnSync(
        "bun",
        [
            entry,
            "act",
            "--app",
            "nonexistent-control-fixture",
            "--snapshot",
            "invalid",
            "--element",
            "0",
            "--action",
            "launch-missiles",
        ],
        {
            env: process.env,
            encoding: "utf8",
            timeout: 30_000,
        }
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("--action");
    expect(result.stderr).not.toContain("app not found");
});

test("type rejects text over 256 UTF-16 units before native resolution", () => {
    const result = spawnSync(
        "bun",
        [
            entry,
            "act",
            "--app",
            "nonexistent-control-fixture",
            "--snapshot",
            "invalid",
            "--element",
            "0",
            "--action",
            "type",
            "--text",
            "x".repeat(257),
        ],
        {
            env: process.env,
            encoding: "utf8",
            timeout: 30_000,
        }
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("256 UTF-16 units");
    expect(result.stderr).toContain("paste");
    expect(result.stderr).not.toContain("app not found");
});
test("see and act help name the diff and refresh options", () => {
    const see = spawnSync("bun", [entry, "see", "--help"], { env: process.env, encoding: "utf8", timeout: 30_000 });
    expect(see.status).toBe(0);
    expect(see.stdout).toContain("--since <json>");

    const act = spawnSync("bun", [entry, "act", "--help"], { env: process.env, encoding: "utf8", timeout: 30_000 });
    expect(act.status).toBe(0);
    expect(act.stdout).toContain("--refresh");
    expect(act.stdout).toContain("--path <png>");
});

const semanticFixture: Observation = {
    ok: true,
    app: "Fixture",
    pid: 1,
    window: { id: 1, title: "Fixture" },
    snapshot: "fixture-token",
    scope: "window",
    elements: [
        { index: 0, depth: 0, role: "AXGroup", AXTitle: "Account" },
        {
            index: 1,
            depth: 1,
            role: "AXButton",
            AXTitle: "Settings",
            AXIdentifier: "account-settings",
            actions: ["AXPress"],
            AXEnabled: "1",
        },
        { index: 2, depth: 0, role: "AXGroup", AXTitle: "Project" },
        {
            index: 3,
            depth: 1,
            role: "AXButton",
            AXTitle: "Settings",
            AXIdentifier: "project-settings",
            actions: ["AXPress"],
            AXEnabled: "1",
        },
        { index: 4, depth: 1, role: "AXButton", AXTitle: "Export", actions: ["AXPress"], AXEnabled: "0" },
        { index: 5, depth: 0, role: "AXStaticText", AXIdentifier: "result", AXValue: "Export failed" },
    ],
};
function evaluation(answers: EvaluationResponse["answers"]): EvaluationResponse {
    return {
        model: "fixture",
        answers,
        usage: { inputTokens: 1, outputTokens: 0, totalTokens: 1 },
        warnings: [],
        rounding: undefined,
        providerMetadata: undefined,
    };
}
const chooseFirst: Evaluator = async () =>
    evaluation({
        target: { type: "choice", choice: "c0", probabilities: { c0: 0.96, c1: 0.02, abstain: 0.02 } },
    });
test("semantic resolve retains ancestors, excludes disabled targets and never dispatches", async () => {
    const result = await resolveIntent({
        observation: semanticFixture,
        intent: "Account settings",
        evaluate: chooseFirst,
    });
    expect(result.status).toBe("resolved");
    expect(result.selected?.identifier).toBe("account-settings");
    expect(result.selected?.ancestors).toEqual(["Account"]);
    expect(result.candidates).toHaveLength(2);
    const blocked = structuredClone(semanticFixture);
    blocked.elements[0].AXEnabled = false;
    expect(candidatesFor({ observation: blocked })).toHaveLength(1);
});
test("semantic selection abstains on invented IDs, ambiguous probabilities and bad distributions", () => {
    for (const answer of [
        { type: "choice" as const, choice: "invented", probabilities: { c0: 1, abstain: 0 } },
        { type: "choice" as const, choice: "c0", probabilities: { c0: 0.51, abstain: 0.49 } },
        { type: "choice" as const, choice: "c0", probabilities: { c0: 1.5, abstain: -0.5 } },
    ]) {
        expect(
            admittedChoice({ result: evaluation({ target: answer }), id: "target", allowed: ["c0", "abstain"] })
                .admitted
        ).toBe(false);
    }
});
test("exact verification overrides semantic optimism and does not call the model", async () => {
    const result = await judgeOutcome({
        observation: semanticFixture,
        expect: "Export complete",
        exact: { identifier: "result", value: "Export complete" },
        evaluate: async () => {
            throw new Error("must not call model");
        },
    });
    expect(result.status).toBe("refuted");
    expect(result.basis).toBe("exact");
    expect(result.evidence).toEqual(["e5"]);
});
test("semantic completion requires sufficient evidence and conflicting failure wins", async () => {
    const probabilities = Object.fromEntries([
        ...semanticFixture.elements.map((row) => [`e${row.index}`, row.index === 5 ? 1 : 0]),
        ["none", 0],
    ]);
    const answers = {
        complete: { type: "boolean" as const, probability: 0.99 },
        sufficient: { type: "boolean" as const, probability: 0.99 },
        contradicted: { type: "boolean" as const, probability: 0.99 },
        witness: { type: "choice" as const, choice: "e5", probabilities },
        counterexample: { type: "choice" as const, choice: "e5", probabilities },
    };
    expect(
        (
            await judgeOutcome({
                observation: semanticFixture,
                expect: "Export complete",
                evaluate: async () => evaluation(answers),
            })
        ).status
    ).toBe("refuted");
    expect(
        (
            await judgeOutcome({
                observation: semanticFixture,
                expect: "Export complete",
                evaluate: async () =>
                    evaluation({
                        ...answers,
                        contradicted: { type: "boolean", probability: 0 },
                        sufficient: { type: "boolean", probability: 0.4 },
                    }),
            })
        ).status
    ).toBe("unknown");
});
