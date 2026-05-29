import { describe, expect, test } from "bun:test";
import { classifyTerminalPreview } from "@app/utils/terminal/line-classify";

describe("classifyTerminalPreview", () => {
    test("classifies common terminal output lines for semantic coloring", () => {
        const lines = classifyTerminalPreview(
            [
                "❯ bun test src/example.test.ts",
                "(pass) feature > renders all surfaces",
                "⚠ warning: partial snapshot",
                "src/file.ts:10:5 error TS2322: nope",
                "+ added line",
                "- removed line",
                "plain output",
            ].join("\n")
        );

        expect(lines[0]?.kind).toBe("prompt");
        expect(lines[1]?.kind).toBe("success");
        expect(lines[2]?.kind).toBe("warning");
        expect(lines[3]?.kind).toBe("error");
        expect(lines[4]?.kind).toBe("diff-add");
        expect(lines[5]?.kind).toBe("diff-remove");
        expect(lines[6]?.kind).toBe("plain");
    });
});
