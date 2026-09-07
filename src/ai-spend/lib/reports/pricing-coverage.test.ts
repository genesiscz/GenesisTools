import { expect, test } from "bun:test";
import { DEFAULT_PRICING } from "../pricing";
import { buildPeriodReport } from "./period";
import { addCodexPricingCoverage } from "./pricing-coverage";
import { renderPeriodTable } from "./render";
import type { SpendEvent } from "./types";

test("an unpriced reviewer is unknown in row, model, totals and terminal output", () => {
    const events: SpendEvent[] = [
        {
            source: "codex",
            id: "guardian-call",
            model: "codex-auto-review",
            timestamp: "2026-09-07T10:00:00Z",
            sessionId: "guardian",
            project: "",
            inputTokens: 100,
            outputTokens: 5,
            cacheReadTokens: 50,
            cacheCreationTokens: 0,
        },
    ];
    const report = buildPeriodReport(events, {
        source: "codex",
        grain: "daily",
        timezone: "UTC",
        now: new Date("2026-09-07T12:00:00Z"),
        pricing: DEFAULT_PRICING,
        mode: "auto",
    });
    addCodexPricingCoverage(report, events, DEFAULT_PRICING, "auto", "daily", "UTC");
    expect(report.totals).toMatchObject({ costUSD: null, knownCostUSD: 0 });
    expect(report.daily).toMatchObject([
        { costUSD: null, models: { "codex-auto-review": { costUSD: null, priced: false } } },
    ]);
    expect(renderPeriodTable(report, "daily", true)).toContain("unknown");
});
