import { describe, expect, test } from "bun:test";
import {
    type AdoFieldManifest,
    buildFieldManifest,
    diffManifests,
    findField,
    findFields,
    parseManifestFile,
    renderManifestJson,
    renderManifestTs,
} from "@app/azure-devops/lib/field-manifest";

const MERGED = "Custom.0f1e2d3c-aaaa-bbbb-cccc-000000000001";
const OWNER = "Custom.0f1e2d3c-aaaa-bbbb-cccc-000000000002";

function fixture(): AdoFieldManifest {
    return buildFieldManifest({
        meta: {
            org: "https://dev.azure.com/example",
            project: "Sample",
            process: "Agile",
            fetchedAt: "2026-01-02 03:04",
            regenerate: "tools azure-devops maintenance get-fields --into fields.ts",
        },
        catalog: [
            { referenceName: MERGED, type: "string" },
            { referenceName: OWNER, type: "identity", isIdentity: true },
            { referenceName: "System.Title", type: "string" },
        ],
        types: [
            {
                name: "Task",
                fields: [
                    { referenceName: "System.Title", name: "Title", alwaysRequired: true },
                    { referenceName: MERGED, name: "Merge done", allowedValues: ["Yes", "N/A"] },
                ],
                states: [
                    { name: "New", category: "Proposed" },
                    { name: "Done", category: "Completed" },
                ],
            },
            {
                name: "Bug",
                fields: [
                    { referenceName: OWNER, name: "Requested by" },
                    { referenceName: MERGED, name: "Merge done", allowedValues: ["Yes", "N/A"] },
                ],
                states: [{ name: "New", category: "Proposed" }],
            },
        ],
    });
}

describe("field manifest", () => {
    test("sorts types and fields and takes the data type from the catalog", () => {
        const manifest = fixture();

        expect(Object.keys(manifest.types)).toEqual(["Bug", "Task"]);
        expect(Object.keys(manifest.types.Task.fields)).toEqual([MERGED, "System.Title"]);
        expect(manifest.types.Bug.fields[OWNER]).toEqual({
            name: "Requested by",
            type: "identity",
            isIdentity: true,
            alwaysRequired: false,
            allowedValues: [],
        });
    });

    test("a written .ts or .json file reads back as the same manifest", () => {
        const manifest = fixture();
        const ts = renderManifestTs(manifest);

        expect(ts).toContain("Generated, do not edit");
        expect(ts).toContain("export const AdoFields = {");
        expect(parseManifestFile(renderManifestTs(manifest, "SampleAdoFields"), "named.ts")).toEqual(manifest);
        expect(() => renderManifestTs(manifest, "not-an-identifier")).toThrow("not a TypeScript identifier");
        expect(parseManifestFile(ts, "fields.ts")).toEqual(manifest);
        expect(parseManifestFile(renderManifestJson(manifest), "fields.json")).toEqual(manifest);
        expect(() => parseManifestFile("export const OTHER = 1;", "other.ts")).toThrow("no");
    });

    test("the check reports renamed labels, changed values and states, added fields, and ignores the meta", () => {
        const saved = fixture();
        const live = fixture();
        live.meta.fetchedAt = "2026-02-03 04:05";
        live.types.Task.fields[MERGED].name = "Merge really done";
        live.types.Bug.fields[MERGED].allowedValues = ["Yes", "No", "N/A"];
        live.types.Bug.states.push({ name: "Closed", category: "Completed" });
        live.types.Bug.fields["System.Title"] = { ...live.types.Task.fields["System.Title"] };

        expect(diffManifests(saved, saved)).toEqual([]);
        expect(diffManifests(saved, live)).toEqual([
            "Bug: states [New/Proposed] -> [New/Proposed, Closed/Completed]",
            `Bug: field ${MERGED} values [Yes, N/A] -> [Yes, No, N/A]`,
            'Bug: field System.Title "Title" added',
            `Task: field ${MERGED} label "Merge done" -> "Merge really done"`,
        ]);
    });

    test("findField finds a field by label or value across types and refuses an ambiguous query", () => {
        const manifest = fixture();

        expect(findField(manifest, { label: /merge/i })).toMatchObject({
            referenceName: MERGED,
            allowedValues: ["Yes", "N/A"],
            types: ["Bug", "Task"],
        });
        expect(findField(manifest, { type: "bug", label: "requested BY" })?.referenceName).toBe(OWNER);
        expect(findFields(manifest, { value: "n/a" }).map((match) => match.referenceName)).toEqual([MERGED]);
        expect(findField(manifest, { label: "Missing" })).toBeUndefined();
        expect(() => findField(manifest, { type: "Task" })).toThrow("matches 2 fields");
    });
});
