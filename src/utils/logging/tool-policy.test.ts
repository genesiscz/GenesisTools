import { describe, expect, it } from "bun:test";
import { consoleFloorFor } from "./tool-policy";

describe("tool-policy", () => {
    it("absent tool ⇒ info; claude ⇒ warn", () => {
        expect(consoleFloorFor("some-random-tool")).toBe("info");
        expect(consoleFloorFor("claude")).toBe("warn");
    });
});
