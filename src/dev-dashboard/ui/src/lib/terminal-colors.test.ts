import { describe, expect, test } from "bun:test";
import { classifyTerminalPreview } from "@/lib/terminal-colors";

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

        expect(lines.map((line) => line.kind)).toEqual([
            "prompt",
            "success",
            "warning",
            "error",
            "diff-add",
            "diff-remove",
            "plain",
        ]);
    });
});
