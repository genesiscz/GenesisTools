import { describe, expect, test } from "bun:test";
import { ChartClient, toCell } from "./chart-client";
import { isHeartbeat, parseFrames } from "./protocol";
import type { Bar, StudyPoint } from "./types";

function makeClient(): ChartClient {
    return new ChartClient({ authToken: "unauthorized_user_token" });
}

describe("toCell", () => {
    test("treats 1e+100 sentinels as empty", () => {
        expect(toCell(1e100)).toBeNull();
        expect(toCell(1e99)).toBeNull();
    });
});

describe("ChartClient frame handling", () => {
    test("series snapshot emits bars", () => {
        const client = makeClient();
        const bars: Bar[] = [];
        client.on("bars", (b) => bars.push(...b));
        client.handleFrame(
            '{"m":"timescale_update","p":["cs_t",{"sds_1":{"s":[{"i":0,"v":[1781037360,100,110,90,105,5000]}]}}]}'
        );
        expect(bars).toEqual([{ time: 1781037360, open: 100, high: 110, low: 90, close: 105, volume: 5000 }]);
    });

    test("study data emits StudyPoints aligned to plot order", () => {
        const client = makeClient();
        const points: StudyPoint[] = [];
        client.on("studyData", ({ points: p }) => points.push(...p));
        client.handleFrame('{"m":"du","p":["cs_t",{"st_1":{"st":[{"i":42,"v":[1781037360,31.4,null]}]}}]}');
        expect(points).toEqual([{ barIndex: 42, time: 1781037360, values: [31.4, null] }]);
    });

    test("study_error is surfaced", () => {
        const client = makeClient();
        let err = "";
        client.on("studyError", ({ reason }) => {
            err = reason;
        });
        client.handleFrame('{"m":"study_error","p":["cs_t","st_1","s1","line 5: unknown identifier"]}');
        expect(err).toContain("unknown identifier");
    });

    test("tolerates string-NaN study values", () => {
        const client = makeClient();
        const points: StudyPoint[] = [];
        client.on("studyData", ({ points: p }) => points.push(...p));
        client.handleFrame('{"m":"du","p":["cs_t",{"st_1":{"st":[{"i":1,"v":[1781037420,"NaN",1]}]}}]}');
        expect(points[0].values).toEqual([null, 1]);
    });

    test("symbol_error reports the requested ticker, not the symbol handle", () => {
        // live frame shape (probed 2026-06-10): p = [sessionId, symbolHandle, message]
        const client = makeClient();
        client.setSymbol({ symbol: "NASDAQ:APPL", timeframe: "1D", barCount: 300 });
        const events: Array<{ symbol: string; errmsg: string }> = [];
        client.on("symbolError", (e) => events.push(e));
        client.handleFrame(
            '{"m":"symbol_error","p":["cs_t","sds_sym_1","invalid symbol"],"t":1781043474,"t_ms":1781043474094}'
        );
        expect(events).toEqual([{ symbol: "NASDAQ:APPL", errmsg: "invalid symbol" }]);
    });
});

describe("reconnect", () => {
    test("schedules reconnects with exponential backoff and emits reconnecting", () => {
        const client = new ChartClient({ reconnect: true });
        const delays: number[] = [];
        client.on("reconnecting", ({ attempt, delayMs }) => {
            delays.push(delayMs);
            void attempt;
        });
        client.simulateCloseForTest();
        client.simulateCloseForTest();
        client.simulateCloseForTest();
        expect(delays).toEqual([1000, 2000, 4000]);
        client.dispose();
    });
});

describe("fixture replay", () => {
    test("replays the captured RSI session end-to-end when fixture exists", async () => {
        const path = new URL("./__fixtures__/chart-frames-rsi.txt", import.meta.url);
        const file = Bun.file(path);
        if (!(await file.exists()) || file.size === 0) {
            return;
        }

        const raw = await file.text();
        const client = makeClient();
        let barCount = 0;
        let studyEmits = 0;
        client.on("bars", (b) => {
            barCount += b.length;
        });
        client.on("studyData", () => {
            studyEmits += 1;
        });
        for (const line of raw.split("\n").filter(Boolean)) {
            for (const frame of parseFrames(line)) {
                if (!isHeartbeat(frame)) {
                    client.handleFrame(frame);
                }
            }
        }
        expect(barCount).toBeGreaterThan(0);
        expect(studyEmits).toBeGreaterThan(0);
    });
});
