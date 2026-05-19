import { describe, expect, it } from "bun:test";

describe("p/ default backend (static clack, sync — no opentui)", () => {
    it("getBackend() returns a working clack backend WITHOUT a prior setBackend, and stays sync", () => {
        const { getBackend } = require("./backend") as typeof import("./backend");
        const b = getBackend(); // SYNC — no await (advisor: 700+ sync log.* callers)
        expect(typeof b.text).toBe("function");
        expect(typeof b.log.info).toBe("function");
    });
    it("does not pull @opentui into the module graph from the default path", () => {
        // resolved specifiers of the loaded p/ graph must not include @opentui
        const ids = Object.keys(require.cache ?? {});
        expect(ids.some((m) => m.includes("@opentui"))).toBe(false);
    });
});
