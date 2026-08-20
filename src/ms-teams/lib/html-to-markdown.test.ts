import { describe, expect, test } from "bun:test";
import { teamsHtmlToMarkdown } from "./html-to-markdown";

const FLOW_SUMMARY_HTML = `<p>A tady ještě summary </p>
<p> </p>
<h2>Flow Summary</h2>
<p>Tým procházel Figmu a DZ pro nový marketplace v Můj ČEZ kvůli nacenění do zítřka; shodli se, že podklady jsou nedostatečné (nehotová Figma, chybí Figma pro administraci, OPN mimo tým) a přesné nacenění odmítnou, nabídnou jen statickou variantu a otázky.</p>
<p> </p>
<h3>Architektura marketplace stránek</h3>
<ul>
<li>Bannery a landing pages produktů řídí online platforma (clever chest), layout kategorií přes číselníky s admin UI</li><li>L1 = hierarchie (chybí field pro chip a online bonus), L2 = detail kategorie, L3 = landing page produktu</li><li>Marketing banner na dashboardu i marketplace bude sdílet stejné DTO (MarketingBannerDto[], 0-N)</li></ul>
<p> </p>
<h3>Problémy s podklady a rozsahem</h3>
<ul>
<li>Figma není hotová, David potvrdil že se ještě překopává; chybí Figma pro administraci úplně</li><li>OPN (elektřina, plyn) je jiný tým/repo, MVNO je vlastní modul; nutno vyloučit ze scope nebo předat spec</li><li>Generování leadů je horror story, vyžaduje sladění s byznysem</li><li> 
<ul>
<li>15 FRQ, hrubý odhad ~150 MD + ~40 MD admin, reálně bude byznys admin škrtat</li></ul>
</li></ul>
<p> </p>
<h3>Postup pro nacenění</h3>
<ul>
<li>Odmítnout přesné nacenění do zítřka, dodat jen otázky a pushback (nehotová Figma, chybí admin Figma)</li></ul>
<p> </p>
<h3>Next Steps</h3>
<ul>
<li>(Filip Kalina) Předat Šárce pushback: bez hotové Figmy nenacenit, nabídnout statickou variantu</li></ul>
<p> </p>
<h3>Decisions Made</h3>
<ul>
<li>Do zítřka se nedodá přesné nacenění, jen otázky a pushback</li><li>Marketing banner sdílí stejné DTO jako dashboard (MarketingBannerDto[], 0-N)</li></ul>
<p> </p>
<p> </p>`;

describe("teamsHtmlToMarkdown", () => {
    test("keeps headings, lists, nested indent, and unescaped brackets from a real Teams body", () => {
        const md = teamsHtmlToMarkdown(FLOW_SUMMARY_HTML);

        expect(md.startsWith("A tady ještě summary")).toBe(true);
        expect(md).toContain("## Flow Summary");
        expect(md).toContain("### Architektura marketplace stránek");
        expect(md).toContain(
            "- Bannery a landing pages produktů řídí online platforma (clever chest), layout kategorií přes číselníky s admin UI"
        );
        expect(md).toContain(
            "- L1 = hierarchie (chybí field pro chip a online bonus), L2 = detail kategorie, L3 = landing page produktu"
        );
        expect(md).toContain("MarketingBannerDto[], 0-N");
        expect(md.includes("MarketingBannerDto\\[]")).toBe(false);
        expect(md).toContain("### Problémy s podklady a rozsahem");
        expect(md).toContain("- Generování leadů je horror story, vyžaduje sladění s byznysem");
        expect(md).toContain("    - 15 FRQ, hrubý odhad ~150 MD + ~40 MD admin, reálně bude byznys admin škrtat");
        expect(md).toContain("### Postup pro nacenění");
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
            "<table><tbody><tr><td>14683911</td><td>Vendula</td></tr></tbody></table>",
            '<pre class="language-plaintext"><code>yarn codemod</code></pre>',
        ].join("");
        const md = teamsHtmlToMarkdown(html);
        expect(md).toContain("**Ahoj**");
        expect(md).toContain("`bun lint`");
        expect(md).toContain("[click](https://example.test/x)");
        expect(md).toContain("1. one");
        expect(md).toContain("2. two");
        expect(md).toContain("| 14683911 | Vendula |");
        expect(md).toContain("```");
        expect(md).toContain("yarn codemod");
    });
});
