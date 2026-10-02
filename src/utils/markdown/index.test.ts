import { afterAll, describe, expect, it } from "bun:test";
import { mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderMarkdownToCli } from "@genesiscz/utils/markdown";
import { codeLinksToTokens, collapseIncludes, linesToken, resolveIncludes } from "@genesiscz/utils/markdown/includes";

/**
 * Two markdown-it 15 / @mdit/plugin-alert 2 adaptations fail SILENTLY, which is
 * why they are pinned here rather than left to a typecheck:
 *
 *  - plugin-alert 2 renamed `openRender`/`closeRender`/`titleRender` to
 *    `openRenderer`/`closeRenderer`/`titleRenderer`. An unknown option is
 *    ignored and the plugin falls back to a plain blockquote, so the icon and
 *    the palette colour just disappear.
 *  - markdown-it 15 lets `attrGet` return a number, so the alignment probe has
 *    to stringify before `includes()`. A non-string simply reports "no
 *    alignment" and every column quietly renders left-aligned.
 */

describe("renderMarkdownToCli", () => {
    it("renders GitHub alerts through the custom renderers, icon and title included", () => {
        const out = renderMarkdownToCli("> [!WARNING]\n> careful now\n", { width: 40, color: false });

        expect(out).toContain("⚠️ Warning");
        expect(out).toContain("careful now");
    });

    it("gives each alert kind its own icon", () => {
        const note = renderMarkdownToCli("> [!NOTE]\n> take note\n", { width: 40, color: false });
        const tip = renderMarkdownToCli("> [!TIP]\n> a tip\n", { width: 40, color: false });

        expect(note).toContain("ℹ️ Note");
        expect(tip).toContain("💡 Tip");
    });

    it("keeps the alert body under its own title", () => {
        const out = renderMarkdownToCli("> [!CAUTION]\n> stop\n", { width: 40, color: false });

        expect(out).toContain("🔴 Caution");
        expect(out.indexOf("🔴 Caution")).toBeLessThan(out.indexOf("stop"));
    });

    it("right-aligns a column the table header marks as right-aligned", () => {
        const aligned = renderMarkdownToCli("| head | num |\n|:-----|----:|\n| a | 7 |\n", {
            width: 40,
            color: false,
        });
        const unaligned = renderMarkdownToCli("| head | num |\n|------|-----|\n| a | 7 |\n", {
            width: 40,
            color: false,
        });

        expect(aligned).toContain("│   7 │");
        expect(unaligned).toContain("│ 7   │");
    });

    it("centres a column the table header marks as centred", () => {
        const out = renderMarkdownToCli("| head | mid |\n|:-----|:---:|\n| a | 7 |\n", { width: 40, color: false });

        expect(out).toContain("│  7  │");
    });
});

describe("markdown includes", () => {
    const dir = mkdtempSync(join(tmpdir(), "md-includes-"));
    const source = join(dir, "widget.ts");
    const fixed = () => new Date("2026-10-01T16:00:00Z");
    const later = () => new Date("2026-10-02T09:00:00Z");

    afterAll(() => {
        rmSync(dir, { recursive: true, force: true });
    });

    it("resolves a token into a marked block that collapses back to the token", async () => {
        writeFileSync(source, "const a = 1;\nconst b = 2;\nconst c = 3;\n");
        const text = `# Note\n\n{{lines path="widget.ts" range="2-3"}}\n\nAfter.\n`;
        const result = await resolveIncludes(text, { cwd: dir, now: fixed });

        expect(result.outcomes.map((o) => o.action)).toEqual(["added"]);
        expect(result.text).toContain("<!-- md:include sig=");
        expect(result.text).toContain("const b = 2;\nconst c = 3;");
        expect(result.text).not.toContain("const a = 1;");
        expect(collapseIncludes(result.text)).toBe(text);
    });

    it("a refresh with the same content leaves the file byte for byte, a changed file refreshes the block", async () => {
        writeFileSync(source, "const a = 1;\nconst b = 2;\nconst c = 3;\n");
        const first = await resolveIncludes(`{{lines path="widget.ts" range="2-3"}}\n`, { cwd: dir, now: fixed });
        const again = await resolveIncludes(first.text, { cwd: dir, now: later });

        expect(again.text).toBe(first.text);
        expect(again.outcomes.map((o) => o.action)).toEqual(["unchanged"]);

        writeFileSync(source, "const a = 1;\nconst b = 20;\nconst c = 3;\n");
        const changed = await resolveIncludes(first.text, { cwd: dir, now: later });

        expect(changed.outcomes.map((o) => o.action)).toEqual(["refreshed"]);
        expect(changed.text).toContain("const b = 20;");
        expect(collapseIncludes(changed.text)).toBe(collapseIncludes(first.text));
        expect((await resolveIncludes(first.text, { cwd: dir, refresh: false })).text).toBe(first.text);
    });

    it("a failing token stays as written, a failing refresh keeps the old block, an image token is skipped", async () => {
        writeFileSync(source, "const a = 1;\n");
        const missing = '{{lines path="gone.ts" range="1-2"}}';
        const failed = await resolveIncludes(`${missing}\n{{image path="x.png"}}\n`, { cwd: dir });

        expect(failed.text).toBe(`${missing}\n{{image path="x.png"}}\n`);
        expect(failed.outcomes.map((o) => o.action)).toEqual(["failed", "skipped"]);

        const block = (await resolveIncludes('{{lines path="widget.ts" range="1-1"}}\n', { cwd: dir })).text;
        renameSync(source, `${source}.moved`);

        try {
            const kept = await resolveIncludes(block, { cwd: dir });

            expect(kept.text).toBe(block);
            expect(kept.outcomes[0]?.action).toBe("failed");
        } finally {
            renameSync(`${source}.moved`, source);
        }
    });

    it("an include block written inside a fenced example stays text, and so does a token after it in the fence", async () => {
        writeFileSync(source, "const a = 1;\n");
        const block = (await resolveIncludes('{{lines path="widget.ts" range="1-1"}}\n', { cwd: dir, now: fixed }))
            .text;
        writeFileSync(source, "const a = 2;\n");
        const text = `Example:\n\n\`\`\`\`\n${block}{{lines path="widget.ts" range="1-1"}}\n\`\`\`\`\n`;
        const result = await resolveIncludes(text, { cwd: dir, now: later });

        expect(result.text).toBe(text);
        expect(result.outcomes).toEqual([]);
    });

    it("a marker line with an info string does not close a fence, so the block after the fence still refreshes", async () => {
        writeFileSync(source, "const a = 1;\n");
        const block = (await resolveIncludes('{{lines path="widget.ts" range="1-1"}}\n', { cwd: dir, now: fixed }))
            .text;
        writeFileSync(source, "const a = 2;\n");
        const fenced = "```md\nexample\n```js\n```\n";
        const result = await resolveIncludes(`${fenced}\nReal:\n\n${block}`, { cwd: dir, now: later });

        expect(result.outcomes.map((o) => o.action)).toEqual(["refreshed"]);
        expect(result.text.startsWith(fenced)).toBe(true);
        expect(result.text).toContain("const a = 2;");
    });

    it("an escaped token example stays escaped when a real token beside it resolves", async () => {
        writeFileSync(source, "const a = 1;\n");
        const text = 'Write \\{{lines path="x.ts"}} for an excerpt:\n\n{{lines path="widget.ts" range="1-1"}}\n';
        const result = await resolveIncludes(text, { cwd: dir, now: fixed });

        expect(result.outcomes.map((o) => o.action)).toEqual(["added"]);
        expect(result.text.startsWith('Write \\{{lines path="x.ts"}} for an excerpt:\n\n')).toBe(true);
        expect(collapseIncludes(result.text)).toBe(text);
    });

    it("an include block written inside an inline code span stays text", async () => {
        writeFileSync(source, "const a = 2;\n");
        const text =
            'Write `<!-- md:include sig=abc {{lines path="widget.ts" range="1-1"}} -->old<!-- /md:include -->` to keep it.\n';
        const result = await resolveIncludes(text, { cwd: dir, now: later });

        expect(result.text).toBe(text);
        expect(result.outcomes).toEqual([]);
    });

    it("a token inside a sentence gets its own paragraph and still collapses to the sentence", async () => {
        writeFileSync(source, "const a = 1;\nconst b = 2;\n");
        const text = 'See {{lines path="widget.ts" range="1-2"}} for the setup.\n';
        const result = await resolveIncludes(text, { cwd: dir });

        expect(result.text).toContain("See \n\n<!-- md:include sig=");
        expect(result.text).toContain(" inline {{lines");
        expect(collapseIncludes(result.text)).toBe(text);
    });

    it("adds a lines token under the paragraph of each link to source lines, once", () => {
        writeFileSync(source, "x\n".repeat(40));
        const text = [
            `**Loader.** [widget.ts:5](file://${source}#L5) and more`,
            "same paragraph",
            "",
            `[whole](file://${source})`,
            "",
            `\`[syntax](file://${source}#L12)\` is how a link is written`,
            "",
            "```",
            `[in code](file://${source}#L9)`,
            "```",
            `[range](file://${source}#L20-L24)`,
            "",
            `[pasted](file://${source}#L30)`,
            "",
            "```ts",
            "x",
            "```",
        ].join("\n");
        const result = codeLinksToTokens(text, { context: 4 });

        expect(result.inserted.map((i) => i.range)).toEqual(["5-8", "20-24"]);
        expect(result.text.split("\n").slice(0, 5)).toEqual([
            `**Loader.** [widget.ts:5](file://${source}#L5) and more`,
            "same paragraph",
            "",
            linesToken(source, "5-8"),
            "",
        ]);
        expect(result.skipped.map((s) => s.reason)).toEqual([
            "links to the whole file, not to lines",
            "a code block already follows the paragraph",
        ]);
        expect(codeLinksToTokens(result.text, { context: 4 }).inserted).toEqual([]);
    });
});
