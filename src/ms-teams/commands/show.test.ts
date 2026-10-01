import { describe, expect, it } from "bun:test";
import { countExportedMessages, shrinkRefusal } from "@app/ms-teams/commands/show";
import { SafeJSON } from "@genesiscz/utils/json";

function mdExport(headerLine: string, headings: number): string {
    const blocks = Array.from(
        { length: headings },
        (_, i) => `## 1. 9. 2026, 10:${String(i % 60).padStart(2, "0")} · Ada\n\ntext ${i}`
    );
    return `# Planning\n\n${headerLine}\n\n${blocks.join("\n\n")}\n`;
}

describe("show --out shrink guard", () => {
    it("refuses a hand-merged markdown file whose header has no message count", () => {
        const existing = mdExport("chat · 224 blocks · merged export 2026-06-01 09:00 → 2026-06-30 17:00 (local)", 224);
        const incoming = mdExport("chat · 201 messages · cached a → b", 163);

        expect(shrinkRefusal(existing, incoming)).toContain("224");
    });

    it("counts message headings, not the header number, when a markdown file has headings", () => {
        expect(countExportedMessages(mdExport("chat · 201 messages · cached a → b", 163))).toBe(163);
    });

    it("falls back to the header count for a markdown file without headings", () => {
        expect(countExportedMessages("# Ada\n\nchat · 229 messages · cached a → b\n")).toBe(229);
    });

    it("allows an export that keeps or grows the message count", () => {
        const existing = mdExport("chat · 10 messages · cached a → b", 10);

        expect(shrinkRefusal(existing, mdExport("chat · 12 messages · cached a → b", 12))).toBeNull();
        expect(shrinkRefusal(existing, existing)).toBeNull();
    });

    it("compares JSON exports by their messages array", () => {
        const json = (n: number) =>
            SafeJSON.stringify({
                conversation: { messageCount: n },
                messages: Array.from({ length: n }, (_, index) => ({ id: index })),
            });

        expect(countExportedMessages(json(7))).toBe(7);
        expect(shrinkRefusal(json(7), json(5))).toContain("7");
        expect(shrinkRefusal(json(5), json(7))).toBeNull();
    });

    it("compares HTML exports by their message articles", () => {
        const html = (n: number) => `<main>${'<article class="msg"><header>x</header></article>'.repeat(n)}</main>`;

        expect(countExportedMessages(html(3))).toBe(3);
        expect(shrinkRefusal(html(3), html(2))).toContain("3");
    });

    it("refuses to overwrite a non-empty file it cannot count", () => {
        expect(shrinkRefusal("some unrelated notes\n", mdExport("chat · 1 messages · cached a → b", 1))).toContain(
            "cannot tell"
        );
        expect(shrinkRefusal("   \n", mdExport("chat · 1 messages · cached a → b", 1))).toBeNull();
    });
});
