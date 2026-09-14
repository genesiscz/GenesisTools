import { describe, expect, test } from "bun:test";
import { parseRelations } from "@app/azure-devops/relations";
import type { Relation } from "@app/azure-devops/types";

function link(rel: string, id: number): Relation {
    return { rel, url: `https://example.invalid/_apis/wit/workItems/${id}` };
}

describe("parseRelations", () => {
    test("reads the parent, the children and the related items off one relation list", () => {
        const parsed = parseRelations([
            link("System.LinkTypes.Hierarchy-Reverse", 910001),
            link("System.LinkTypes.Hierarchy-Forward", 920001),
            link("System.LinkTypes.Hierarchy-Forward", 920002),
            link("System.LinkTypes.Related", 930001),
        ]);

        expect(parsed.parent).toBe(910001);
        expect(parsed.children).toEqual([920001, 920002]);
        expect(parsed.related).toEqual([930001]);
    });

    test("counts every non-hierarchy work-item link as related, not only the ones named Related", () => {
        // This is what the collapsed branch has to keep doing: `Duplicate` and `Dependency` carry
        // no "Related" in their name and still belong in the related list `tree` prints.
        const parsed = parseRelations([
            link("System.LinkTypes.Duplicate-Forward", 940001),
            link("System.LinkTypes.Dependency-Reverse", 940002),
            link("System.LinkTypes.Related", 940003),
        ]);

        expect(parsed.related).toEqual([940001, 940002, 940003]);
        expect(parsed.parent).toBeUndefined();
        expect(parsed.children).toEqual([]);
    });

    test("ignores a link that names no work item, and does not report an attachment as unknown", () => {
        const parsed = parseRelations([
            { rel: "AttachedFile", url: "https://example.invalid/_apis/wit/attachments/abc" },
            { rel: "ArtifactLink", url: "vstfs:///Git/Commit/abc" },
        ]);

        expect(parsed.related).toEqual([]);
        expect(parsed.children).toEqual([]);
        expect(parsed.other).toEqual(["ArtifactLink"]);
    });

    test("keeps the last parent when a relation list names more than one", () => {
        const parsed = parseRelations([
            link("System.LinkTypes.Hierarchy-Reverse", 950001),
            link("System.LinkTypes.Hierarchy-Reverse", 950002),
        ]);

        expect(parsed.parent).toBe(950002);
    });
});
