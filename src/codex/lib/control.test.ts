import { describe, expect, test } from "bun:test";
import { SafeJSON } from "@genesiscz/utils/json";
import { APPROVAL_ACTORS, parseApprovalRefusal, parseControlBody, refusalNotice } from "./control";

describe("parseControlBody", () => {
    test("treats plain text as a steer", () => {
        expect(parseControlBody("focus on auth")).toEqual({ op: "steer", body: "focus on auth", force: false });
    });

    test("parses structured ops", () => {
        expect(parseControlBody('{"op":"rollback","turns":2}')).toEqual({ op: "rollback", turns: 2 });
        expect(parseControlBody('{"op":"approve","requestId":"req-1"}')).toEqual({
            op: "approve",
            requestId: "req-1",
        });
    });

    test("supports slash fallbacks", () => {
        expect(parseControlBody("/interrupt")).toEqual({ op: "interrupt" });
        expect(parseControlBody("/rollback 3")).toEqual({ op: "rollback", turns: 3 });
        expect(parseControlBody("/stop")).toEqual({ op: "stop" });
    });

    test("rejects malformed structured controls", () => {
        expect(() => parseControlBody('{"op":"rollback","turns":0}')).toThrow("turns must be at least 1");
        expect(() => parseControlBody('{"op":"explode"}')).toThrow("Unsupported control op");
    });
});

test("guarded steer carries the exact daemon identity and rejects partial or relative homes", () => {
    expect(
        parseControlBody(
            '{"op":"steer","body":"fixture","expectedTarget":{"threadId":"thread-1","home":"/fixture/home"}}'
        )
    ).toEqual({
        op: "steer",
        body: "fixture",
        force: false,
        expectedTarget: { threadId: "thread-1", home: "/fixture/home" },
    });
    for (const expectedTarget of [
        { threadId: "thread-1" },
        { threadId: "", home: "/fixture/home" },
        { threadId: "thread-1", home: "relative" },
    ]) {
        expect(() => parseControlBody(SafeJSON.stringify({ op: "steer", body: "fixture", expectedTarget }))).toThrow(
            "expected Codex target"
        );
    }
});

describe("a deny names who refused and why", () => {
    const deny = (refusal: unknown) => SafeJSON.stringify({ op: "deny", requestId: "req-7", refusal });

    test("a parent refusal with a reason survives the wire form the CLI and the bus send", () => {
        const control = {
            op: "deny",
            requestId: "req-7",
            refusal: { by: "parent", reason: "the dump does not prove full coverage; read the bounded files" },
        } as const;

        expect(parseControlBody(SafeJSON.stringify(control))).toEqual(control);
    });

    test("every actor parses on its own, and an empty reason is dropped", () => {
        for (const by of APPROVAL_ACTORS) {
            expect(parseApprovalRefusal({ by })).toEqual({ by });
        }

        expect(parseApprovalRefusal({ by: "parent", reason: "" })).toEqual({ by: "parent" });
    });

    test("an unknown or missing actor is refused, and the error names the three actors", () => {
        for (const refusal of [{ by: "user" }, { by: "lead" }, { by: 1 }, { reason: "no actor" }, "parent", null]) {
            expect(() => parseControlBody(deny(refusal))).toThrow("refusal.by must be one of parent, human, policy");
        }
    });

    test("a reason that is not a string is refused", () => {
        for (const reason of [42, { text: "fix it" }, ["fix it"], null]) {
            expect(() => parseControlBody(deny({ by: "parent", reason }))).toThrow("refusal.reason must be a string");
        }
    });

    test("a deny without a refusal parses as before", () => {
        expect(parseControlBody('{"op":"deny","requestId":"req-7"}')).toEqual({ op: "deny", requestId: "req-7" });
        expect(parseApprovalRefusal(undefined)).toBeUndefined();
    });

    test("the notice names the parent or the policy, says it is not a human, and carries the reason", () => {
        const parent = refusalNotice("req-7", { by: "parent", reason: "split the review dump" });
        expect(parent).toContain("Request req-7 was declined by the parent session that supervises you, not a human.");
        expect(parent).toContain('Codex reports it as "rejected by user"');
        expect(parent.endsWith(" Reason: split the review dump")).toBe(true);

        const policy = refusalNotice("req-8", { by: "policy" });
        expect(policy).toContain("Request req-8 was declined by this session's write policy, not a human.");
        expect(policy).not.toContain("Reason:");
    });
});
