import { describe, expect, test } from "bun:test";
import { teamsHtmlToMarkdown } from "./html-to-markdown";

const FLOW_SUMMARY_HTML = `<p>A tady ještě summary </p>
<p> </p>
<h2>Flow Summary</h2>
<p>Tým procházel podklady pro nový katalog a shodl se, že zadání je zatím neúplné.</p>
<p> </p>
<h3>Architektura katalogových stránek</h3>
<ul>
<li>Bannery a vstupní stránky položek řídí externí služba, rozvržení sekcí přes číselníky s admin UI</li><li>L1 = hierarchie, L2 = detail sekce, L3 = vstupní stránka položky</li><li>Banner sdílí stejné DTO jako přehled (MarketingBannerDto[], 0-N)</li></ul>
<p> </p>
<h3>Problémy s podklady a rozsahem</h3>
<ul>
<li>Sběr požadavků je náročný a vyžaduje sladění se zadavatelem
<ul>
<li>15 požadavků, hrubý odhad ~150 MD + ~40 MD admin</li></ul>
</li></ul>
<p> </p>
<h3>Postup pro odhad</h3>
<ul>
<li>Dodat zatím jen otázky a připomínky, ne přesné číslo</li></ul>
<p> </p>
<h3>Next Steps</h3>
<ul>
<li>Předat zadavateli připomínky a nabídnout zjednodušenou variantu</li></ul>
<p> </p>
<h3>Decisions Made</h3>
<ul>
<li>Do zítřka se dodají jen otázky</li></ul>
<p> </p>
<p> </p>`;

describe("teamsHtmlToMarkdown", () => {
    test("keeps headings, lists, nested indent, and unescaped brackets from a Teams body", () => {
        const md = teamsHtmlToMarkdown(FLOW_SUMMARY_HTML);

        expect(md.startsWith("A tady ještě summary")).toBe(true);
        expect(md).toContain("## Flow Summary");
        expect(md).toContain("### Architektura katalogových stránek");
        expect(md).toContain(
            "- Bannery a vstupní stránky položek řídí externí služba, rozvržení sekcí přes číselníky s admin UI"
        );
        expect(md).toContain("- L1 = hierarchie, L2 = detail sekce, L3 = vstupní stránka položky");
        expect(md).toContain("MarketingBannerDto[], 0-N");
        expect(md.includes("MarketingBannerDto\\[]")).toBe(false);
        expect(md).toContain("### Problémy s podklady a rozsahem");
        expect(md).toContain("- Sběr požadavků je náročný a vyžaduje sladění se zadavatelem");
        expect(md).toContain("    - 15 požadavků, hrubý odhad ~150 MD + ~40 MD admin");
        expect(md).toContain("### Postup pro odhad");
        expect(md).toContain("### Next Steps");
        expect(md).toContain("### Decisions Made");
        expect(md.includes(" Flow Summary ")).toBe(false);
    });

    test("drops skype Reply quotes and keeps the reply body", () => {
        const html =
            '<blockquote itemscope itemtype="http://schema.skype.com/Reply" itemid="m-parent"><p>parent</p></blockquote><p>child reply</p>';
        expect(teamsHtmlToMarkdown(html)).toBe("child reply");
    });

    test("drops a Reply quote whole, including a nested quote inside it", () => {
        // A reply to a reply. The first </blockquote> closes the INNER quote,
        // so a lazy match stopped there and left everything after it — the
        // outer quote's own text — in the export.
        const html =
            '<blockquote itemscope itemtype="http://schema.skype.com/Reply" itemid="m-parent">' +
            '<blockquote itemtype="http://schema.skype.com/Reply"><p>inner parent</p></blockquote>' +
            "<p>outer parent</p></blockquote><p>child reply</p>";
        const md = teamsHtmlToMarkdown(html);

        expect(md).not.toContain("outer parent");
        expect(md).not.toContain("inner parent");
        expect(md).toBe("child reply");
    });

    test("keeps forwarded quotes as markdown blockquotes", () => {
        const html =
            '<blockquote itemtype="http://schema.skype.com/Forward"><p>Hoj, na develop je aktualne nasazena migrace.</p></blockquote>';
        const md = teamsHtmlToMarkdown(html);
        expect(md).toContain("Hoj, na develop je aktualne nasazena migrace.");
        expect(md.startsWith(">")).toBe(true);
    });

    test("turns emoji images into their alt text and leaves mentions as names", () => {
        const html =
            '<p>hello <span itemtype="http://schema.skype.com/Mention" itemscope itemid="0">Všichni</span> <img itemscope itemtype="http://schema.skype.com/Emoji" alt="😄" /></p>';
        expect(teamsHtmlToMarkdown(html)).toBe("hello Všichni 😄");
    });

    test("inlines a local AMS image and drops unresolved AMS urls", () => {
        const objectId = "0-weu-d1-0123456789abcdef01234567";
        const url = `https://eu-api.asm.skype.com/v1/objects/${objectId}/views/imgo`;
        const localPath = `/tmp/${objectId}.png`;
        const html = `<p>see</p><p><img src="${url}" itemtype="http://schema.skype.com/AMSImage" itemid="${objectId}" alt="image" /></p>`;
        const inlined = teamsHtmlToMarkdown(html, [
            {
                name: `${objectId}.png`,
                mimeHint: "png",
                url,
                itemId: objectId,
                localPath,
            },
        ]);
        expect(inlined).toContain(`![${objectId}.png](${localPath})`);
        expect(inlined.includes("eu-api.asm.skype.com")).toBe(false);

        const dropped = teamsHtmlToMarkdown(html);
        expect(dropped).toBe("see");
        expect(dropped.includes("eu-api.asm.skype.com")).toBe(false);
    });

    test("keeps markdown characters that were typed as plain Teams paragraphs", () => {
        const html =
            "<p># 01-01_01 - Úprava sekce Nabídky Web</p><p>## 1) Banner<br />- Textové sdělení<br />  - nested</p>";
        const md = teamsHtmlToMarkdown(html);
        expect(md).toContain("# 01-01_01 - Úprava sekce Nabídky Web");
        expect(md).toContain("## 1) Banner");
        expect(md).toContain("- Textové sdělení");
        expect(md.includes("\\#")).toBe(false);
        expect(md.includes("\\_")).toBe(false);
        expect(md.includes("\\-")).toBe(false);
    });

    test("keeps emphasis, inline code, links, numbered lists and tables", () => {
        const html = [
            "<p><strong>Ahoj</strong> a <em>em</em> a <code>bun lint</code></p>",
            '<p><a href="https://example.test/x" itemtype="http://schema.skype.com/HyperLink">click</a></p>',
            "<ol><li>one</li><li>two</li></ol>",
            "<table><tbody><tr><td>14683911</td><td>Jana</td></tr></tbody></table>",
            '<pre class="language-plaintext"><code>yarn codemod</code></pre>',
        ].join("");
        const md = teamsHtmlToMarkdown(html);
        expect(md).toContain("**Ahoj**");
        expect(md).toContain("`bun lint`");
        expect(md).toContain("[click](https://example.test/x)");
        expect(md).toContain("1. one");
        expect(md).toContain("2. two");
        expect(md).toContain("| 14683911 | Jana |");
        expect(md).toContain("```");
        expect(md).toContain("yarn codemod");
    });
});
