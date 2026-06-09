import { describe, expect, it } from "bun:test";
import { stripAnsi } from "@app/utils/string";
import {
    formatAlertFire,
    formatAlertRow,
    formatIndicatorHeader,
    formatQuoteLine,
    formatSignalLine,
    formatStudyRow,
} from "./format";
import type { Alert, AlertFire, QuoteSnapshot } from "./types";

describe("format", () => {
    it("renders a quote line with symbol, price, and signed change", () => {
        const snap: QuoteSnapshot = {
            symbol: "NASDAQ:AAPL",
            value: { lp: 290.55, ch: -10.99, chp: -3.64, short_name: "AAPL" },
            updatedAt: 0,
        };
        const line = stripAnsi(formatQuoteLine(snap));
        expect(line).toContain("AAPL");
        expect(line).toContain("290.55");
        expect(line).toContain("-10.99");
        expect(line).toContain("-3.64%");
    });

    it("renders a quote line without crashing on missing fields", () => {
        const snap: QuoteSnapshot = { symbol: "X:Y", value: {}, updatedAt: 0 };
        expect(() => formatQuoteLine(snap)).not.toThrow();
    });

    it("renders an alert row with id, symbol, condition and active state", () => {
        const alert = {
            alert_id: 123,
            symbol: '={"symbol":"OANDA:SPX500USD"}',
            resolution: "1",
            condition: {
                type: "cross",
                frequency: "on_first_fire",
                series: [{ type: "barset" }, { type: "value", value: 7385.6 }],
                resolution: "1",
            },
            message: "SPX Crossing 7385.6",
            name: null,
            active: true,
        } as Alert;
        const row = stripAnsi(formatAlertRow(alert));
        expect(row).toContain("123");
        expect(row).toContain("OANDA:SPX500USD");
        expect(row).toContain("7385.6");
    });

    it("renders a fired alert banner with symbol and message", () => {
        const fire: AlertFire = {
            fire_id: 9,
            alert_id: 1,
            symbol: "OANDA:SPX500USD",
            message: "SPX Crossing 7385.6",
            fire_time: "2026-06-09T20:15:45Z",
            bar_time: "2026-06-09T20:15:00Z",
            resolution: "1",
            name: null,
            kinds: ["regular"],
        };
        const banner = stripAnsi(formatAlertFire(fire));
        expect(banner).toContain("OANDA:SPX500USD");
        expect(banner).toContain("SPX Crossing 7385.6");
    });
});

describe("indicator formatting", () => {
    const plots = [
        { id: "plot_0", type: "line", title: "RSI" },
        { id: "plot_1", type: "shapes", title: "Buy" },
    ];

    it("study row renders time + numeric cells, em-dash for null", () => {
        const row = stripAnsi(formatStudyRow({ barIndex: 1, time: 1781037360, values: [31.42, null] }, plots));
        expect(row).toContain("31.42");
        expect(row).toContain("—");
    });

    it("signal line includes title and symbol", () => {
        const line = stripAnsi(
            formatSignalLine(
                { time: 1781037360, barIndex: 1, plotId: "plot_1", plotTitle: "Buy", value: 1, kind: "live" },
                "BYBIT:BTCUSDT.P"
            )
        );
        expect(line).toContain("Buy");
        expect(line).toContain("BYBIT:BTCUSDT.P");
    });

    it("header lists plot columns", () => {
        expect(stripAnsi(formatIndicatorHeader(plots))).toContain("RSI");
    });
});
