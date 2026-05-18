import { describe, expect, it } from "bun:test";
import type { QuestionConfig } from "../config";
import type { QaEntry } from "../types";
import { runFanOut } from "./registry";
import { type Sink, SinkError } from "./types";

const entry = { id: "1", tag: "question", project: "P" } as unknown as QaEntry;
const cfg = {} as unknown as QuestionConfig;

describe("runFanOut", () => {
    it("returns ok per sink and isolates failures", async () => {
        const sinks: Sink[] = [
            { name: "good", isEnabled: () => true, emit: async () => {} },
            {
                name: "bad",
                isEnabled: () => true,
                emit: async () => {
                    throw new SinkError("boom", "run fix-it");
                },
            },
            {
                name: "off",
                isEnabled: () => false,
                emit: async () => {
                    throw new Error("should not run");
                },
            },
        ];
        const res = await runFanOut(entry, cfg, sinks);
        expect(res.find((r) => r.name === "good")?.ok).toBe(true);
        const bad = res.find((r) => r.name === "bad");
        expect(bad?.ok).toBe(false);
        expect(bad?.remedy).toBe("run fix-it");
        expect(res.find((r) => r.name === "off")).toBeUndefined();
    });

    it("times out a hung sink without throwing", async () => {
        const slow: Sink[] = [{ name: "slow", isEnabled: () => true, emit: () => new Promise(() => {}) }];
        const t = Date.now();
        const res = await runFanOut(entry, cfg, slow, 200);
        expect(res[0].ok).toBe(false);
        expect(res[0].error).toMatch(/timeout/i);
        expect(Date.now() - t).toBeLessThan(1000);
    });
});
