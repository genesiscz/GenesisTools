import { describe, expect, test } from "bun:test";
import { listLaunchableModels, modelFamilyOf, resolveModelSpec } from "./models";

describe("resolveModelSpec", () => {
    test("alias fable resolves directly", () => {
        const res = resolveModelSpec("fable");
        expect(res.kind).toBe("exact");
        if (res.kind === "exact") {
            expect(res.model.id).toBe("claude-fable-5");
        }
    });

    test("exact id resolves directly, including [1m] variant", () => {
        const res = resolveModelSpec("claude-opus-4-8[1m]");
        expect(res.kind).toBe("exact");
        if (res.kind === "exact") {
            expect(res.model.id).toBe("claude-opus-4-8[1m]");
        }
    });

    test("opus is ambiguous and lists all opus variants incl [1m]", () => {
        const res = resolveModelSpec("opus");
        expect(res.kind).toBe("ambiguous");
        if (res.kind === "ambiguous") {
            const ids = res.candidates.map((c) => c.id);
            expect(ids).toContain("claude-opus-4-8");
            expect(ids).toContain("claude-opus-4-8[1m]");
            expect(ids).toContain("claude-opus-4-6[1m]");
            expect(ids.every((id) => id.includes("opus"))).toBe(true);
        }
    });

    test("dot notation and 1m token filter: '4.8 1m' -> claude-opus-4-8[1m]", () => {
        const res = resolveModelSpec("4.8 1m");
        expect(res.kind).toBe("exact");
        if (res.kind === "exact") {
            expect(res.model.id).toBe("claude-opus-4-8[1m]");
        }
    });

    test("'opus 1m' filters to 1m opus variants only", () => {
        const res = resolveModelSpec("opus 1m");
        expect(res.kind).toBe("ambiguous");
        if (res.kind === "ambiguous") {
            expect(res.candidates.map((c) => c.id)).toEqual([
                "claude-opus-4-8[1m]",
                "claude-opus-4-7[1m]",
                "claude-opus-4-6[1m]",
            ]);
        }
    });

    test("nonsense spec -> none", () => {
        expect(resolveModelSpec("gpt-5").kind).toBe("none");
    });
});

describe("registry helpers", () => {
    test("launchable ids are shell-safe", () => {
        for (const m of listLaunchableModels()) {
            expect(m.id).toMatch(/^[a-z0-9[\]-]+$/);
        }
    });

    test("modelFamilyOf handles [1m] suffix", () => {
        expect(modelFamilyOf("claude-opus-4-8[1m]")).toBe("opus");
        expect(modelFamilyOf("claude-fable-5")).toBe("fable");
        expect(modelFamilyOf("bogus")).toBeUndefined();
    });
});
