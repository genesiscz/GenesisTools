import { describe, expect, test } from "bun:test";
import { resolveShowFormat } from "./show";

describe("resolveShowFormat", () => {
    test("an unknown value is refused instead of cast into the union", () => {
        // `--format json` used to reach exportConversation as-is, so it rendered
        // plain text and, with --output-dir, wrote that text into a .md file.
        const resolved = resolveShowFormat({ raw: "json", outputDir: true });

        expect(resolved.status).toBe("missing-enum");

        if (resolved.status === "missing-enum") {
            expect(resolved.help).toContain('--format does not accept "json"');
            expect(resolved.help).toContain("Possible: text, markdown");
        }
    });

    test("the flag with no value asks for one", () => {
        const resolved = resolveShowFormat({ raw: true, outputDir: false });

        expect(resolved.status).toBe("missing-enum");

        if (resolved.status === "missing-enum") {
            expect(resolved.help).toContain("--format requires a value.");
        }
    });

    test("both possible values are accepted verbatim", () => {
        expect(resolveShowFormat({ raw: "text", outputDir: true })).toEqual({ status: "ok", format: "text" });
        expect(resolveShowFormat({ raw: "markdown", outputDir: false })).toEqual({
            status: "ok",
            format: "markdown",
        });
    });

    test("the default is markdown only when writing to a directory", () => {
        expect(resolveShowFormat({ raw: undefined, outputDir: true })).toEqual({ status: "ok", format: "markdown" });
        expect(resolveShowFormat({ raw: undefined, outputDir: false })).toEqual({ status: "ok", format: "text" });
    });
});
