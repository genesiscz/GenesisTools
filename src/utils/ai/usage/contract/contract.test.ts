import { describe, expect, test } from "bun:test";
import {
    autoSeriesStepMs,
    parseStep,
    parseWhen,
    resolveProviderList,
    resolveWindow,
    selectAccounts,
    UsageQueryError,
    usageEnvelope,
} from "./index";

const NOW = new Date("2026-11-03T10:30:00.000Z");
const TZ = "Europe/Prague";

function codeOf(run: () => unknown): string | undefined {
    try {
        run();
    } catch (err) {
        if (err instanceof UsageQueryError) {
            return err.code;
        }

        throw err;
    }

    return undefined;
}

describe("the window grammar", () => {
    test("a duration counts back from now, a date is local midnight in --tz", () => {
        expect(parseWhen("6h", { now: NOW, tz: TZ }).toISOString()).toBe("2026-11-03T04:30:00.000Z");
        expect(parseWhen("2026-11-01", { now: NOW, tz: TZ }).toISOString()).toBe("2026-10-31T23:00:00.000Z");
        expect(parseWhen("2026-11-01", { now: NOW, tz: "UTC" }).toISOString()).toBe("2026-11-01T00:00:00.000Z");
    });

    test("today, yesterday, week (Monday start) and month are local boundaries", () => {
        const at = (word: string) => parseWhen(word, { now: NOW, tz: TZ }).toISOString();

        expect(at("today")).toBe("2026-11-02T23:00:00.000Z");
        expect(at("yesterday")).toBe("2026-11-01T23:00:00.000Z");
        expect(at("week")).toBe("2026-11-01T23:00:00.000Z");
        expect(at("month")).toBe("2026-10-31T23:00:00.000Z");
    });

    test("an ISO instant needs an offset; a bad date and the reserved keywords refuse", () => {
        expect(parseWhen("2026-11-02T08:00:00+01:00", { now: NOW, tz: TZ }).toISOString()).toBe(
            "2026-11-02T07:00:00.000Z"
        );
        expect(codeOf(() => parseWhen("2026-11-02T08:00", { now: NOW, tz: TZ }))).toBe("bad-window");
        expect(codeOf(() => parseWhen("2026-02-30", { now: NOW, tz: TZ }))).toBe("bad-window");
        expect(codeOf(() => parseWhen("reset", { now: NOW, tz: TZ }))).toBe("reserved");
        expect(codeOf(() => parseWhen("soon", { now: NOW, tz: TZ }))).toBe("bad-window");
    });

    test("old spellings are aliases, and two spellings of one bound refuse", () => {
        const window = resolveWindow({ range: "7d", tz: TZ }, { now: NOW, defaultSince: "24h" });

        expect(window.from.toISOString()).toBe("2026-10-27T10:30:00.000Z");
        expect(window.label).toBe("since 7d");
        expect(resolveWindow({ hours: "2" }, { now: NOW, defaultSince: "24h" }).from.toISOString()).toBe(
            "2026-11-03T08:30:00.000Z"
        );
        expect(codeOf(() => resolveWindow({ since: "1d", from: "2d" }, { now: NOW, defaultSince: "24h" }))).toBe(
            "bad-value"
        );
        expect(codeOf(() => resolveWindow({ since: "1h", until: "2h" }, { now: NOW, defaultSince: "24h" }))).toBe(
            "bad-window"
        );
        expect(codeOf(() => resolveWindow({ tz: "Mars/Olympus" }, { now: NOW, defaultSince: "24h" }))).toBe("bad-zone");
    });
});

describe("the step", () => {
    test("auto keeps at most 720 bins on whole seconds; raw and durations pass through", () => {
        expect(autoSeriesStepMs("2026-11-03T00:00:00.000Z", "2026-11-04T00:00:00.000Z")).toBe(120_000);
        expect(autoSeriesStepMs("2026-11-04T00:00:00.000Z", "2026-11-03T00:00:00.000Z")).toBe(0);
        expect(parseStep(undefined)).toEqual({ kind: "auto" });
        expect(parseStep("raw")).toEqual({ kind: "raw" });
        expect(parseStep("5m")).toEqual({ kind: "fixed", ms: 300_000 });
        expect(codeOf(() => parseStep("day"))).toBe("reserved");
        expect(codeOf(() => parseStep("fast"))).toBe("bad-step");
    });
});

describe("the account selector", () => {
    const CANDIDATES = [
        { provider: "anthropic-sub", accountId: "acc_1", accountName: "work" },
        { provider: "openai-sub", accountId: "acc_2", accountName: "work" },
        { provider: "openai-sub", accountId: "acc_3", accountName: "personal" },
    ];

    test("an id, a provider/name or a unique substring picks one account", () => {
        expect(selectAccounts(["acc_2"], CANDIDATES)?.map((a) => a.accountId)).toEqual(["acc_2"]);
        expect(selectAccounts("codex/work", CANDIDATES)?.map((a) => a.accountId)).toEqual(["acc_2"]);
        expect(selectAccounts(["pers"], CANDIDATES)?.map((a) => a.accountId)).toEqual(["acc_3"]);
        expect(selectAccounts(["acc_3,acc_1"], CANDIDATES)?.map((a) => a.accountId)).toEqual(["acc_1", "acc_3"]);
    });

    test("an ambiguous name lists the candidates; a spend pseudo account refuses on a limits verb", () => {
        expect(codeOf(() => selectAccounts(["work"], CANDIDATES))).toBe("ambiguous-account");
        expect(codeOf(() => selectAccounts(["nobody"], CANDIDATES))).toBe("unknown-account");
        expect(codeOf(() => selectAccounts(["(unbound)"], CANDIDATES))).toBe("pseudo-account");
        expect(selectAccounts(["(unbound)"], CANDIDATES, { acceptPseudo: true })).toHaveLength(1);
    });

    test("negative control: no value selects nothing in particular", () => {
        expect(selectAccounts(undefined, CANDIDATES)).toBeUndefined();
        expect(resolveProviderList(undefined)).toBeUndefined();
    });
});

describe("the envelope", () => {
    test("prints its keys in one order and versions the verb", () => {
        const envelope = usageEnvelope({
            verb: "limits.series",
            version: 1,
            now: NOW,
            accounts: [{ provider: "openai-sub", accountId: "acc_2", accountName: "work" }],
            data: { n: 1 },
        });

        expect(Object.keys(envelope)).toEqual(["schema", "generatedAt", "selector", "data", "warnings"]);
        expect(envelope.schema).toBe("usage.limits.series@1");
        expect(() => usageEnvelope({ verb: "Limits", version: 0, now: NOW, accounts: [], data: null })).toThrow();
    });
});
