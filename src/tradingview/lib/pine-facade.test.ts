import { describe, expect, test } from "bun:test";
import { mapIndicatorList, mapTranslateResponse, parseScriptSpec, resolvePubScriptRef } from "./pine-facade";

/** Inline shape from plan — replaced by __fixtures__/translate-std-rsi.json when available. */
const STD_RSI_FIXTURE = {
    success: true,
    result: {
        ilTemplate: "x".repeat(200),
        metaInfo: {
            scriptIdPart: "STD;RSI@tv-basicstudies",
            description: "Relative Strength Index",
            shortDescription: "RSI",
            pine: { version: "1.0" },
            inputs: [
                { id: "text", type: "text", isHidden: true, isFake: true, defval: "..." },
                { id: "pineId", type: "text", isHidden: true, isFake: true },
                { id: "pineVersion", type: "text", isHidden: true, isFake: true },
                { id: "in_0", name: "Length", type: "integer", defval: 14 },
            ],
            plots: [{ id: "plot_0", type: "line" }],
            styles: { plot_0: { title: "RSI" } },
        },
    },
};

async function loadStdRsiFixture(): Promise<typeof STD_RSI_FIXTURE> {
    const path = new URL("./__fixtures__/translate-std-rsi.json", import.meta.url);
    try {
        const file = Bun.file(path);
        if (await file.exists()) {
            return (await file.json()) as typeof STD_RSI_FIXTURE;
        }
    } catch {
        // fall through to inline shape
    }

    return STD_RSI_FIXTURE;
}

describe("parseScriptSpec", () => {
    test("passes through STD;/PUB;/USER; ids", () => {
        expect(parseScriptSpec("PUB;AGFHDbJ2")).toEqual({ pineId: "PUB;AGFHDbJ2" });
        expect(parseScriptSpec("STD;RSI")).toEqual({ pineId: "STD;RSI" });
    });

    test("extracts PUB id from a script-page URL", () => {
        const url = "https://www.tradingview.com/script/AGFHDbJ2-MDX-Free-PA-Buy-Sell-Confimation/";
        expect(parseScriptSpec(url)).toEqual({ pineId: "PUB;AGFHDbJ2" });
    });

    test("returns null for free-text (alias path handles it)", () => {
        expect(parseScriptSpec("rsi")).toBeNull();
    });
});

describe("mapIndicatorList", () => {
    test("maps pine-facade list entries to StandardScript rows", () => {
        const list = mapIndicatorList([
            { scriptIdPart: "STD;RSI", scriptName: "Relative Strength Index", version: "last" },
            { scriptIdPart: "STD;MACD", scriptTitle: "MACD", version: "38.0" },
            { scriptIdPart: "", scriptName: "skip me" },
        ]);
        expect(list).toEqual([
            { scriptIdPart: "STD;RSI", scriptName: "Relative Strength Index", version: "last" },
            { scriptIdPart: "STD;MACD", scriptName: "MACD", version: "38.0" },
        ]);
    });
});

describe("resolvePubScriptRef", () => {
    test("passes through STD and long PUB hash ids", async () => {
        const std = await resolvePubScriptRef("STD;RSI");
        expect(std).toEqual({ scriptIdPart: "STD;RSI", version: "last" });

        const hash = "PUB;0u4crLN8uj6zMzf6TJ0lhIuiKOKlHd7G";
        const pub = await resolvePubScriptRef(hash);
        expect(pub.scriptIdPart).toBe(hash);
    });

    test("resolves publication slug PUB;AGFHDbJ2 to internal script id", async () => {
        const resolved = await resolvePubScriptRef("PUB;AGFHDbJ2");
        expect(resolved.scriptIdPart).toBe("PUB;0u4crLN8uj6zMzf6TJ0lhIuiKOKlHd7G");
        expect(resolved.version.length).toBeGreaterThan(0);
    });
});

describe("mapTranslateResponse", () => {
    test("maps the captured STD;RSI translate fixture into StudyMeta", async () => {
        const stdRsi = await loadStdRsiFixture();
        const meta = mapTranslateResponse(stdRsi);
        expect(meta.pineId.startsWith("STD;")).toBe(true);
        expect(meta.ilTemplate.length).toBeGreaterThan(100);
        expect(meta.inputs.every((i) => !i.isFake)).toBe(true);
        expect(meta.plots.length).toBeGreaterThan(0);
        expect(meta.plots[0].title.length).toBeGreaterThan(0);
    });
});
