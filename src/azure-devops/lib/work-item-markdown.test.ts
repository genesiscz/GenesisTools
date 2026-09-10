import { describe, expect, test } from "bun:test";
import { formatWorkItemMarkdown } from "@app/azure-devops/lib/work-item-markdown";
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
});
