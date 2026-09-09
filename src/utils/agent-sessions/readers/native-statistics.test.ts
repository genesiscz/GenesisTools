import { expect, test } from "bun:test";
import { NativeStatisticsAccumulator } from "./native-statistics";

test("an explicitly emitted zero-token usage event is reported rather than treated as missing telemetry", () => {
    const accumulator = new NativeStatisticsAccumulator({ project: "shop", isSubagent: false });
    accumulator.addRecord({
        position: 0,
        locator: "fixture:0",
        timestamp: "2026-09-01T10:00:00.000Z",
        role: "user",
        entries: [{ line: 1, role: "user", text: "hello", paths: [], commits: [] }],
        original: "fixture",
    });
    accumulator.addUsage({
        id: "explicit-zero",
        model: "fixture-model",
        timestamp: "2026-08-31T10:00:00.000Z",
        inputTokens: 0,
        outputTokens: 0,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
    });

    accumulator.addUsage({
        id: "later",
        model: "fixture-model",
        timestamp: "2026-09-02T10:00:00.000Z",
        inputTokens: 1,
        outputTokens: 2,
        cacheCreationTokens: 3,
        cacheReadTokens: 4,
    });
    const result = accumulator.result([]);

    expect(result.summary.tokenUsage).toEqual({
        inputTokens: 1,
        outputTokens: 2,
        cacheCreateTokens: 3,
        cacheReadTokens: 4,
    });
    expect(result.days[0]?.tokenUsage).toEqual({
        inputTokens: 0,
        outputTokens: 0,
        cacheCreateTokens: 0,
        cacheReadTokens: 0,
    });
    expect(result.summary.dailyActivity).toEqual({ "2026-09-01": 1 });
    expect(result.summary.firstDate).toBe("2026-08-31");
    expect(result.summary.lastDate).toBe("2026-09-02");
    expect(result.days.map((day) => day.conversations)).toEqual([1, 0, 0]);
    expect(result.summary.modelCounts).toEqual({ "fixture-model": 2 });
});
