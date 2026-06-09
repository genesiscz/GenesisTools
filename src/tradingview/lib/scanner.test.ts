import { describe, expect, test } from "bun:test";
import { buildScanRequest, mapScanResponse } from "./scanner";

describe("buildScanRequest", () => {
    test("expands aliases, dedupes columns, and always includes close first", () => {
        const req = buildScanRequest(["rsi", "macd", "rsi"], ["NASDAQ:AAPL", "BYBIT:BTCUSDT.P"]);
        expect(req.columns[0]).toBe("close");
        expect(req.columns).toEqual(["close", "RSI", "RSI[1]", "MACD.macd", "MACD.signal"]);
        expect(req.symbols.tickers).toEqual(["NASDAQ:AAPL", "BYBIT:BTCUSDT.P"]);
    });

    test("passes through raw scanner column tokens", () => {
        const req = buildScanRequest(["Recommend.All"], ["NASDAQ:MSFT"]);
        expect(req.columns).toEqual(["close", "Recommend.All"]);
    });
});

describe("mapScanResponse", () => {
    test("zips columns onto symbols and maps missing values to null", () => {
        const rows = mapScanResponse(
            {
                data: [
                    { s: "NASDAQ:AAPL", d: [290.55, 42.64, null] },
                    { s: "NASDAQ:MSFT", d: [420.1] },
                ],
            },
            ["close", "RSI", "RSI[1]"]
        );
        expect(rows).toEqual([
            { symbol: "NASDAQ:AAPL", values: { close: 290.55, RSI: 42.64, "RSI[1]": null } },
            { symbol: "NASDAQ:MSFT", values: { close: 420.1, RSI: null, "RSI[1]": null } },
        ]);
    });
});
