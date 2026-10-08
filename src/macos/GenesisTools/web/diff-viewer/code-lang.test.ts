import { describe, expect, test } from "bun:test";
import { fencedParts, fenceInfo, fenceLanguage } from "./code-lang";

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

describe("fencedParts", () => {
    test("keeps prose after each fence and the languages of successive blocks", () => {
        expect(fencedParts("before\n```ts\nlet a = 1\n```\nafter\n```swift\nlet b = 2\n```\nend")).toEqual([
            { kind: "prose", text: "before" },
            { kind: "code", text: "let a = 1", language: "ts" },
            { kind: "prose", text: "after" },
            { kind: "code", text: "let b = 2", language: "swift" },
            { kind: "prose", text: "end" },
        ]);
    });

    test("plain prose and an unclosed code fence retain their contents", () => {
        expect(fencedParts("plain")).toEqual([{ kind: "prose", text: "plain" }]);
        expect(fencedParts("```ts\ncode")).toEqual([{ kind: "code", text: "code", language: "ts" }]);
    });
});
