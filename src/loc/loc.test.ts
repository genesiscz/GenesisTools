import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildReport, type FileResult } from "./lib/aggregate";
import { classifyFile } from "./lib/classify";
import { commentSyntaxForExt, resolveLanguage } from "./lib/languages";
import { renderTable } from "./lib/render";
import { scanDirectory } from "./lib/walk";

describe("resolveLanguage", () => {
    it("maps known extensions to language names", () => {
        expect(resolveLanguage("ts")).toBe("TypeScript");
        expect(resolveLanguage("tsx")).toBe("TypeScript");
        expect(resolveLanguage("py")).toBe("Python");
        expect(resolveLanguage("go")).toBe("Go");
        expect(resolveLanguage("sql")).toBe("SQL");
    });

    it("is case-insensitive and tolerates a leading dot", () => {
        expect(resolveLanguage(".TS")).toBe("TypeScript");
        expect(resolveLanguage("JSON")).toBe("JSON");
    });

    it("falls back to Other for unknown extensions", () => {
        expect(resolveLanguage("xyz")).toBe("Other");
        expect(resolveLanguage("")).toBe("Other");
    });
});

describe("commentSyntaxForExt", () => {
    it("returns slash line + slash-star block for C-likes", () => {
        const syntax = commentSyntaxForExt("ts");
        expect(syntax.line).toContain("//");
        expect(syntax.block).toEqual([{ open: "/*", close: "*/" }]);
    });

    it("returns hash line comments for Python and shell", () => {
        expect(commentSyntaxForExt("py").line).toEqual(["#"]);
        expect(commentSyntaxForExt("sh").line).toEqual(["#"]);
    });

    it("returns html block comments for markdown and html", () => {
        expect(commentSyntaxForExt("md").block).toEqual([{ open: "<!--", close: "-->" }]);
        expect(commentSyntaxForExt("html").block).toEqual([{ open: "<!--", close: "-->" }]);
    });

    it("returns no comment syntax for json", () => {
        const syntax = commentSyntaxForExt("json");
        expect(syntax.line).toEqual([]);
        expect(syntax.block).toEqual([]);
    });
});

describe("classifyFile", () => {
    it("counts blank, code and line comments for TypeScript", () => {
        const content = ["// a comment", "const x = 1;", "", "   ", "let y = 2; // trailing"].join("\n");
        expect(classifyFile({ content, ext: "ts" })).toEqual({ code: 2, comment: 1, blank: 2 });
    });

    it("handles block comments spanning multiple lines (C-like)", () => {
        const content = ["/* start", " * middle", " end */", "doThing();"].join("\n");
        expect(classifyFile({ content, ext: "ts" })).toEqual({ code: 1, comment: 3, blank: 0 });
    });

    it("treats code before a block-open and after a block-close as code", () => {
        const content = ["foo(); /* note", "still comment */ bar();"].join("\n");
        expect(classifyFile({ content, ext: "ts" })).toEqual({ code: 2, comment: 0, blank: 0 });
    });

    it("counts hash comments for Python", () => {
        const content = ["# header", "x = 1", "", "y = 2  # inline"].join("\n");
        expect(classifyFile({ content, ext: "py" })).toEqual({ code: 2, comment: 1, blank: 1 });
    });

    it("counts html block comments in markdown", () => {
        const content = ["# Title", "<!-- hidden -->", "text"].join("\n");
        expect(classifyFile({ content, ext: "md" })).toEqual({ code: 2, comment: 1, blank: 0 });
    });

    it("reports zero comments for json", () => {
        const content = ['{ "a": 1 }', "", '{ "b": 2 }'].join("\n");
        expect(classifyFile({ content, ext: "json" })).toEqual({ code: 2, comment: 0, blank: 1 });
    });

    it("counts an empty file as zero lines", () => {
        expect(classifyFile({ content: "", ext: "ts" })).toEqual({ code: 0, comment: 0, blank: 0 });
    });
});

const sample: FileResult[] = [
    { ext: "ts", language: "TypeScript", counts: { code: 100, comment: 10, blank: 5 } },
    { ext: "ts", language: "TypeScript", counts: { code: 50, comment: 5, blank: 2 } },
    { ext: "py", language: "Python", counts: { code: 200, comment: 20, blank: 8 } },
    { ext: "json", language: "JSON", counts: { code: 30, comment: 0, blank: 0 } },
];

const fakeRoot = join(tmpdir(), "loc-fake-root");

describe("buildReport", () => {
    const now = new Date("2026-06-02T00:52:00.000Z");

    it("groups by language, sorts by code desc, and totals everything", () => {
        const report = buildReport({ root: fakeRoot, by: "lang", files: sample, now });

        expect(report.by).toBe("lang");
        expect(report.root).toBe(fakeRoot);
        expect(report.generatedAt).toBe("2026-06-02T00:52:00.000Z");
        expect(report.rows.map((r) => r.name)).toEqual(["Python", "TypeScript", "JSON"]);
        expect(report.rows[1]).toEqual({ name: "TypeScript", files: 2, lines: 172, code: 150, comment: 15, blank: 7 });
        expect(report.total).toEqual({ files: 4, lines: 430, code: 380, comment: 35, blank: 15 });
    });

    it("groups by ext when by=ext", () => {
        const report = buildReport({ root: fakeRoot, by: "ext", files: sample, now });
        expect(report.rows.map((r) => r.name)).toEqual(["py", "ts", "json"]);
    });

    it("truncates rows with top but keeps the full total", () => {
        const report = buildReport({ root: fakeRoot, by: "lang", files: sample, now, top: 1 });
        expect(report.rows.map((r) => r.name)).toEqual(["Python"]);
        expect(report.total.code).toBe(380);
    });

    it("returns an empty report for no files", () => {
        const report = buildReport({ root: fakeRoot, by: "lang", files: [], now });
        expect(report.rows).toEqual([]);
        expect(report.total).toEqual({ files: 0, lines: 0, code: 0, comment: 0, blank: 0 });
    });
});

describe("renderTable", () => {
    const now = new Date("2026-06-02T00:52:00.000Z");

    it("renders a header, data rows, and a Total row", () => {
        const report = buildReport({ root: fakeRoot, by: "lang", files: sample, now });
        const text = renderTable(report);
        expect(text).toContain("Language");
        expect(text).toContain("Python");
        expect(text).toContain("Total");
        expect(text).toContain("430");
    });

    it("labels the name column Ext when grouping by ext", () => {
        const report = buildReport({ root: fakeRoot, by: "ext", files: sample, now });
        const text = renderTable(report);
        expect(text).toContain("Ext");
    });
});

describe("scanDirectory", () => {
    function makeRepo(): string {
        const root = mkdtempSync(join(tmpdir(), "loc-test-"));
        writeFileSync(join(root, "a.ts"), "const x = 1;\n// note\n\n");
        writeFileSync(join(root, "b.py"), "x = 1\n# c\n");
        writeFileSync(join(root, ".gitignore"), "ignored.ts\nbuild/\n");
        writeFileSync(join(root, "ignored.ts"), "const skip = 1;\n");
        mkdirSync(join(root, "build"));
        writeFileSync(join(root, "build", "out.js"), "console.log(1);\n");
        mkdirSync(join(root, "node_modules"));
        writeFileSync(join(root, "node_modules", "dep.js"), "module.exports = {};\n");
        mkdirSync(join(root, "nested"));
        writeFileSync(join(root, "nested", "c.ts"), "export const y = 2;\n");
        return root;
    }

    it("honours .gitignore and always skips node_modules", async () => {
        const root = makeRepo();
        const results = await scanDirectory({ root, gitignore: true, includeHidden: false });
        const exts = results.map((r) => r.ext).sort();
        expect(exts).toEqual(["py", "ts", "ts"]);

        const ts = results.find((r) => r.language === "TypeScript" && r.counts.comment === 1);
        expect(ts?.counts).toEqual({ code: 1, comment: 1, blank: 1 });
    });

    it("includes gitignored files when gitignore is disabled but still skips node_modules", async () => {
        const root = makeRepo();
        const results = await scanDirectory({ root, gitignore: false, includeHidden: false });
        const names = results.map((r) => r.ext).sort();
        expect(names).toEqual(["js", "py", "ts", "ts", "ts"]);
    });
});
