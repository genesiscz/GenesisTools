import { describe, expect, test } from "bun:test";
import { DEFAULT_INTERVAL_SEC, DEFAULT_TIMEOUT_MS } from "./types";
import { normalizeTarget, parseWatcherInput, parseWatcherPatch, WatcherValidationError } from "./validate";

describe("normalizeTarget", () => {
    test("adds https:// to a bare host for websites", () => {
        expect(normalizeTarget("website", "example.com/health")).toBe("https://example.com/health");
    });

    test("keeps only the origin for status pages", () => {
        expect(normalizeTarget("statuspage", "https://status.claude.com/incidents/abc?x=1")).toBe(
            "https://status.claude.com"
        );
    });

    test("requires an acc_ id for ai-provider", () => {
        expect(normalizeTarget("ai-provider", "acc_claude-main")).toBe("acc_claude-main");
        expect(() => normalizeTarget("ai-provider", "https://x")).toThrow(WatcherValidationError);
    });

    test("rejects garbage URLs", () => {
        expect(() => normalizeTarget("website", "http://")).toThrow(WatcherValidationError);
        expect(() => normalizeTarget("website", "   ")).toThrow(WatcherValidationError);
    });
});

describe("parseWatcherInput", () => {
    test("fills defaults", () => {
        const input = parseWatcherInput({ name: "  Foo ", kind: "website", target: "foo.dev" });

        expect(input).toEqual({
            name: "Foo",
            kind: "website",
            target: "https://foo.dev/",
            config: {},
            intervalSec: DEFAULT_INTERVAL_SEC,
            timeoutMs: DEFAULT_TIMEOUT_MS,
            enabled: true,
            notify: true,
            targetIds: [],
        });
    });

    test("parses numeric strings from CLI flags and drops empty config keys", () => {
        const input = parseWatcherInput({
            name: "x",
            kind: "website",
            target: "https://x.dev",
            intervalSec: "300",
            timeoutMs: "5000",
            config: { expectStatus: "401", expectBody: "  ", degradedAboveMs: 1500, components: "" },
        });

        expect(input.intervalSec).toBe(300);
        expect(input.timeoutMs).toBe(5000);
        expect(input.config).toEqual({ expectStatus: 401, degradedAboveMs: 1500 });
    });

    test("statuspage components accept a comma list", () => {
        const input = parseWatcherInput({
            name: "x",
            kind: "statuspage",
            target: "status.claude.com",
            config: { components: "Claude API, Console" },
        });

        expect(input.config?.components).toEqual(["Claude API", "Console"]);
    });

    test("rejects out-of-range interval, bad kind and missing name", () => {
        expect(() => parseWatcherInput({ name: "x", kind: "website", target: "x.dev", intervalSec: 1 })).toThrow(
            /intervalSec/
        );
        expect(() => parseWatcherInput({ name: "x", kind: "ftp", target: "x.dev" })).toThrow(/kind/);
        expect(() => parseWatcherInput({ kind: "website", target: "x.dev" })).toThrow(/name/);
    });
});

describe("parseWatcherPatch", () => {
    test("only carries the keys that were sent", () => {
        expect(parseWatcherPatch({ enabled: false }, "website")).toEqual({ enabled: false });
    });

    test("normalizes target with the current kind", () => {
        expect(parseWatcherPatch({ target: "status.x.dev/foo" }, "statuspage")).toEqual({
            target: "https://status.x.dev",
        });
    });

    test("rejects an empty name", () => {
        expect(() => parseWatcherPatch({ name: "  " }, "website")).toThrow(WatcherValidationError);
    });
});
