import { describe, expect, test } from "bun:test";
import { sessionIdMatches, targetMatchesSession } from "./fold";

const FULL = "cd4e9457-105b-45f5-829d-9c4f554df36a";
const LEADING_SEGMENT = "cd4e9457";

// The two functions look interchangeable and are one character apart at every call
// site, but only one of them may accept an abbreviation. executor.test.ts covers the
// consequences through post/list/claim; these pin the rule at the function itself.
describe("sessionIdMatches (actor identity)", () => {
    test("equal ids match", () => {
        expect(sessionIdMatches(FULL, FULL)).toBe(true);
    });

    test("an abbreviated id never establishes identity, in either direction", () => {
        // Paste blocks publish the leading segment, so a prefix match here would let
        // anyone who merely read one act with poster/claimer authority.
        expect(sessionIdMatches(LEADING_SEGMENT, FULL)).toBe(false);
        expect(sessionIdMatches(FULL, LEADING_SEGMENT)).toBe(false);
    });

    test("null never matches anything, including another null", () => {
        expect(sessionIdMatches(null, null)).toBe(false);
        expect(sessionIdMatches(undefined, undefined)).toBe(false);
        expect(sessionIdMatches(FULL, null)).toBe(false);
        expect(sessionIdMatches(null, FULL)).toBe(false);
    });
});

describe("targetMatchesSession (target discovery)", () => {
    test("an exact target matches", () => {
        expect(targetMatchesSession(FULL, FULL)).toBe(true);
    });

    test("a target abbreviated to the leading segment names the session", () => {
        expect(targetMatchesSession(LEADING_SEGMENT, FULL)).toBe(true);
    });

    test("the abbreviation must end on a segment boundary", () => {
        // "cd4e9457-105" stops mid-segment: it names no session on its own.
        expect(targetMatchesSession("cd4e9457-105", FULL)).toBe(false);
        expect(targetMatchesSession("cd4e945", FULL)).toBe(false);
    });

    test("a prefix shorter than one segment is never enough", () => {
        expect(targetMatchesSession("cd4e", FULL)).toBe(false);
        expect(targetMatchesSession("", FULL)).toBe(false);
    });

    test("a session that merely shares leading characters is not the target", () => {
        expect(targetMatchesSession(LEADING_SEGMENT, "cd4e9458-0000-0000-0000-000000000000")).toBe(false);
        expect(targetMatchesSession(LEADING_SEGMENT, "cd4e94570000-1111-2222-3333-444444444444")).toBe(false);
    });

    test("the match is directional — an abbreviated ACTOR matches no full target", () => {
        expect(targetMatchesSession(FULL, LEADING_SEGMENT)).toBe(false);
    });

    test("null never matches anything", () => {
        expect(targetMatchesSession(null, FULL)).toBe(false);
        expect(targetMatchesSession(FULL, null)).toBe(false);
        expect(targetMatchesSession(null, null)).toBe(false);
    });
});
