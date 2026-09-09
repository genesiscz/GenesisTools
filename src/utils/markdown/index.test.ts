import { describe, expect, it } from "bun:test";
import { renderMarkdownToCli } from "@genesiscz/utils/markdown";

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
