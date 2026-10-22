import { describe, expect, test } from "bun:test";
import { buildWorkerContract, type ReviewManifest, reviewLines, WORKER_REPORT_KEYS } from "./contract";

const bus = { agentName: "codex_task", leadName: "lead", rendezvousSession: "s-1" };

describe("buildWorkerContract", () => {
    test("every backend gets the same checkpoint contract and report shape", () => {
        const texts = (["codex", "grok", "claude"] as const).map((backend) => buildWorkerContract({ backend }));

        for (const text of texts) {
            expect(text).toContain("Honor any `Stop and report` block in your task brief literally");
            expect(text).toContain("fails twice in a row, STOP");
            expect(text).toContain("CHARACTER FOR CHARACTER");
            // A brief or a steer that grants "commit once" is honoured; without one the worker still asks.
            expect(text).toContain("running any git commit/push or destructive command,");
            expect(text).toContain("explicitly authorizes that exact action");
            // A grant in the brief is not a cue to ask once first (2026-10-14: a worker with "Commit exactly ONCE"
            // in its brief still stopped for confirmation, reading "do not ask again" as "ask once").
            expect(text).toContain("given in advance: do the authorized action without stopping");
            expect(text).not.toContain("do not ask again");
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
        expect(text).toContain("--body 'received; starting' --session s-1");
    });

    test("a sandboxed codex worker is told to run Jest without watchman; other backends are not", () => {
        // The sandbox denies ~/.local/state/watchman, and Jest failed on its fchmod before any test (2026-10-13).
        expect(buildWorkerContract({ backend: "codex", sandbox: "workspace-write" })).toContain("--watchman=false");
        expect(buildWorkerContract({ backend: "codex", sandbox: "read-only" })).toContain("--watchman=false");
        expect(buildWorkerContract({ backend: "grok", sandbox: "workspace-write" })).not.toContain("watchman");
    });

    test("bus: a codex worker receives through its daemon, never with a blocking login --once", () => {
        // The daemon delivers mail as turn input; a model-side --once blocked the turn and held the slot 3+ min.
        const codex = buildWorkerContract({ backend: "codex", bus, sandbox: "workspace-write" });
        expect(codex).toContain("Mail addressed to you arrives by itself");
        expect(codex).toContain("END your turn");
        expect(codex).not.toContain("--once");

        const grok = buildWorkerContract({ backend: "grok", bus, sandbox: "workspace-write" });
        expect(grok).toContain("tools agents login --agent-name codex_task --once --session s-1");
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

    test("review: each tier stacks the rules below it, and low is triage without them", () => {
        const low = reviewLines("low").join("\n");
        const medium = reviewLines("medium").join("\n");
        const high = reviewLines("high").join("\n");
        const xhigh = reviewLines("xhigh").join("\n");
        const max = reviewLines("max").join("\n");

        expect(low).toContain("Triage only: name the three riskiest files");
        expect(low).not.toContain("Read every hunk");
        expect(medium).toContain("Read every hunk of every file in the manifest.");
        expect(medium).not.toContain("Open the callers");
        expect(high).toContain("Read every hunk");
        expect(high).toContain("Open the callers and the tests of every changed function.");
        expect(high).toContain("Label each finding observed");
        expect(high).not.toContain("per-file pass");
        expect(xhigh).toContain("Label each finding observed");
        expect(xhigh).toContain("Probe each finding (`bun -e`, a test) before you report it, or mark it inferred.");
        expect(xhigh).toContain("second pass over every file that touches secrets, processes, concurrency or I/O");
        expect(xhigh).not.toContain("adversarial pass");
        expect(max).toContain("Probe each finding");
        expect(max).toContain("Read the area rules of every touched folder.");
        expect(max).toContain("Make an adversarial pass");

        for (const text of [low, medium, high, xhigh, max]) {
            expect(text).toContain(
                "`1. [Severity] path:line - defect. Scenario: <what triggers it>. Fix: <the change>.`"
            );
            expect(text).toContain("`Files reviewed: <n> of <N>`");
            expect(text).toContain("`Not reviewed: none`");
        }
    });

    test("review: the manifest and tier ride after the report shape; without review the text is unchanged", () => {
        const manifest: ReviewManifest = {
            base: "origin/master",
            files: [
                { path: "src/a.ts", added: 40, deleted: 2 },
                { path: "assets/logo.png", added: 0, deleted: 0, binary: true },
            ],
            added: 40,
            deleted: 2,
        };

        for (const backend of ["codex", "grok", "claude"] as const) {
            const plain = buildWorkerContract({ backend, sandbox: "read-only" });
            const reviewer = buildWorkerContract({
                backend,
                sandbox: "read-only",
                review: { effort: "high", manifest },
            });

            expect(buildWorkerContract({ backend, sandbox: "read-only", review: null })).toBe(plain);
            // Without surfaces the review block is the only addition, appended after the report shape.
            expect(reviewer.startsWith(`${plain}\n`)).toBe(true);
            expect(reviewer).toContain("You are a code REVIEWER at the high tier.");
            expect(reviewer).toContain("Files to review (2, +40 -2):\n- src/a.ts +40 -2\n- assets/logo.png (binary)");
            expect(reviewer).toContain("`git diff origin/master...HEAD -- <path>`");
            expect(reviewer.indexOf("OPEN: ")).toBeLessThan(reviewer.indexOf("code REVIEWER"));
        }
    });
});
