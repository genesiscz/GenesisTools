import { describe, expect, test } from "bun:test";
import { identityMismatch } from "./identity-guard";

describe("identityMismatch", () => {
    test("two different uuids are a mismatch", () => {
        expect(identityMismatch({ storedUuid: "a", incomingUuid: "b" })).toBe(true);
    });

    test("the same uuid is not", () => {
        expect(identityMismatch({ storedUuid: "a", incomingUuid: "a" })).toBe(false);
    });

    // An unprovable identity must never block: a first login has nothing
    // stored, and a profile fetch can fail without meaning "wrong person".
    test("a missing stored uuid is not a mismatch (first login)", () => {
        expect(identityMismatch({ incomingUuid: "b" })).toBe(false);
    });

    test("a missing incoming uuid is not a mismatch (profile unreadable)", () => {
        expect(identityMismatch({ storedUuid: "a" })).toBe(false);
    });

    test("neither known is not a mismatch", () => {
        expect(identityMismatch({})).toBe(false);
    });
});
