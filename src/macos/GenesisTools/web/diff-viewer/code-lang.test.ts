import { describe, expect, test } from "bun:test";
import { fenceInfo, fenceLanguage } from "./code-lang";

describe("fenceLanguage", () => {
    test("the names GitLab and GitHub notes use map to shiki's", () => {
        expect(fenceLanguage("ts")).toBe("typescript");
        expect(fenceLanguage("tsx")).toBe("tsx");
        expect(fenceLanguage("TSX")).toBe("tsx");
        expect(fenceLanguage("js")).toBe("javascript");
        expect(fenceLanguage("json")).toBe("json");
        expect(fenceLanguage("swift")).toBe("swift");
        expect(fenceLanguage("sh")).toBe("bash");
        expect(fenceLanguage("Shell")).toBe("bash");
        expect(fenceLanguage("yml")).toBe("yaml");
    });

    test("only the first word counts, and an unknown or empty one gets no colour", () => {
        expect(fenceLanguage('tsx title="Button.tsx"')).toBe("tsx");
        expect(fenceLanguage("ts{1,3}")).toBe("typescript");
        expect(fenceLanguage("")).toBeNull();
        expect(fenceLanguage("text")).toBeNull();
        expect(fenceLanguage("brainfuck")).toBeNull();
    });
});

describe("fenceInfo", () => {
    test("a fence line gives its info, any other line null", () => {
        expect(fenceInfo("```tsx")).toBe("tsx");
        expect(fenceInfo("  ~~~ ts ")).toBe("ts");
        expect(fenceInfo("```")).toBe("");
        expect(fenceInfo("const a = 1")).toBeNull();
        expect(fenceInfo("``not a fence")).toBeNull();
    });
});
