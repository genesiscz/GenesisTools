import { describe, expect, test } from "bun:test";
import { dedent, md2json } from "./md2json";

describe("md2json", () => {
    test("headings become sections; fields carry bullets, a following fence, or plain lines", () => {
        const doc = md2json(
            [
                "intro line",
                "# One",
                "- Key: value",
                "  continued",
                "- List:",
                "  - a",
                "  - b",
                "- Text:",
                "",
                "```ts",
                "const a = 1;",
                "```",
                "- Plain:",
                "first line",
                "second line",
                "## Two",
                "- Note: not a field? it is",
                "free text",
            ].join("\n")
        );
        const [one, two] = doc.sections;

        expect(doc.preamble.text).toBe("intro line");
        expect(one).toMatchObject({ level: 1, title: "One", line: 2 });
        expect(one.fields.map((f) => [f.key, f.value])).toEqual([
            ["Key", "value continued"],
            ["List", ""],
            ["Text", ""],
            ["Plain", ""],
        ]);
        expect(one.fields[1].bullets).toEqual(["a", "b"]);
        expect(one.fields[2].fence).toEqual({ info: "ts", body: "const a = 1;", line: 10, closed: true });
        expect(one.fields[3].paragraphs).toEqual(["first line", "second line"]);
        expect(two.body).toBe("- Note: not a field? it is\nfree text");
        expect(doc.warnings).toEqual([]);
    });

    test("a missing closing fence is reported, whether it runs to the end or swallows a later heading", () => {
        expect(md2json("# A\n- T:\n```\nopen").warnings[0]).toMatchObject({ unclosedFence: true });
        expect(md2json("# A\n- T:\n```\nopen").warnings[0]?.message).toContain("never closed");
        expect(md2json("# A\n- T:\n```\ntext\n# B\n- U:\n```\n").warnings[0]).toEqual({
            line: 3,
            message: 'the fence opened here holds the heading "# B" (line 5); its closing fence is probably missing',
            fencedHeading: "B",
        });
    });

    test("dedent removes only the common indentation", () => {
        expect(dedent("   a\n     b\n\n   c")).toBe("a\n  b\n\nc");
    });
});
