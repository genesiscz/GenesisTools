import { describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";

describe("sherpa-onnx preflight", () => {
    it("darwin-arm64 prebuilt native addon is present (no source build)", () => {
        const dir = "node_modules/sherpa-onnx-darwin-arm64";
        expect(existsSync(dir)).toBe(true);
    });

    it("module loads without throwing", () => {
        expect(() => require("sherpa-onnx-node")).not.toThrow();
    });
});
