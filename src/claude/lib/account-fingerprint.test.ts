import { describe, expect, test } from "bun:test";
import {
    type AccountFingerprint,
    findDuplicateAccounts,
    fingerprintFromHeaders,
    fingerprintKey,
} from "./account-fingerprint";

function fp(fiveHourReset: string | null, sevenDayReset: string | null, util = "0.5"): AccountFingerprint {
    return {
        fiveHourReset,
        sevenDayReset,
        fiveHourUtilization: util,
        sevenDayUtilization: util,
    };
}

describe("fingerprintKey", () => {
    test("keys on both window anchors", () => {
        expect(fingerprintKey(fp("1787772000", "1788296400"))).toBe("1787772000|1788296400");
    });

    test("ignores utilization so two probes seconds apart still match", () => {
        expect(fingerprintKey(fp("1787772000", "1788296400", "0.91"))).toBe(
            fingerprintKey(fp("1787772000", "1788296400", "0.95"))
        );
    });

    test("no anchors at all is not an identity", () => {
        expect(fingerprintKey(fp(null, null))).toBeNull();
    });

    test("one anchor still identifies", () => {
        expect(fingerprintKey(fp("1787772000", null))).toBe("1787772000|?");
    });
});

describe("findDuplicateAccounts", () => {
    test("flags two labels that share one account", () => {
        // The real 2026-08-26 incident: uzivatel-a's token billed foltyn.
        const groups = findDuplicateAccounts([
            { account: "uzivatel-a", fingerprint: fp("1787772000", "1788296400", "0.94"), error: null },
            { account: "foltyn", fingerprint: fp("1787772000", "1788296400", "0.95"), error: null },
            { account: "olivia", fingerprint: fp("1787760000", "1788100000"), error: null },
        ]);

        expect(groups).toHaveLength(1);
        expect(groups[0].accounts).toEqual(["foltyn", "uzivatel-a"]);
    });

    test("distinct anchors are not duplicates", () => {
        // Post-fix state: uzivatel-a re-captured, anchors now differ.
        expect(
            findDuplicateAccounts([
                { account: "uzivatel-a", fingerprint: fp("1787767800", "1787875200"), error: null },
                { account: "foltyn", fingerprint: fp("1787772000", "1788296400"), error: null },
            ])
        ).toEqual([]);
    });

    test("unverified accounts never create or join a group", () => {
        expect(
            findDuplicateAccounts([
                { account: "blocked-a", fingerprint: null, error: "HTTP 403" },
                { account: "blocked-b", fingerprint: null, error: "HTTP 403" },
            ])
        ).toEqual([]);
    });

    test("the same account probed twice is not a duplicate", () => {
        expect(
            findDuplicateAccounts([
                { account: "solo", fingerprint: fp("1", "2"), error: null },
                { account: "solo", fingerprint: fp("1", "2"), error: null },
            ])
        ).toEqual([]);
    });
});

describe("fingerprintFromHeaders", () => {
    test("reads the unified rate-limit headers", () => {
        const headers = new Headers({
            "anthropic-ratelimit-unified-5h-reset": "1787772000",
            "anthropic-ratelimit-unified-7d-reset": "1788296400",
            "anthropic-ratelimit-unified-5h-utilization": "0.95",
            "anthropic-ratelimit-unified-7d-utilization": "0.32",
        });

        expect(fingerprintFromHeaders(headers)).toEqual({
            fiveHourReset: "1787772000",
            sevenDayReset: "1788296400",
            fiveHourUtilization: "0.95",
            sevenDayUtilization: "0.32",
        });
    });

    test("missing headers become nulls, not empty strings", () => {
        expect(fingerprintFromHeaders(new Headers()).fiveHourReset).toBeNull();
    });
});
