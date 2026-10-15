import { describe, expect, test } from "bun:test";
import type { PerfSnapshot } from "@genesiscz/utils/chrome-devtools/perf";
import { summarizePerf } from "@genesiscz/utils/chrome-devtools/summaries";
import { summaryLines } from "../commands/perf.ts";
import {
    applyReplacements,
    applyVariantRewrites,
    carriedMapFor,
    collect,
    compileVariantRewrites,
    customNetwork,
    defaultStage,
    describeNetwork,
    holdSession,
    interceptMode,
    orderMetricKeys,
    parseAbSpec,
    parseMarkSpec,
    parseReplaceSpec,
    perfMetrics,
    rewriteGlobs,
    stageProblem,
} from "./perf-cli.ts";

describe("parseMarkSpec", () => {
    test("keeps the selector's own '=' and splits the text at the first '@'", () => {
        expect(parseMarkSpec("cases=[data-testid=cases]")).toEqual({ name: "cases", selector: "[data-testid=cases]" });
        expect(parseMarkSpec("me=.user@alice@example.com")).toEqual({
            name: "me",
            selector: ".user",
            text: "alice@example.com",
        });
        expect(parseMarkSpec("ready=@Requests ready")).toEqual({ name: "ready", text: "Requests ready" });
    });

    test("rejects a missing name, a bad name and an empty condition", () => {
        expect(() => parseMarkSpec("[data-testid=x]")).toThrow("the form is name=selector[@text]");
        expect(() => parseMarkSpec("=.x")).toThrow("name=selector[@text]");
        expect(() => parseMarkSpec("two words=.x")).toThrow("may only hold");
        expect(() => parseMarkSpec("x=")).toThrow("no selector and no text");
    });

    test("collect accumulates repeated values and keeps commas inside one", () => {
        expect(collect("b,c", collect("a"))).toEqual(["a", "b,c"]);
    });
});

describe("replace rules", () => {
    test("splits at the first '=>', compiles a global regex, supports $1 and counts matches", () => {
        const rule = parseReplaceSpec("(\\w+)=>x=>$1!");
        expect(rule.from).toBe("(\\w+)");
        expect(rule.to).toBe("x=>$1!");
        expect(applyReplacements("ab cd", [rule])).toEqual({ body: "x=>ab! x=>cd!", replaced: 2 });
        expect(applyReplacements("ab cd", [rule])).toEqual({ body: "x=>ab! x=>cd!", replaced: 2 });
    });

    test("an empty 'to' deletes, and a rule that never matches counts zero", () => {
        expect(applyReplacements("rows rows", [parseReplaceSpec("rows=>")])).toEqual({ body: " ", replaced: 2 });
        expect(applyReplacements("abc", [parseReplaceSpec("zzz=>y")])).toEqual({ body: "abc", replaced: 0 });
    });

    test("rejects a missing arrow and an invalid regex", () => {
        expect(() => parseReplaceSpec("rows")).toThrow("from=>to");
        expect(() => parseReplaceSpec("=>x")).toThrow("from=>to");
        expect(() => parseReplaceSpec("(=>x")).toThrow("not a valid regular expression");
    });
});

const validSpec = {
    url: "http://127.0.0.1:3000/",
    marks: [{ name: "cases", selector: "[data-testid=cases]" }],
    variants: [
        { name: "a" },
        {
            name: "b",
            cpu: 4,
            network: "slow-4g",
            rewrite: [{ url: "*/data.json*", replace: [{ from: "rows", to: "ROWS" }] }],
        },
    ],
};

describe("parseAbSpec", () => {
    test("fills the defaults of a valid spec", () => {
        const parsed = parseAbSpec(validSpec);
        expect(parsed.ok).toBe(true);
        if (parsed.ok) {
            expect(parsed.spec.rounds).toBe(3);
            expect(parsed.spec.order).toBe("abba");
            expect(parsed.spec.waitMs).toBe(10_000);
            expect(rewriteGlobs(parsed.spec)).toEqual(["*/data.json*"]);
        }
    });

    test("names the bad field: bad regex, unknown preset, typo key, missing url", () => {
        const parsed = parseAbSpec({
            rouns: 2,
            variants: [
                { name: "a", network: "5g" },
                { name: "b", rewrite: [{ url: "*", replace: [{ from: "(", to: "" }] }] },
            ],
        });
        expect(parsed.ok).toBe(false);
        if (!parsed.ok) {
            const text = parsed.errors.join("\n");
            expect(text).toContain("url:");
            expect(text).toContain('spec: Unrecognized key: "rouns"');
            expect(text).toContain("variants[0].network:");
            expect(text).toContain("variants[1].rewrite[0].replace[0].from: not a valid regular expression");
        }
    });

    test("refuses two variants with one name", () => {
        const parsed = parseAbSpec({ ...validSpec, variants: [{ name: "a" }, { name: "a" }] });
        expect(parsed).toEqual({ ok: false, errors: ["variants[1].name: duplicate variant name 'a'"] });
    });

    test("needs at least one variant and a whole positive rounds count", () => {
        const parsed = parseAbSpec({ url: "http://x.test/", rounds: 1.5, variants: [] });
        expect(parsed.ok).toBe(false);
        if (!parsed.ok) {
            expect(parsed.errors.some((line) => line.startsWith("rounds:"))).toBe(true);
            expect(parsed.errors.some((line) => line.startsWith("variants:"))).toBe(true);
        }
    });
});

describe("variant rewrites", () => {
    test("apply every rule whose glob matches the url, and nothing elsewhere", () => {
        const parsed = parseAbSpec({
            ...validSpec,
            variants: [
                {
                    name: "b",
                    rewrite: [
                        { url: "*/data.json*", replace: [{ from: "rows", to: "R" }] },
                        { url: "*.json", replace: [{ from: "R", to: "Q" }] },
                    ],
                },
            ],
        });
        if (!parsed.ok) {
            throw new Error(parsed.errors.join("; "));
        }

        const compiled = compileVariantRewrites(parsed.spec.variants[0]);
        expect(applyVariantRewrites(compiled, "http://h/data.json", "rows")).toEqual({ body: "Q", replaced: 2 });
        expect(applyVariantRewrites(compiled, "http://h/app.js", "rows")).toEqual({ body: "rows", replaced: 0 });
        expect(applyVariantRewrites([], "http://h/data.json", "rows")).toEqual({ body: "rows", replaced: 0 });
    });
});

function snapshot(partial: Partial<PerfSnapshot>): PerfSnapshot {
    return {
        url: "http://h/",
        now: 0,
        installedAt: 0,
        markBase: 0,
        visibleThroughout: true,
        frames: [],
        longtasks: [],
        shifts: [],
        events: [],
        lags: [],
        marks: {},
        unsupported: [],
        navigation: null,
        resources: [],
        ...partial,
    };
}

describe("perfMetrics", () => {
    test("frame totals, lag, CLS and one mark:<name> per reached mark", () => {
        const frame = (duration: number, blockingDuration: number) => ({
            start: 0,
            duration,
            blockingDuration,
            renderStart: 0,
            styleAndLayoutStart: 0,
            scripts: [],
        });
        const metrics = perfMetrics(
            snapshot({
                frames: [frame(250, 200), frame(80, 30)],
                lags: [
                    [0, 60],
                    [100, 240],
                ],
                shifts: [{ start: 10, value: 0.1, hadRecentInput: false, sources: [] }],
                marks: { cases: 612.4 },
            })
        );
        expect(metrics).toEqual({
            blockingMs: 230,
            totalFrameMs: 330,
            worstFrameMs: 250,
            framesOver200: 1,
            maxLagMs: 240,
            cls: 0.1,
            "mark:cases": 612,
        });
        expect(orderMetricKeys(["mark:z", "cls", "loadEventMs", "mark:a", "blockingMs"])).toEqual([
            "loadEventMs",
            "blockingMs",
            "cls",
            "mark:a",
            "mark:z",
        ]);
    });

    test("lag while the page was hidden is background throttling: max lag leaves it out and says so", () => {
        // Recorded: the tab went hidden at 116000 and its timers then ran once a second.
        const hidden = snapshot({
            visibleThroughout: false,
            hiddenSpans: [[116_000, 120_000]],
            lags: [
                [40_000, 120],
                [116_026.3, 949.6],
                [117_025.9, 949.7],
            ],
        });
        expect(perfMetrics(hidden).maxLagMs).toBe(120);
        const summary = summarizePerf(hidden);
        expect(summary.maxLagMs).toBe(120);
        expect(summary.hiddenMs).toBe(4000);
        const text = summaryLines(summary, []).join("\n");
        expect(text).toContain("max lag 120 ms while visible");
        expect(text).toContain("hidden (a background tab) for 4000 ms from page time 116000 ms");

        // A snapshot saved before hiddenSpans existed keeps every lag, and still prints why the numbers are suspect.
        const older = snapshot({ visibleThroughout: false, lags: hidden.lags });
        expect(summarizePerf(older).maxLagMs).toBe(950);
        expect(summaryLines(summarizePerf(older), []).join("\n")).toContain("does not say when");
        expect(summaryLines(summarizePerf(snapshot({ unsupported: ["event"] })), []).join("\n")).toContain(
            "this browser does not report: event"
        );
    });
});

describe("network and intercept flags", () => {
    test("custom network: null without flags, defaults for missing parts, rejects negatives", () => {
        expect(customNetwork({})).toEqual({ conditions: null });
        expect(customNetwork({ latency: "300" })).toEqual({
            conditions: { offline: false, latencyMs: 300, downloadKbps: -1, uploadKbps: -1 },
        });
        expect(customNetwork({ offline: true })).toEqual({
            conditions: { offline: true, latencyMs: 0, downloadKbps: -1, uploadKbps: -1 },
        });
        expect(customNetwork({ down: "-5" })).toEqual({ error: "--down must be a number of 0 or more, got '-5'" });
        expect(describeNetwork({ offline: false, latencyMs: 300, downloadKbps: 1600, uploadKbps: -1 })).toBe(
            "300 ms latency, down 1600 kbps, up unlimited"
        );
    });

    test("intercept needs exactly one action; replace defaults to the response stage and refuses request", () => {
        expect(interceptMode({ replace: [] })).toEqual({
            error: "pick exactly one action: --replace <from=>to>, --body-file <file>, --block, or --map-dir <dir>",
        });
        expect("error" in interceptMode({ replace: ["a=>b"], block: true })).toBe(true);
        const replace = interceptMode({ replace: ["a=>b"] });
        const block = interceptMode({ replace: [], block: true });
        if ("error" in replace || "error" in block) {
            throw new Error("expected modes");
        }

        expect(defaultStage(replace.mode)).toBe("response");
        expect(defaultStage(block.mode)).toBe("request");
        expect(stageProblem(replace.mode, "request")).toContain("--stage response");
        expect(stageProblem(block.mode, "response")).toBeNull();
        const invalid = interceptMode({ replace: ["(=>b"] });
        expect("error" in invalid && invalid.error).toContain("'(' is not a valid regular expression");
    });
});

describe("holdSession", () => {
    test("an aborted signal ends the hold as interrupted, a detach as detached", async () => {
        const controller = new AbortController();
        controller.abort();
        expect(await holdSession({ signal: controller.signal })).toBe("interrupted");

        const listeners = new Map<string, (params: unknown) => void>();
        const cdp = {
            send: async () => undefined,
            on: (event: string, listener: (params: unknown) => void) => listeners.set(event, listener),
            off: (event: string) => listeners.delete(event),
        };
        const held = holdSession({ signal: new AbortController().signal, cdp });
        listeners.get("Inspector.detached")?.({});
        expect(await held).toBe("detached");
        expect(listeners.size).toBe(0);
    });
});

describe("carriedMapFor", () => {
    test("the exact URL (query kept, fragment dropped) wins; a bare path falls back only when unambiguous", () => {
        const carried = new Map([
            ["https://app.example.com/config.js?v=1", "/maps/config-v1.map"],
            ["https://app.example.com/config.js?v=2", "/maps/config-v2.map"],
            ["https://app.example.com/main.js", "/maps/main.map"],
        ]);
        expect(carriedMapFor(carried, "https://app.example.com/config.js?v=2#x")).toBe("/maps/config-v2.map");
        expect(carriedMapFor(carried, "https://app.example.com/config.js?v=3")).toBeUndefined();
        expect(carriedMapFor(carried, "https://app.example.com/main.js?cache=9")).toBe("/maps/main.map");
        expect(carriedMapFor(carried, "https://app.example.com/other.js")).toBeUndefined();
    });
});
