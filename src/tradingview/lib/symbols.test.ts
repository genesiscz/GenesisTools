import { SafeJSON } from "@app/utils/json";
import { describe, expect, it } from "bun:test";
import { normalizeTicker, parseProSymbol, toProSymbol } from "./symbols";

describe("symbols", () => {
    it("wraps a bare ticker into a pro symbol spec", () => {
        expect(toProSymbol("NASDAQ:MSTR")).toBe(
            `=${SafeJSON.stringify({ symbol: "NASDAQ:MSTR", adjustment: "splits" })}`,
        );
    });

    it("includes session when provided", () => {
        expect(toProSymbol("OANDA:SPX500USD", { session: "regular" })).toBe(
            `=${SafeJSON.stringify({ symbol: "OANDA:SPX500USD", adjustment: "splits", session: "regular" })}`,
        );
    });

    it("parses a pro symbol spec back to its ticker", () => {
        const spec = '={"symbol":"NASDAQ:MSTR","adjustment":"splits"}';
        expect(parseProSymbol(spec)).toBe("NASDAQ:MSTR");
    });

    it("returns the bare ticker unchanged when not a spec", () => {
        expect(parseProSymbol("NASDAQ:MSTR")).toBe("NASDAQ:MSTR");
    });

    it("uppercases and trims a ticker", () => {
        expect(normalizeTicker("  nasdaq:aapl ")).toBe("NASDAQ:AAPL");
    });
});