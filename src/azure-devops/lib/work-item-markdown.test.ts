import { describe, expect, test } from "bun:test";
import { Api } from "@app/azure-devops/api";
import { extractInlineImageUrls, rewriteImageSources, rewriteMarkdownImageUrls } from "@app/azure-devops/inline-images";
import { formatWorkItemMarkdown, tableCell } from "@app/azure-devops/lib/work-item-markdown";
import type { WorkItemFull } from "@app/azure-devops/types";

// Regression test: tools azure-devops wi -f md — stdout dumped raw ADO HTML instead of markdown

const ADO_DESCRIPTION_HTML =
    "<h3>1) Popis chyby </h3> <p><span>Please fix the signup flow.</span> </p> <br> " +
    '<h3>2) Popis správného chování </h3> <p><span style="box-sizing:border-box;">There should be an active contract.&nbsp;<br style="box-sizing:border-box;"></span></p> <br> ' +
    "<h3>3) Postup navození chyby </h3> <ul> <li>Open the customer card</li> <li>Activate the inactive service</li> </ul> <br> " +
    '<h3>4) Přidání logů / videí / obrázků </h3> <p><img src="https://dev.azure.com/example/proj/_apis/wit/attachments/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee?fileName=image.png" alt=Image style="width:401px;height:312px;" width=401 height=312> </p>';

function item(overrides: Partial<WorkItemFull> = {}): WorkItemFull {
    return {
        id: 281785,
        rev: 1,
        title: "Service signup error",
        state: "Active",
        changed: "2026-09-01T10:00:00Z",
        url: "https://dev.azure.com/example/proj/_workitems/edit/281785",
        comments: [],
        description: ADO_DESCRIPTION_HTML,
        ...overrides,
    };
}

describe("formatWorkItemMarkdown", () => {
    test("converts an ADO HTML description instead of dumping the tags", () => {
        const md = formatWorkItemMarkdown(item());

        expect(md).toContain("### 1) Popis chyby");
        expect(md).toContain("Please fix the signup flow.");
        expect(md).toContain("### 3) Postup navození chyby");
        expect(md).toContain("Open the customer card");
        expect(md).toContain(
            "![Image](https://dev.azure.com/example/proj/_apis/wit/attachments/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee?fileName=image.png)"
        );
        expect(md).not.toContain("<h3>");
        expect(md).not.toContain("<ul>");
        expect(md).not.toContain("<img");
    });

    test("converts HTML comments instead of dumping the tags", () => {
        const md = formatWorkItemMarkdown(
            item({
                comments: [
                    {
                        id: 1,
                        author: "Alice Example",
                        date: "2026-09-01T10:00:00Z",
                        text: "<p><b>repro</b> confirmed</p>",
                    },
                ],
            })
        );

        expect(md).toContain("**repro** confirmed");
        expect(md).not.toContain("<p>");
        expect(md).not.toContain("<b>");
    });

    test("a markdown comment keeps its lines and its image, pointed at the downloaded file", () => {
        const url =
            "https://dev.azure.com/example/proj/_apis/wit/attachments/46e8a5cc-7c33-4aab-92ba-d91fe3446a5a?fileName=image.png";
        const text = `**Steps**\nopen the card\n![image.png](${url}) \n\n![second](${url} "title")`;
        const [image] = extractInlineImageUrls(text, 281785);
        expect(image?.attachmentId).toBe("46e8a5cc-7c33-4aab-92ba-d91fe3446a5a");
        expect(extractInlineImageUrls(text, 281785)).toHaveLength(1);

        const md = formatWorkItemMarkdown(
            item({
                comments: [{ id: 1, author: "Alice Example", date: "2026-09-01T10:00:00Z", text, format: "markdown" }],
            }),
            new Map([[url, image?.localFileName ?? ""]])
        );

        expect(md).toContain("**Steps**\nopen the card\n![image.png](281785-46e8a5cc-image.png)");
        expect(md).toContain('![second](281785-46e8a5cc-image.png "title")');
        expect(md).not.toContain("\\*\\*");
    });

    test("an angle-bracket destination keeps its parentheses, and a local name with a space stays one link", () => {
        const base = "https://dev.azure.com/example/proj/_apis/wit/attachments/46e8a5cc-7c33-4aab-92ba-d91fe3446a5a";
        const angled = `${base}?fileName=screen(1).png`;
        const spaced = `${base.replace("46e8a5cc", "57f9b6dd")}?fileName=screen%20shot.png`;
        const bare = `${base.replace("46e8a5cc", "68a0c7ee")}?fileName=shot(2).png`;
        const text = `![a](<${angled}>)\n![b](${spaced})\n![c](${bare})\n\n\`\`\`\n${angled}\n\`\`\``;
        const images = extractInlineImageUrls(text, 281785);

        expect(images.map((image) => image.originalUrl)).toEqual([angled, spaced, bare]);
        expect(images.map((image) => image.localFileName)).toEqual([
            "281785-46e8a5cc-screen(1).png",
            "281785-57f9b6dd-screen shot.png",
            "281785-68a0c7ee-shot(2).png",
        ]);

        const md = formatWorkItemMarkdown(
            item({
                comments: [{ id: 1, author: "Alice Example", date: "2026-09-01T10:00:00Z", text, format: "markdown" }],
            }),
            new Map(images.map((image) => [image.originalUrl, image.localFileName]))
        );

        expect(md).toContain(
            "![a](<281785-46e8a5cc-screen(1).png>)\n![b](<281785-57f9b6dd-screen shot.png>)\n![c](<281785-68a0c7ee-shot(2).png>)"
        );
        // The same URL quoted in a code example is not an image destination.
        expect(md).toContain(`\`\`\`\n${angled}\n\`\`\``);
    });
});

describe("rewriteImageSources", () => {
    test("the src attribute is the one matched, not a data-src beside it", () => {
        const url = "https://dev.azure.com/example/proj/_apis/wit/attachments/46e8a5cc?fileName=a.png";
        const other = "https://dev.azure.com/example/proj/_apis/wit/attachments/57f9b6dd?fileName=b.png";

        expect(rewriteImageSources(`<img src="${url}" data-src="${url}">`, new Map([[url, "local.png"]]))).toBe(
            `<img src="local.png" data-src="${url}">`
        );
        expect(extractInlineImageUrls(`<img src="${url}" data-src="${other}">`, 1).map((i) => i.originalUrl)).toEqual([
            url,
        ]);
    });

    test("an image written inside a code span or a fenced block is an example, not an image", () => {
        const base = "https://dev.azure.com/example/proj/_apis/wit/attachments";
        const example = `${base}/46e8a5cc?fileName=example.png`;
        const real = `${base}/57f9b6dd?fileName=real.png`;
        const text = `Write \`![e](${example})\` like this:\n\n\`\`\`md\n![e](${example})\n\`\`\`\n\n![r](${real})\n`;
        const map = new Map([
            [example, "local-example.png"],
            [real, "local-real.png"],
        ]);

        expect(extractInlineImageUrls(text, 1).map((i) => i.originalUrl)).toEqual([real]);
        expect(rewriteMarkdownImageUrls(text, map)).toBe(text.replace(`![r](${real})`, "![r](local-real.png)"));
    });

    test("only the src value changes, and the local name goes in literally", () => {
        const url = "https://dev.azure.com/example/proj/_apis/wit/attachments/46e8a5cc?fileName=a.png";
        const tag = `<img alt="${url}" src="${url}">`;

        expect(rewriteImageSources(tag, new Map([[url, "281785-46e8a5cc-$&.png"]]))).toBe(
            `<img alt="${url}" src="281785-46e8a5cc-$&.png">`
        );
    });
});

describe("Api.isOrganizationUrl", () => {
    test("only the configured organization gets the token, under either host form", () => {
        const org = "https://dev.azure.com/example";
        const attachment = "_apis/wit/attachments/46e8a5cc-7c33-4aab-92ba-d91fe3446a5a";

        expect(Api.isOrganizationUrl(`https://dev.azure.com/example/proj/${attachment}`, org)).toBe(true);
        expect(Api.isOrganizationUrl(`https://example.visualstudio.com/proj/${attachment}`, org)).toBe(true);
        expect(Api.isOrganizationUrl(`https://attacker.example/${attachment}`, org)).toBe(false);
        expect(Api.isOrganizationUrl(`https://dev.azure.com/other/proj/${attachment}`, org)).toBe(false);
        expect(Api.isOrganizationUrl(`http://dev.azure.com/example/proj/${attachment}`, org)).toBe(false);
    });
});

describe("tableCell", () => {
    test("a pipe or a line break in a field value cannot open a column or a row", () => {
        expect(tableCell("Backend | Frontend")).toBe("Backend \\| Frontend");
        expect(tableCell("line one\r\nline two\nline three")).toBe("line one line two line three");
    });

    test("the details table keeps one row per field for a tagged, multi-line assignee", () => {
        const md = formatWorkItemMarkdown(item({ assignee: "Jo | QA\nTeam", tags: "a; b|c" }));
        const rows = md.split("\n").filter((line) => line.startsWith("| "));

        expect(rows).toContain("| Assignee | Jo \\| QA Team |");
        expect(rows).toContain("| Tags | a; b\\|c |");
        expect(rows.every((row) => row.split(/(?<!\\)\|/).length === 4)).toBe(true);
    });
});
