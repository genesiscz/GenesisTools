import { describe, expect, test } from "bun:test";
import { buildWorkerContract, WORKER_REPORT_KEYS } from "./contract";

const bus = { agentName: "codex_task", leadName: "lead", rendezvousSession: "s-1" };

describe("buildWorkerContract", () => {
    test("every backend gets the same checkpoint contract and report shape", () => {
        const texts = (["codex", "grok", "claude"] as const).map((backend) => buildWorkerContract({ backend }));

        for (const text of texts) {
            expect(text).toContain("Honor any `Stop and report` block in your task brief literally");
            expect(text).toContain("fails twice in a row, STOP");
            expect(text).toContain("CHARACTER FOR CHARACTER");
            for (const key of WORKER_REPORT_KEYS) {
                expect(text).toMatch(new RegExp(`^${key}: `, "m"));
            }
        }

        // The five keys appear in the declared order.
        const positions = WORKER_REPORT_KEYS.map((key) => texts[0].indexOf(`${key}: `));
        expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    });

    test("no bus: the final message is the channel", () => {
        const text = buildWorkerContract({ backend: "grok" });
        expect(text).toContain("headless Grok worker driven by an orchestrating agent");
        expect(text).toContain("your FINAL message is the report");
        expect(text).not.toContain("tools agents");
    });

    test("bus: the three tools agents commands carry the identity and the session flag", () => {
        const text = buildWorkerContract({ backend: "codex", bus, sandbox: "workspace-write" });
        expect(text).toContain("You are `codex_task`, a headless Codex worker");
        expect(text).toContain("tools agents message --from codex_task --to lead --body '<text>' --session s-1");
        expect(text).toContain("tools agents login --agent-name codex_task --once --session s-1");
        expect(text).toContain("--body 'received; starting' --session s-1");
    });

    test("bus in a read-only sandbox: narrate, never run tools agents", () => {
        const text = buildWorkerContract({ backend: "codex", bus, sandbox: "read-only" });
        expect(text).toContain("do NOT run `tools agents` commands");
        expect(text).not.toContain("tools agents message --from");
        expect(text).toContain("RESULT: ");
    });

    test("loaded surfaces get the interactive-ritual exemption; isolated workers get nothing extra", () => {
        expect(buildWorkerContract({ backend: "grok", surfaces: { skills: true, rules: true } })).toContain(
            "personal rules and skills are loaded for reference"
        );
        expect(buildWorkerContract({ backend: "grok", surfaces: { skills: true, rules: false } })).toContain(
            "personal skills are loaded"
        );
        expect(buildWorkerContract({ backend: "grok", surfaces: { skills: false, rules: false } })).not.toContain(
            "loaded for reference"
        );
    });
});
