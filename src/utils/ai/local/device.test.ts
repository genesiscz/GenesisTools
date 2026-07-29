import { describe, expect, test } from "bun:test";
import { detectDevice } from "./device";
import { resolvePipelineDevice } from "./runtimes/transformers-js";

describe("detectDevice", () => {
    test("picks the platform's accelerated execution provider", () => {
        const { device, label } = detectDevice();

        if (process.platform === "darwin") {
            expect(device).toBe("coreml");
            expect(label).toContain("CoreML");
        } else if (process.platform === "win32") {
            expect(device).toBe("dml");
        } else if (process.platform === "linux" && process.arch === "x64") {
            expect(device).toBe("cuda");
        } else {
            expect(device).toBe("cpu");
        }
    });
});

describe("resolvePipelineDevice", () => {
    /**
     * The forced-CPU rule. transformers.js's onnxruntime-node binding registers
     * only "cpu" on macOS, so passing it the "coreml" that `detectDevice` picks
     * throws "Unsupported device: 'coreml'". CoreML is still reachable — through
     * the darwinkit runtime, not through transformers.js. If this ever returns
     * "coreml" on darwin, every local pipeline load breaks.
     */
    test("never hands transformers.js a device it cannot register", async () => {
        const device = await resolvePipelineDevice();

        expect(device).not.toBe("coreml");

        if (process.platform === "darwin") {
            expect(device).toBe("cpu");
        }
    });
});
