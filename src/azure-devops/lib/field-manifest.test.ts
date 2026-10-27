import { describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Api } from "@app/azure-devops/api";
import { registerMaintenanceCommand } from "@app/azure-devops/commands/maintenance";
import { getExplicitConfigPath, setConfigFlag } from "@app/azure-devops/config";
import {
    diffManifestData,
    parseManifestText,
    renderManifestTs as renderAnyTs,
} from "@app/azure-devops/lib/ado-manifest";
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
import {
    buildWorkflow,
    flattenAreaPaths,
    kindOfManifest,
    manifestKind,
    renderGenericMd,
} from "@app/azure-devops/lib/manifest-kinds";
import { SafeJSON } from "@genesiscz/utils/json";
import { Command } from "commander";

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
        for (const name of ["not-an-identifier", "class", "default", "const", "await", "arguments"]) {
            expect(() => renderManifestTs(manifest, name)).toThrow("not a TypeScript identifier");
        }
        expect(parseManifestFile(ts, "fields.ts")).toEqual(manifest);
        expect(parseManifestFile(renderManifestJson(manifest), "fields.json")).toEqual(manifest);
        expect(() => parseManifestFile("export const OTHER = 1;", "other.ts")).toThrow('has no "export const <Name>');
    });

    test("maintenance fields rejects a reserved export name before writing a file", async () => {
        const dir = mkdtempSync(join(tmpdir(), "ado-manifest-cli-"));
        const config = join(dir, "config.json");
        const target = join(dir, "fields.ts");
        const previousConfig = getExplicitConfigPath();
        const previousExitCode = process.exitCode;
        const kind = manifestKind("fields");
        if (!kind) {
            throw new Error("fields manifest kind missing");
        }
        writeFileSync(
            config,
            SafeJSON.stringify({ org: "https://example.test", project: "Sample", projectId: "p", apiResource: "r" })
        );
        setConfigFlag(config);
        const fetch = spyOn(kind, "fetch").mockImplementation(async () => {
            throw new Error("unexpected manifest fetch");
        });
        const processLookup = spyOn(Api.prototype, "getProjectProcess").mockImplementation(async () => {
            throw new Error("unexpected process lookup");
        });
        try {
            const program = new Command().exitOverride();
            registerMaintenanceCommand(program);
            await program.parseAsync(["maintenance", "fields", "--name", "class", "--into", target], { from: "user" });
            expect(process.exitCode).toBe(1);
            expect(existsSync(target)).toBe(false);
            expect(fetch).not.toHaveBeenCalled();
            expect(processLookup).not.toHaveBeenCalled();
        } finally {
            fetch.mockRestore();
            processLookup.mockRestore();
            setConfigFlag(previousConfig ?? undefined);
            process.exitCode = previousExitCode;
        }
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

    test("lookups accept generated readonly manifests", () => {
        const generated = {
            meta: { org: "example", project: "sample", process: null, fetchedAt: "now", regenerate: "build" },
            types: {
                Task: {
                    states: [{ name: "New", category: "Proposed" }],
                    fields: {
                        "Custom.Merged": {
                            name: "Merged",
                            type: "string",
                            isIdentity: false,
                            alwaysRequired: false,
                            allowedValues: ["Yes", "No"],
                        },
                    },
                },
            },
        } as const;
        expect(findField(generated, { label: "Merged" })?.referenceName).toBe("Custom.Merged");
        expect(findFields(generated, { value: "yes" })).toHaveLength(1);
    });

    test("global regex queries do not carry state between types or calls", () => {
        const query = /merge/gi;
        const manifest = fixture();
        expect(findField(manifest, { label: query })?.types).toEqual(["Bug", "Task"]);
        expect(findField(manifest, { label: query })?.types).toEqual(["Bug", "Task"]);
        expect(query.lastIndex).toBe(0);
    });

    test("identity drift names the changed flag", () => {
        const saved = fixture();
        const live = fixture();
        live.types.Bug.fields[OWNER].isIdentity = false;
        expect(diffManifests(saved, live)).toContain(`Bug: field ${OWNER} identity true -> false`);
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

describe("other manifest kinds", () => {
    const meta = {
        kind: "areas",
        org: "https://dev.azure.com/example",
        project: "Sample",
        process: null,
        fetchedAt: "2026-01-02 03:04",
        regenerate: "tools azure-devops maintenance sync --into generated",
    };

    test("query manifests fail on a nested folder read error while ordinary listing remains tolerant", async () => {
        const api = new Api({
            org: "https://dev.azure.com/example",
            project: "Sample",
            projectId: "p",
            apiResource: "r",
        });
        Reflect.set(api, "get", async (url: string) => {
            if (url.includes("/queries/folder")) {
                throw new Error("nested folder unavailable");
            }
            return {
                value: [
                    {
                        id: "root",
                        name: "Shared Queries",
                        isFolder: true,
                        children: [{ id: "folder", name: "Nested", isFolder: true, hasChildren: true }],
                    },
                ],
            };
        });
        const kind = manifestKind("queries");
        if (!kind) {
            throw new Error("queries manifest kind missing");
        }
        expect(await api.getAllQueries()).toHaveLength(2);
        await expect(kind.fetch({ api })).rejects.toThrow("nested folder unavailable");
    });

    test("area nodes flatten to sorted WIQL area paths", () => {
        const root = {
            id: 1,
            identifier: "a",
            name: "Sample",
            path: "\\Sample\\Area",
            children: [
                { id: 3, identifier: "c", name: "Web", path: "\\Sample\\Area\\Web" },
                { id: 2, identifier: "b", name: "Api", path: "\\Sample\\Area\\Api" },
            ],
        };

        expect(flattenAreaPaths(root)).toEqual(["Sample", "Sample\\Api", "Sample\\Web"]);
    });

    test("the workflow subtracts the process rules that disallow states after a state", () => {
        const allToAll = (states: string[]) => states.map((to) => ({ to }));
        const states = ["New", "Active", "Done"];
        const rule = (name: string, from: string, disallow: string[], extra: { isDisabled?: boolean } = {}) => ({
            name,
            ...extra,
            conditions: [{ conditionType: "whenWas", field: "System.State", value: from }],
            actions: disallow.map((value) => ({ actionType: "disallowValue", targetField: "System.State", value })),
        });

        expect(
            buildWorkflow(
                { "": [{ to: "New" }], New: allToAll(states), Active: allToAll(states), Done: allToAll(states) },
                [
                    rule("From new", "New", ["Done"]),
                    rule("From done", "Done", ["New", "Active"]),
                    rule("Old rule", "Active", ["New"], { isDisabled: true }),
                    {
                        name: "Only leads close",
                        conditions: [{ conditionType: "whenCurrentUserIsNotMemberOfGroup", value: "leads" }],
                        actions: [{ actionType: "disallowValue", targetField: "System.State", value: "Done" }],
                    },
                ]
            )
        ).toEqual({
            initial: ["New"],
            transitions: { Active: ["Done", "New"], Done: [], New: ["Active"] },
            conditionalRules: ["Only leads close"],
        });
    });

    test("the generic diff names added and removed list items, changed values and keys, and skips meta", () => {
        const saved = { meta, areas: ["Sample", "Sample\\Api"], sprints: { S1: { finish: "2026-01-10" } } };
        const live = {
            meta: { ...meta, fetchedAt: "2026-02-03 04:05" },
            areas: ["Sample", "Sample\\Web"],
            sprints: { S1: { finish: "2026-01-12" }, S2: { finish: null } },
        };

        expect(diffManifestData(saved, live)).toEqual([
            'areas: added "Sample\\Web"; removed "Sample\\Api"',
            'sprints > S1 > finish: "2026-01-10" -> "2026-01-12"',
            'sprints > S2: added {"finish":null}',
        ]);
        expect(diffManifestData({ meta, tags: ["a", "b"] }, { meta, tags: ["b", "a"] })).toEqual([
            'tags: order ["a","b"] -> ["b","a"]',
        ]);
    });

    test("any manifest reads back from .ts with its kind, and a file without a kind is a field manifest", () => {
        const manifest = { meta, areas: ["Sample"] };
        const parsed = parseManifestText(renderAnyTs(manifest, "SampleAdoAreas"), "ado-areas.generated.ts");

        expect(parsed).toEqual(manifest);
        expect(kindOfManifest(parsed)?.kind).toBe("areas");
        expect(kindOfManifest({ meta: { ...meta, kind: undefined } })?.kind).toBe("fields");
        expect(renderGenericMd(parsed)).toContain("## areas\n\n- Sample");
    });
});
