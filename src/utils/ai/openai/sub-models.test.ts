import { describe, expect, it } from "bun:test";
import { OPENAI_SUB_STATIC_CATALOG, resolveOpenAiSubModel } from "./sub-models";

describe("resolveOpenAiSubModel", () => {
    it("passes concrete ids and unknown values through unchanged", () => {
        expect(resolveOpenAiSubModel("gpt-5.5")).toBe("gpt-5.5");
        expect(resolveOpenAiSubModel("made-up-model")).toBe("made-up-model");
    });

    it("resolves builtin aliases against the static catalog", () => {
        const firstListed = OPENAI_SUB_STATIC_CATALOG.find((record) => record.visibility === "list");
        expect(resolveOpenAiSubModel("latest")).toBe(firstListed?.slug ?? "latest");

        const codex = resolveOpenAiSubModel("codex");
        expect(codex).not.toBe("codex");

        const mini = resolveOpenAiSubModel("mini");
        expect(mini).toContain("mini");
    });

    it("prefers config aliases over builtins", () => {
        expect(resolveOpenAiSubModel("latest", { latest: "gpt-5.4" })).toBe("gpt-5.4");
        expect(resolveOpenAiSubModel("fast", { fast: "gpt-5.4-mini" })).toBe("gpt-5.4-mini");
    });
});

describe("native Codex model names", () => {
    it.each([
        ["astra", "gpt-6-astra"],
        ["terra", "gpt-5.6-terra"],
        ["luna", "gpt-5.6-luna"],
        ["sol", "gpt-5.6-sol"],
    ])("resolves %s consistently", (alias, expected) => {
        expect(resolveOpenAiSubModel(alias)).toBe(expected);
    });
});
