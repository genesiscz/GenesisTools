import { describe, expect, test } from "bun:test";
import { SafeJSON } from "@genesiscz/utils/json";
import { parseControlBody } from "./control";

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
