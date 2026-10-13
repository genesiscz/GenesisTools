import { afterEach, describe, expect, it } from "bun:test";
import {
    checkLine,
    findQuote,
    type LineCheck,
    ledgerLines,
    needsFollowUp,
    pageFetcher,
    quotePairs,
} from "./check-ledger.ts";

const report = `# Report

Body text.

## Claims ledger

1. [95%] Version 2.0 shipped on 2026-01-01. (proof: [release notes](https://example.com/notes) "Version 2.0 shipped on January 1".) verify: \`curl -s https://example.com/notes\`
2. [90%] The default limit is 1000. (proof: [limits.h:12](https://github.com/acme/lib/blob/abc123/src/limits.h#L12) \`#define DEFAULT_LIMIT 1000\`; local run printed \`limit=1000\` in [run.log](/tmp/run.log).) verify: \`grep LIMIT src/limits.h\`
3. [60%] Nobody ships it yet. (proof: none) verify: \`open https://example.com\`
4. [92%] The flag removes the global. (proof: local runs printed \`object\` then \`undefined\`.) verify: \`node --no-flag -p 'typeof X'\`
`;

const pages: Record<string, string> = {
    "https://example.com/notes": `${"filler text ".repeat(10)}Version 2.0 shipped on January 1 with many fixes.`,
    "https://github.com/acme/lib/blob/abc123/src/limits.h#L12": `${"header ".repeat(10)}#define DEFAULT_LIMIT 1000`,
    "/tmp/run.log": `${"start ".repeat(10)}limit=999`,
};
const fetchPage = async (target: string) => pages[target] ?? "";

describe("ledgerLines", () => {
    it("reads confidence, claim, proof and verify from each ledger line", () => {
        const lines = ledgerLines(report);
        expect(lines.map((line) => line.confidence)).toEqual([95, 90, 60, 92]);
        expect(lines[0]?.claim).toBe("Version 2.0 shipped on 2026-01-01.");
        expect(lines[2]?.proof).toBe("none");
        expect(lines[3]?.verify).toContain("node --no-flag");
    });

    it("stops at the next heading, so a rated line in a later section is not a claim", () => {
        const withNotes = `${report}\n## Notes\n\n- [95%] an aside after the ledger (proof: none)\n`;
        expect(ledgerLines(withNotes)).toHaveLength(4);
    });

    it("returns nothing when the report has no ledger", () => {
        expect(ledgerLines("# Report\n\n[90%] a claim outside any ledger")).toEqual([]);
    });
});

describe("quotePairs", () => {
    it("pairs each quote with the link nearest to it, so a line with two sources checks both", () => {
        const line = ledgerLines(report)[1];
        expect(quotePairs(line?.proof ?? "", line?.verify ?? "")).toEqual([
            {
                target: "https://github.com/acme/lib/blob/abc123/src/limits.h#L12",
                quote: "#define DEFAULT_LIMIT 1000",
            },
            { target: "/tmp/run.log", quote: "limit=1000" },
        ]);
    });
});

describe("checkLine", () => {
    it("finds a quote on its page, flags one its source does not contain, and leaves tests to a person", async () => {
        const [notes, limits, none, test] = await Promise.all(
            ledgerLines(report).map((line) => checkLine(line, fetchPage))
        );
        expect(notes?.verdict).toBe("found");
        expect(limits?.verdict).toBe("missing");
        expect(none?.verdict).toBe("no-proof");
        expect(test?.verdict).toBe("by-hand");
    });

    it("treats a page that did not load as unloaded, not as a missing quote", () => {
        expect(findQuote("", "anything at all")).toBe("unloaded");
    });

    it("finds a passage in a short body (a one-line log) instead of calling it unloaded", () => {
        expect(findQuote("limit=1000", "limit=1000")).toBe("found");
        expect(findQuote("limit=999", "limit=1000")).toBe("unloaded");
    });
});

describe("needsFollowUp", () => {
    it("lists claims at 80% or more that are missing, without proof or unloaded, and nothing else", () => {
        const check = (confidence: number, verdict: LineCheck["verdict"]): LineCheck => ({
            confidence,
            claim: `${verdict} at ${confidence}`,
            verdict,
            detail: "",
        });
        const checks = [
            check(95, "missing"),
            check(90, "no-proof"),
            check(85, "unloaded"),
            check(60, "no-proof"),
            check(95, "by-hand"),
            check(95, "mostly"),
            check(95, "found"),
        ];
        expect(needsFollowUp(checks).map((item) => item.claim)).toEqual([
            "missing at 95",
            "no-proof at 90",
            "unloaded at 85",
        ]);
    });
});

describe("pageFetcher", () => {
    const realFetch = globalThis.fetch;
    afterEach(() => {
        globalThis.fetch = realFetch;
    });

    it("keeps the direct body when the reader fallback fails", async () => {
        const direct = "short page that still says limit=1000";
        globalThis.fetch = Object.assign(
            async (input: string | URL | Request) =>
                String(input).startsWith("https://r.jina.ai/")
                    ? new Response("", { status: 500 })
                    : new Response(direct),
            { preconnect: realFetch.preconnect }
        );
        expect(await pageFetcher()("https://example.com/short")).toBe(direct);
    });
});
