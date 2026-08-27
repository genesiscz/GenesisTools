import { describe, expect, test } from "bun:test";
import { classifyEvalError, closeTabCandidates, makeMatcher, NoMatchingTabError, pickPageTarget } from "./cdp.ts";

describe("pickPageTarget", () => {
    test("throws when no tab URL matches instead of returning the first tab", () => {
        const pages = [
            { type: "page", url: "http://localhost:3000/" },
            { type: "page", url: "https://idp.example.com/login" },
        ];

        expect(() => pickPageTarget(pages, { url: "app.example.com" })).toThrow('no tab matching "app.example.com"');
    });

    test("returns the matching tab when the URL substring hits", () => {
        const pages = [
            { type: "page", url: "http://localhost:3000/" },
            { type: "page", url: "https://app.example.com/portal" },
        ];

        expect(pickPageTarget(pages, { url: "app.example.com" }).url).toBe("https://app.example.com/portal");
    });

    test("errors with the port when there is no page at all", () => {
        expect(() => pickPageTarget([], { port: 9222 })).toThrow("no page target on port 9222");
    });

    test("matches on the tab title too, not only the URL", () => {
        const pages = [{ type: "page", title: "Chartjs demo", url: "http://127.0.0.1:3079/x" }];

        expect(pickPageTarget(pages, { url: "Chartjs" }).url).toBe("http://127.0.0.1:3079/x");
    });

    test("a miss carries the closest tabs, so the CLI can print them", () => {
        const pages = [
            { type: "page", title: "demo", url: "http://127.0.0.1:3079/chartjs-demo" },
            { type: "page", title: "docs", url: "https://example.com/docs" },
        ];

        try {
            pickPageTarget(pages, { url: "3079/chartjs-demo-typo" });
            throw new Error("expected a NoMatchingTabError");
        } catch (err) {
            expect(err).toBeInstanceOf(NoMatchingTabError);
            expect((err as NoMatchingTabError).candidates[0].url).toBe("http://127.0.0.1:3079/chartjs-demo");
        }
    });
});

describe("makeMatcher", () => {
    test("plain patterns are substrings", () => {
        expect(makeMatcher("3079")("http://127.0.0.1:3079/x")).toBe(true);
        expect(makeMatcher("3079")("http://127.0.0.1:3080/x")).toBe(false);
    });

    test("/pattern/flags is a regex — the --match help promised this from day one", () => {
        expect(makeMatcher("/30(79|81)/")("http://127.0.0.1:3081/x")).toBe(true);
        expect(makeMatcher("/^https:/")("http://127.0.0.1:3081/x")).toBe(false);
        expect(makeMatcher("/CHARTJS/i")("http://127.0.0.1:3079/chartjs")).toBe(true);
    });

    test("a bare slash-free pattern that looks regexy stays literal", () => {
        expect(makeMatcher("a|b")("x a|b y")).toBe(true);
        expect(makeMatcher("a|b")("just a")).toBe(false);
    });
});

describe("closeTabCandidates", () => {
    test("ranks tabs sharing tokens with the failed match first", () => {
        const pages = [
            { title: "unrelated", url: "https://example.com/" },
            { title: "demo", url: "http://127.0.0.1:3079/chartjs-demo" },
        ];

        expect(closeTabCandidates(pages, "3079/chartjs-demo-typo")[0].url).toBe("http://127.0.0.1:3079/chartjs-demo");
    });

    test("with no token overlap it still shows what is open, capped", () => {
        const pages = Array.from({ length: 20 }, (_, i) => ({ title: "t", url: `https://a.example/${i}` }));

        expect(closeTabCandidates(pages, "zzzzzz")).toHaveLength(6);
    });
});

/**
 * Regression test: PR #336 review t1. The eval path treated any error whose text
 * contained "connection closed" as proof the script had navigated, and exited 0.
 * That is a websocket-level failure, not a CDP navigation signal — the browser
 * dying mid-eval produces it too, and the expression may never have run. Exit 0
 * there tells an automation caller a navigation happened when nothing did.
 */
describe("classifyEvalError", () => {
    test("the two CDP protocol errors mean the script navigated the page", () => {
        expect(classifyEvalError("Execution context was destroyed.")).toBe("navigated");
        expect(classifyEvalError("Inspected target navigated or closed")).toBe("navigated");
    });

    test("matching is case-insensitive, as Chrome's casing has changed between versions", () => {
        expect(classifyEvalError("execution CONTEXT WAS DESTROYED")).toBe("navigated");
    });

    test("a closed connection is a failure, not a navigation", () => {
        expect(classifyEvalError("connection closed")).toBe("failed");
        expect(classifyEvalError("WebSocket connection closed before the response arrived")).toBe("failed");
    });

    test("anything else is a failure", () => {
        expect(classifyEvalError("SyntaxError: Unexpected token")).toBe("failed");
        expect(classifyEvalError("")).toBe("failed");
    });
});
