import { expect, test } from "bun:test";
import { DEFAULT_PRICING } from "../pricing";
import { buildCodexAnalysis } from "./reviews";
import type { SpendEvent } from "./types";

function event(id: string, kind: "code-review" | "permission-review" | "other", model = "gpt-6-astra"): SpendEvent {
    return {
        id,
        source: "codex",
        sessionId: "synthetic-session",
        project: "",
        timestamp: "2026-09-07T10:00:00Z",
        model,
        inputTokens: 2_001,
        cacheReadTokens: 270_000,
        cacheCreationTokens: 0,
        outputTokens: 1_000,
        codex: {
            threadId: "thread",
            agentPath: "/root/review",
            task: { id, kind, startedAt: "2026-09-07T10:00:00Z", completed: true, evidence: "completion-text" },
        },
    };
}

test("separates code reviews, permission reviews and diagnostics without invented reviewer pricing", () => {
    const report = buildCodexAnalysis(
        [
            event("review", "code-review"),
            event("ci", "other"),
            event("approval", "permission-review", "codex-auto-review"),
        ],
        DEFAULT_PRICING,
        "auto"
    );
    expect(report.activities.find((row) => row.activity === "code-review")?.costUSD).toBeCloseTo(0.65502, 10);
    expect(report.activities.find((row) => row.activity === "other")?.costUSD).toBeCloseTo(0.65502, 10);
    expect(report.models.find((row) => row.model === "codex-auto-review")).toMatchObject({
        costUSD: null,
        unpricedEvents: 1,
    });
    expect(report.totals).toMatchObject({ costUSD: null, unpricedEvents: 1 });
    expect(report.totals.knownCostUSD).toBeCloseTo(1.31004, 10);
    expect(report.passes).toHaveLength(3);
});

test("prices requests separately before grouping into a review pass", () => {
    const first = event("pass", "code-review");
    const second = { ...first, id: "second", inputTokens: 10_000, cacheReadTokens: 0, outputTokens: 1_000 };
    const report = buildCodexAnalysis([first, second], DEFAULT_PRICING, "auto");
    expect(report.passes).toHaveLength(1);
    expect(report.passes[0].costUSD).toBeCloseTo(0.80502, 10);
    expect(report.passes[0].longContextRequests).toBe(1);
});

test("recorded cost wins in auto mode even when model pricing is unknown", () => {
    const report = buildCodexAnalysis(
        [{ ...event("approval", "permission-review", "codex-auto-review"), recordedCostUsd: 0.12 }],
        DEFAULT_PRICING,
        "auto"
    );
    expect(report.totals).toMatchObject({ costUSD: 0.12, unpricedEvents: 0 });
});
