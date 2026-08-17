import { describe, expect, it } from "bun:test";
import { asArgsObject } from "./call.ts";

describe("asArgsObject", () => {
    it("passes plain objects through", () => {
        expect(asArgsObject({ limit: 5 }, "stdin")).toEqual({ limit: 5 });
    });

    it("rejects arrays, primitives and null, naming the source", () => {
        expect(() => asArgsObject([1, 2], "args.json")).toThrow(/args\.json.*an array/);
        expect(() => asArgsObject("x", "stdin")).toThrow(/stdin.*string/);
        expect(() => asArgsObject(5, "the args argument")).toThrow(/number/);
        expect(() => asArgsObject(null, "stdin")).toThrow(/object/);
    });
});
