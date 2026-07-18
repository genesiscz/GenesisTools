import { describe, expect, test } from "bun:test";
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
