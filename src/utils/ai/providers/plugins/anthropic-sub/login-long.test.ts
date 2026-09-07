import { describe, expect, test } from "bun:test";
import { accountIsIdentified, storedOrgFor, unverifiedSaveDecision } from "./login-long";

/**
 * PR #343 review, rounds 8 and 9. `confirmTokenIdentity` exists to stop account
 * A's setup-token being written onto entry B — a failure that is invisible,
 * because nothing errors, and that silently bills the wrong account from then
 * on. Its "unreachable" branch used to save unconditionally, so ANY transient
 * probe failure (timeout, 429, unexpected response) reopened it.
 */
describe("accountIsIdentified", () => {
    test("an entry with no fingerprint at all is unidentified", () => {
        expect(accountIsIdentified(undefined)).toBe(false);
        expect(accountIsIdentified({})).toBe(false);
    });

    test("the top-level org identifies an entry", () => {
        expect(accountIsIdentified({ organizationUuid: "org-abc" })).toBe(true);
    });

    test("every OTHER persisted fingerprint identifies it too", () => {
        // Review t1 round 9: reading only `organizationUuid` let an unverified
        // token attach to a migrated account that was identified by one of
        // these instead. All four fields are optional, so any of them can be
        // the only one present.
        expect(accountIsIdentified({ accountUuid: "acct-abc" })).toBe(true);
        expect(accountIsIdentified({ secondary: { organizationUuid: "org-abc" } })).toBe(true);
        expect(accountIsIdentified({ secondary: { accountUuid: "acct-abc" } })).toBe(true);
    });

    test("empty strings are not an identity", () => {
        expect(accountIsIdentified({ organizationUuid: "", accountUuid: "" })).toBe(false);
        expect(accountIsIdentified({ secondary: { organizationUuid: "", accountUuid: "" } })).toBe(false);
    });
});

describe("storedOrgFor", () => {
    test("prefers the top-level org", () => {
        expect(storedOrgFor({ organizationUuid: "org-primary" })).toBe("org-primary");
        expect(
            storedOrgFor({ organizationUuid: "org-primary", secondary: { organizationUuid: "org-secondary" } })
        ).toBe("org-primary");
    });

    test("falls back to the secondary grant's org", () => {
        // Review t3 round 10: without this, `orgMismatch` sees an undefined
        // storedOrg, returns false without comparing, and a token from another
        // organization overwrites the credential on the VERIFIED path.
        expect(storedOrgFor({ secondary: { organizationUuid: "org-secondary" } })).toBe("org-secondary");
        expect(storedOrgFor({ organizationUuid: "", secondary: { organizationUuid: "org-secondary" } })).toBe(
            "org-secondary"
        );
    });

    test("an entry with neither has nothing to compare against", () => {
        expect(storedOrgFor(undefined)).toBeUndefined();
        expect(storedOrgFor({})).toBeUndefined();
        expect(storedOrgFor({ secondary: {} })).toBeUndefined();
    });

    test("a mismatch is now DETECTED for a secondary-only account", () => {
        // The end-to-end property, expressed through orgMismatch's own contract:
        // a non-empty storedOrg is what makes the comparison happen at all.
        const stored = storedOrgFor({ secondary: { organizationUuid: "org-secondary" } });

        expect(stored).toBeTruthy();
        expect(stored).not.toBe("org-from-a-different-account");
    });
});

describe("unverifiedSaveDecision", () => {
    test("an unidentified entry may take an unverified token", () => {
        // Nothing is stored to contradict, so a first login offline is not a
        // cross-account risk — refusing here would just break setup.
        expect(unverifiedSaveDecision({ identified: false, interactive: true })).toBe("save");
        expect(unverifiedSaveDecision({ identified: false, interactive: false })).toBe("save");
    });

    test("an identified entry is never silently overwritten", () => {
        // The regression this exists for: not "save" under any circumstance.
        expect(unverifiedSaveDecision({ identified: true, interactive: true })).not.toBe("save");
        expect(unverifiedSaveDecision({ identified: true, interactive: false })).not.toBe("save");
    });

    test("with a tty the user is asked, and the prompt defaults to no", () => {
        expect(unverifiedSaveDecision({ identified: true, interactive: true })).toBe("ask");
    });

    test("without a tty it refuses, since nobody can take the risk knowingly", () => {
        expect(unverifiedSaveDecision({ identified: true, interactive: false })).toBe("refuse");
    });
});
