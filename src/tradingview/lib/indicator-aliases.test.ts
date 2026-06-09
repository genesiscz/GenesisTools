import { describe, expect, test } from "bun:test";
import { resolveAlias } from "./indicator-aliases";

const LIST = [
    { scriptIdPart: "STD;RSI", scriptName: "Relative Strength Index", version: "last" },
    { scriptIdPart: "STD;MACD", scriptName: "MACD", version: "last" },
    { scriptIdPart: "STD;Bollinger_Bands", scriptName: "Bollinger Bands", version: "last" },
    { scriptIdPart: "STD;VWAP", scriptName: "VWAP", version: "last" },
];

describe("resolveAlias", () => {
    test("alias table hit", () => {
        expect(resolveAlias("rsi", LIST)?.scriptIdPart).toBe("STD;RSI");
        expect(resolveAlias("bb", LIST)?.scriptIdPart).toBe("STD;Bollinger_Bands");
    });

    test("case-insensitive full-name match", () => {
        expect(resolveAlias("relative strength index", LIST)?.scriptIdPart).toBe("STD;RSI");
    });

    test("unknown name returns null", () => {
        expect(resolveAlias("frobnicator", LIST)).toBeNull();
    });
});
