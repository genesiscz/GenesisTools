import { describe, expect, test } from "bun:test";
import { SignalDetector } from "./signals";
import type { PinePlot } from "./types";

const PLOTS: PinePlot[] = [
    { id: "plot_0", type: "line", title: "RSI" },
    { id: "plot_1", type: "shapes", title: "Buy" },
    { id: "plot_2", type: "shapes", title: "Sell" },
];

describe("SignalDetector", () => {
    test("history snapshot yields history signals for non-null shape cells", () => {
        const det = new SignalDetector(PLOTS);
        const events = det.ingest([{ barIndex: 10, time: 1000, values: [55.2, 1, null] }]);
        expect(events).toEqual([
            { time: 1000, barIndex: 10, plotId: "plot_1", plotTitle: "Buy", value: 1, kind: "history" },
        ]);
    });

    test("line plots never produce signals", () => {
        const det = new SignalDetector(PLOTS);
        const events = det.ingest([{ barIndex: 11, time: 1060, values: [60.1, null, null] }]);
        expect(events).toEqual([]);
    });

    test("live mark fires once, re-delivery is deduped", () => {
        const det = new SignalDetector(PLOTS);
        det.ingest([{ barIndex: 10, time: 1000, values: [55.2, null, null] }]);
        det.markLive();
        const first = det.ingest([{ barIndex: 11, time: 1060, values: [48.0, null, 1] }]);
        const second = det.ingest([{ barIndex: 11, time: 1060, values: [48.0, null, 1] }]);
        expect(first.map((e) => e.kind)).toEqual(["live"]);
        expect(first[0].plotTitle).toBe("Sell");
        expect(second).toEqual([]);
    });
});
