import { describe, expect, it } from "bun:test";
import { ensureToolRequiredArrays } from "@app/ai-proxy/lib/translators/formats/anthropic/ensure-tool-required";

describe("ensureToolRequiredArrays", () => {
    it("adds required: [] only where missing and leaves existing arrays untouched", () => {
        const body = {
            model: "grok-4.6",
            tools: [
                { name: "a", input_schema: { type: "object", properties: {} } },
                { name: "b", input_schema: { type: "object", required: ["path"] } },
            ],
        };

        const out = ensureToolRequiredArrays(body) as typeof body;

        expect((out.tools[0].input_schema as Record<string, unknown>).required).toEqual([]);
        expect((out.tools[1].input_schema as Record<string, unknown>).required).toEqual(["path"]);
    });

    it("does not mutate its input", () => {
        const body = {
            tools: [{ name: "a", input_schema: { type: "object" } }],
        };

        ensureToolRequiredArrays(body);

        expect("required" in body.tools[0].input_schema).toBe(false);
    });

    it("returns the same object when nothing needs fixing", () => {
        const body = { model: "grok-4.6", messages: [] };

        expect(ensureToolRequiredArrays(body)).toBe(body);
    });
});
