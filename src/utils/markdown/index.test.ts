import { describe, expect, it } from "bun:test";
import { effectiveLineWidth, renderMarkdownToCli } from "@genesiscz/utils/markdown";

/**
 * Runs `fn` with `process.stdout.columns` set to `columns`, then puts back exactly what was there:
 * the original own property, or no own property at all. A piped stdout often has no own `columns`,
 * and assigning the old value back to a property `defineProperty` created read-only would throw.
 */
function withStdoutColumns(columns: number | undefined, fn: () => void): void {
    const original = Object.getOwnPropertyDescriptor(process.stdout, "columns");
    Object.defineProperty(process.stdout, "columns", { value: columns, configurable: true, writable: true });

    try {
        fn();
    } finally {
        if (original) {
            Object.defineProperty(process.stdout, "columns", original);
        } else {
            Reflect.deleteProperty(process.stdout, "columns");
        }
    }
}

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

    // Regression test: #452 — cli-html's own default width is `Math.min(120, terminalSize()
    // .columns - 2)`. A pseudo-terminal that reports 0 columns (script, some CI runners,
    // editors' embedded terminals) made that go negative, which wrapped every single word
    // onto its own line. `effectiveLineWidth` is the value this module now hands cli-html
    // instead of letting it compute its own.
    it("treats a terminal width of 0 as 80 columns instead of going negative", () => {
        withStdoutColumns(0, () => {
            expect(effectiveLineWidth(undefined)).toBe(80);
        });
    });

    it("treats an undefined terminal width as 80 columns", () => {
        // `columns` is typed as always present; piped/non-TTY stdout reports it as
        // `undefined` at runtime regardless, which is the case being reproduced here.
        withStdoutColumns(undefined, () => {
            expect(effectiveLineWidth(undefined)).toBe(80);
        });
    });

    it("an explicit width always wins over the terminal width", () => {
        withStdoutColumns(0, () => {
            expect(effectiveLineWidth(40)).toBe(40);
        });
    });

    it("keeps cli-html's two-column margin on a normal terminal", () => {
        withStdoutColumns(100, () => {
            expect(effectiveLineWidth(undefined)).toBe(98);
        });
    });

    it("keeps cli-html's 120-column cap on a wide terminal", () => {
        withStdoutColumns(200, () => {
            expect(effectiveLineWidth(undefined)).toBe(120);
        });
    });
});
