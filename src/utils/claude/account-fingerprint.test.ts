import { afterEach, describe, expect, test } from "bun:test";
import { SafeJSON } from "@genesiscz/utils/json";
import {
    type AccountFingerprint,
    findDuplicateAccounts,
    fingerprintFromHeaders,
    fingerprintKey,
    isOrgDeadRefusal,
    orgMismatch,
    probeTokenOrg,
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
        // The real 2026-08-26 incident: uzivatel-a's token billed martin.
        const groups = findDuplicateAccounts([
            { account: "uzivatel-a", fingerprint: fp("1787772000", "1788296400", "0.94"), error: null },
            { account: "martin", fingerprint: fp("1787772000", "1788296400", "0.95"), error: null },
            { account: "olivia", fingerprint: fp("1787760000", "1788100000"), error: null },
        ]);

        expect(groups).toHaveLength(1);
        expect(groups[0].accounts).toEqual(["martin", "uzivatel-a"]);
    });

    test("distinct anchors are not duplicates", () => {
        // Post-fix state: uzivatel-a re-captured, anchors now differ.
        expect(
            findDuplicateAccounts([
                { account: "uzivatel-a", fingerprint: fp("1787767800", "1787875200"), error: null },
                { account: "martin", fingerprint: fp("1787772000", "1788296400"), error: null },
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

const ORG_DEAD_BODY = SafeJSON.stringify({
    type: "error",
    error: {
        type: "permission_error",
        message: "OAuth authentication is currently not allowed for this organization.",
    },
    request_id: "req_011CeXGkPM8BtaQFgMADEC3S",
});

/**
 * What a HEALTHY setup token draws on the profile endpoint. Reading this as a
 * dead org is what would report a live, just-renewed account as expired.
 */
const SCOPE_REFUSAL_BODY = SafeJSON.stringify({
    type: "error",
    error: { type: "permission_error", message: "OAuth token does not meet scope requirement user:profile" },
});

describe("isOrgDeadRefusal", () => {
    test("recognises the org-level 403", () => {
        expect(isOrgDeadRefusal(403, ORG_DEAD_BODY)).toBe(true);
    });

    test("a scope refusal is NOT a dead org", () => {
        expect(isOrgDeadRefusal(403, SCOPE_REFUSAL_BODY)).toBe(false);
    });

    test("only 403 qualifies", () => {
        expect(isOrgDeadRefusal(401, ORG_DEAD_BODY)).toBe(false);
        expect(isOrgDeadRefusal(429, ORG_DEAD_BODY)).toBe(false);
        expect(isOrgDeadRefusal(200, ORG_DEAD_BODY)).toBe(false);
    });

    test("an empty body is not a dead org", () => {
        expect(isOrgDeadRefusal(403, "")).toBe(false);
    });
});

describe("orgMismatch", () => {
    test("two different orgs are a mismatch", () => {
        expect(orgMismatch({ storedOrg: "a874534e", incomingOrg: "c1b9dd83" })).toBe(true);
    });

    test("the same org is not a mismatch", () => {
        expect(orgMismatch({ storedOrg: "a874534e", incomingOrg: "a874534e" })).toBe(false);
    });

    test("an unprovable identity is not a mismatch", () => {
        expect(orgMismatch({ incomingOrg: "c1b9dd83" })).toBe(false);
        expect(orgMismatch({ storedOrg: "a874534e" })).toBe(false);
        expect(orgMismatch({})).toBe(false);
    });
});

describe("probeTokenOrg", () => {
    const realFetch = globalThis.fetch;

    afterEach(() => {
        globalThis.fetch = realFetch;
    });

    /** A canned response with the given status and org header. */
    function stubFetch(status: number, organizationId?: string, body = "{}"): void {
        const headers = new Headers();

        if (organizationId) {
            headers.set("anthropic-organization-id", organizationId);
        }

        // Object.assign rather than a cast: Bun's `fetch` type carries a
        // `preconnect` member, and `as any` is banned in this repo.
        globalThis.fetch = Object.assign(async () => new Response(body, { status, headers }), {
            preconnect: realFetch.preconnect,
        });
    }

    test("a 2xx WITH the org header is ok, and names the org", async () => {
        // The negative control: the normal, working path must still be "ok", or
        // the guard below would block every legitimate login.
        stubFetch(200, "org-abc");
        const probe = await probeTokenOrg("sk-ant-oat01-x");

        expect(probe.verdict).toBe("ok");
        expect(probe.organizationUuid).toBe("org-abc");
    });

    test("a 2xx WITHOUT the org header is unreachable, not ok", async () => {
        // PR #343 review t1 round 11. Such a response proves the token WORKS but
        // not whose it is, and orgMismatch treats a missing incoming side as "no
        // mismatch" — so calling it "ok" let an identified account accept a token
        // of unestablished ownership. Unreachable makes that path fail closed.
        stubFetch(200);
        const probe = await probeTokenOrg("sk-ant-oat01-x");

        expect(probe.verdict).toBe("unreachable");
        expect(probe.organizationUuid).toBeUndefined();
    });

    test("a network failure is unreachable", async () => {
        globalThis.fetch = Object.assign(
            async () => {
                throw new Error("connect ECONNREFUSED");
            },
            { preconnect: realFetch.preconnect }
        );

        expect((await probeTokenOrg("sk-ant-oat01-x")).verdict).toBe("unreachable");
    });

    test("org-dead can legitimately carry NO org, which is why the caller must gate it", async () => {
        // PR #343 review t1 round 12. `orgMismatch` treats a missing incoming
        // org as "no mismatch", so an org-dead verdict without an org id let an
        // identified account save an unattributed token. The probe's own job is
        // only to report honestly; login-long routes any org-less verdict
        // through the same unverified-save gate as `unreachable`.
        // A real org-refusal body, so this takes the org-dead branch rather
        // than falling through to `invalid`.
        stubFetch(403, undefined, '{"error":{"message":"not allowed for this organization"}}');
        const probe = await probeTokenOrg("sk-ant-oat01-x");

        expect(probe.verdict).toBe("org-dead");
        expect(probe.organizationUuid).toBeUndefined();
    });

    test("401 is still an invalid token, not merely unreachable", async () => {
        // Guards the other direction: the fix must not turn a REJECTED token
        // into a soft failure that the ask-anyway prompt would let through.
        stubFetch(401, "org-abc");

        expect((await probeTokenOrg("sk-ant-oat01-x")).verdict).toBe("invalid");
    });
});
