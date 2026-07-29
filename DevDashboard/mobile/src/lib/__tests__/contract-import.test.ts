import { paths } from "@dd/contract";
import { describe, expect, it } from "bun:test";

describe("contract import", () => {
    it("resolves the endpoint catalog without dragging server runtime", () => {
        expect(paths.pulse()).toBe("/api/system/pulse");
    });
});
