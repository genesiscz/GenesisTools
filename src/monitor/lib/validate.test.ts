import { describe, expect, test } from "bun:test";
import { DEFAULT_INTERVAL_SEC, DEFAULT_TIMEOUT_MS, WATCHER_KINDS } from "./types";
import {
    normalizeTarget,
    parseEntityId,
    parseNotifyTargetPatch,
    parseWatcherInput,
    parseWatcherPatch,
    WatcherValidationError,
} from "./validate";

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
            mutedUntil: null,
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

    test("a kind change without a target is refused", () => {
        // The row would keep the old kind's target: an ai-provider watcher
        // pointing at https://example.com/ reports "no AI account with id
        // https://example.com/" on every tick, forever.
        expect(() => parseWatcherPatch({ kind: "ai-provider" }, "website")).toThrow(WatcherValidationError);
        expect(() => parseWatcherPatch({ kind: "statuspage" }, "website")).toThrow(
            "changing the kind to statuspage needs a target for it"
        );
    });

    test("a kind change with a target is accepted and normalized for the new kind", () => {
        expect(parseWatcherPatch({ kind: "statuspage", target: "status.x.dev/foo" }, "website")).toEqual({
            kind: "statuspage",
            target: "https://status.x.dev",
        });
    });

    test("naming the same kind without a target is fine", () => {
        expect(parseWatcherPatch({ kind: "website", enabled: false }, "website")).toEqual({
            kind: "website",
            enabled: false,
        });
    });
});

describe("parseNotifyTargetPatch", () => {
    test("a channel change without a config is refused", () => {
        // The row would keep the previous channel's fields: a webhook reporting
        // as telegram, with a url and no botToken, silently dead.
        expect(() => parseNotifyTargetPatch({ channel: "telegram" }, "webhook")).toThrow(WatcherValidationError);
    });

    test("a channel change with the new channel's config is accepted", () => {
        expect(
            parseNotifyTargetPatch({ channel: "telegram", config: { botToken: "1:A", chatId: "-1" } }, "webhook")
        ).toEqual({ channel: "telegram", config: { botToken: "1:A", chatId: "-1" } });
    });

    test("naming the same channel without a config is fine", () => {
        expect(parseNotifyTargetPatch({ channel: "webhook", enabled: false }, "webhook")).toEqual({
            channel: "webhook",
            enabled: false,
        });
    });
});

describe("parseNotifyTargetPatch channel switch", () => {
    test("an empty config on a channel change is refused: no stored secret carries over", () => {
        expect(() => parseNotifyTargetPatch({ channel: "telegram", config: {} }, "webhook")).toThrow(
            /telegram target needs config.botToken/
        );
        expect(() => parseNotifyTargetPatch({ channel: "webhook", config: {} }, "telegram")).toThrow(
            /webhook target needs config.url/
        );
    });
});

describe("watcher kind errors", () => {
    test("the message names every supported kind, not a stale three", () => {
        // `rss`, `tcp`, `dns`, `tls`, `json` and `command` all have a wired-up
        // check pipeline, and the message used to say only three kinds existed.
        for (const parse of [
            () => parseWatcherInput({ name: "a", kind: "rrs", target: "https://a.dev/" }),
            () => parseWatcherPatch({ kind: "rrs" }, "website"),
        ]) {
            expect(parse).toThrow(WatcherValidationError);

            try {
                parse();
            } catch (error) {
                for (const kind of WATCHER_KINDS) {
                    expect((error as Error).message).toContain(kind);
                }
            }
        }
    });
});

describe("parseEntityId", () => {
    test("takes a whole positive integer and nothing else", () => {
        expect(parseEntityId("3")).toBe(3);
        expect(parseEntityId(" 12 ")).toBe(12);

        // `Number.parseInt` reads all three as valid ids, so `monitor edit 3abc`
        // used to edit watcher 3.
        for (const bad of ["3abc", "0", "-2", "", "1.5", "1e3"]) {
            expect(() => parseEntityId(bad)).toThrow(WatcherValidationError);
        }

        expect(() => parseEntityId("x", "target")).toThrow(/target id/);
    });
});
