import { afterEach, describe, expect, setSystemTime, spyOn, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    generateEmptyTemplate,
    generateTemplateFromQuery,
    generateTemplateFromWorkItem,
    saveTemplate,
} from "@app/azure-devops/templates";
import type { WorkItem, WorkItemFull, WorkItemType } from "@app/azure-devops/types";
import { SafeJSON } from "@genesiscz/utils/json";

const FIXED_NOW = new Date("2026-03-04T05:06:07.890Z");

function listItem(overrides: Partial<WorkItem> = {}): WorkItem {
    return {
        id: 1,
        rev: 1,
        title: "Item",
        state: "New",
        changed: "2026-01-01T00:00:00Z",
        url: "https://dev.azure.com/contoso/_apis/wit/workItems/1",
        ...overrides,
    };
}

function fullItem(overrides: Partial<WorkItemFull> = {}): WorkItemFull {
    return { ...listItem(), comments: [], ...overrides };
}

function workItemLink(rel: string, id: number) {
    return { rel, url: `https://dev.azure.com/contoso/_apis/wit/workItems/${id}` };
}

afterEach(() => {
    setSystemTime();
});

describe("generateEmptyTemplate", () => {
    test("returns blank fields, no relations and a generation timestamp for the requested type", () => {
        setSystemTime(FIXED_NOW);

        expect(generateEmptyTemplate("Bug")).toEqual({
            $schema: "azure-devops-workitem-v1",
            type: "Bug",
            fields: {
                title: "",
                description: "",
                severity: "",
                areaPath: "",
                iterationPath: "",
                tags: [],
                assignedTo: "",
            },
            relations: { parent: undefined, children: [], related: [] },
            _hints: undefined,
            _source: { generatedAt: "2026-03-04T05:06:07.890Z" },
        });
    });

    test("renames well-known reference names in the hints and adds a required title hint", () => {
        const template = generateEmptyTemplate("Task", {
            "Microsoft.VSTS.Common.Severity": { description: "How bad", allowedValues: ["1 - Critical", "2 - High"] },
            "System.AreaPath": { description: "Where it lives" },
            "Custom.Application": { description: "Which app" },
        });

        expect(template._hints).toEqual({
            severity: { description: "How bad", allowedValues: ["1 - Critical", "2 - High"] },
            areaPath: { description: "Where it lives" },
            "Custom.Application": { description: "Which app" },
            title: { description: "Brief title for the work item", required: true },
        });
    });

    test("keeps the title hint the caller supplied instead of overwriting it", () => {
        const template = generateEmptyTemplate("Task", {
            "System.Title": { description: "Name of the change", required: false },
        });

        expect(template._hints?.title).toEqual({ description: "Name of the change", required: false });
        expect(Object.keys(template._hints ?? {})).toEqual(["title"]);
    });
});

describe("generateTemplateFromWorkItem", () => {
    const source = fullItem({
        id: 4242,
        title: "Fix crash on login",
        description: "<h2>Steps</h2><p>Open the app</p><h3>Expected</h3><p>No crash</p>",
        relations: [
            workItemLink("System.LinkTypes.Hierarchy-Reverse", 100),
            workItemLink("System.LinkTypes.Hierarchy-Forward", 101),
            workItemLink("System.LinkTypes.Related", 102),
        ],
        rawFields: {
            "System.Title": "Fix crash on login",
            "System.State": "Active",
            "System.Rev": 7,
            "System.AreaPath": "Widgets\\Mobile",
            "System.AssignedTo": { displayName: "Alice Example", uniqueName: "alice@example.com" },
            "System.Tags": "ui; crash;; ",
            "Microsoft.VSTS.Common.Severity": "2 - High",
            "Microsoft.VSTS.Common.Priority": 2,
            "Custom.Application": "Mobile app",
            "Custom.32af3eb0-3fc8-4099-aaaa-0123456789ab": "guid field",
            "Custom.Empty": "",
            "Custom.Nothing": null,
            "Custom.Labels": ["a", 3],
            "Custom.Flag": true,
        },
    });

    test("copies the user-editable fields under their short names and drops system and empty ones", () => {
        const template = generateTemplateFromWorkItem(source);

        expect(template.fields).toEqual({
            title: "",
            description: "## Steps\n\n### Expected\n",
            areaPath: "Widgets\\Mobile",
            assignedTo: "Alice Example",
            tags: ["ui", "crash"],
            severity: "2 - High",
            priority: 2,
            application: "Mobile app",
            labels: ["a", "3"],
            flag: "true",
        });
    });

    test("keeps only the parent link: a new item starts without the source's children and related items", () => {
        const template = generateTemplateFromWorkItem(source);

        expect(template.relations).toEqual({ parent: 100, children: [], related: [] });
        expect(template._hints?.parent).toEqual({
            description: "Same parent as source work item",
            usedValues: ["100"],
        });
    });

    test("records the source item id and writes a hint for every copied field", () => {
        setSystemTime(FIXED_NOW);

        const template = generateTemplateFromWorkItem(source);

        expect(template._source).toEqual({ workItemId: 4242, generatedAt: "2026-03-04T05:06:07.890Z" });
        expect(template._hints?.title).toEqual({ description: "Title for the new work item", required: true });
        expect(template._hints?.priority).toEqual({
            description: "Pre-filled from source work item (Microsoft.VSTS.Common.Priority)",
            usedValues: ["2"],
        });
        expect(template._hints?.labels?.usedValues).toEqual(["a, 3"]);
        expect(template._hints?.application?.usedValues).toEqual(["Mobile app"]);
    });

    test("uses the field schema for help text, required flag and allowed values", () => {
        const template = generateTemplateFromWorkItem(
            source,
            undefined,
            new Map([
                [
                    "Microsoft.VSTS.Common.Severity",
                    {
                        name: "Severity",
                        required: true,
                        allowedValues: ["1 - Critical", "2 - High"],
                        helpText: "How bad",
                    },
                ],
                ["Custom.Environment", { name: "Environment", required: false, allowedValues: ["Prod", "Test"] }],
                ["Custom.Notes", { name: "Notes", required: false, allowedValues: [] }],
                ["System.State", { name: "State", required: true, allowedValues: ["New", "Active"] }],
            ])
        );

        expect(template._hints?.severity).toEqual({
            description: "How bad",
            usedValues: ["2 - High"],
            allowedValues: ["1 - Critical", "2 - High"],
            required: true,
        });
        expect(template._hints?.environment).toEqual({
            description: "Field from type definition (Custom.Environment)",
            allowedValues: ["Prod", "Test"],
            required: false,
        });
        expect(template._hints).not.toHaveProperty("notes");
        expect(template._hints).not.toHaveProperty("state");
        expect(template.fields).not.toHaveProperty("environment");
    });

    test("describes a schema-only field with its help text when the type definition has one", () => {
        const template = generateTemplateFromWorkItem(
            fullItem({ title: "Plain" }),
            undefined,
            new Map([
                [
                    "Microsoft.VSTS.Common.Risk",
                    { name: "Risk", required: false, allowedValues: ["Low", "High"], helpText: "How risky" },
                ],
            ])
        );

        expect(template._hints?.risk).toEqual({
            description: "How risky",
            allowedValues: ["Low", "High"],
            required: false,
        });
    });

    test("yields only title and description when the source has no raw fields, relations or description", () => {
        const template = generateTemplateFromWorkItem(fullItem({ title: "Plain" }));

        expect(template.fields).toEqual({ title: "", description: "" });
        expect(template.relations).toEqual({ parent: undefined, children: [], related: [] });
        expect(Object.keys(template._hints ?? {})).toEqual(["title", "description"]);
    });

    test("leaves the description empty when the source description has no section headings", () => {
        const template = generateTemplateFromWorkItem(fullItem({ description: "<p>Just a paragraph</p>" }));

        expect(template.fields.description).toBe("");
    });

    test.each<[string, WorkItemType]>([
        ["Fix login crash", "Bug"],
        ["Payment error on retry", "Bug"],
        ["Implement CSV export", "Feature"],
        ["Dark mode feature", "Feature"],
        ["Write task for deploy", "Task"],
        ["As a user I can log out", "User Story"],
        ["Refactor settings page", "Task"],
        ["Implement bug tracker", "Bug"],
    ])("infers the type of '%s' as %s", (title, expected) => {
        expect(generateTemplateFromWorkItem(fullItem({ title })).type).toBe(expected);
    });

    test("an explicit type wins over the one inferred from the title", () => {
        expect(generateTemplateFromWorkItem(fullItem({ title: "Fix crash" }), "Epic").type).toBe("Epic");
    });
});

describe("generateTemplateFromQuery", () => {
    const items = [
        listItem({ id: 1, severity: "2 - High", assignee: "alice@example.com", tags: "ui; crash" }),
        listItem({ id: 2, severity: "3 - Medium", assignee: "bob@example.com", tags: "crash; api" }),
        listItem({ id: 3, severity: "2 - High", assignee: "alice@example.com", tags: "crash" }),
    ];

    test("pre-fills severity from the first item and lists the values the query results used", () => {
        setSystemTime(FIXED_NOW);

        const template = generateTemplateFromQuery(items, "Bug", "Widgets", "query-1", {
            "Microsoft.VSTS.Common.Severity": { description: "Severity", allowedValues: ["2 - High", "3 - Medium"] },
        });

        expect(template.type).toBe("Bug");
        expect(template.fields.severity).toBe("2 - High");
        expect(template._hints?.severity).toEqual({
            description: "Severity level (from query data)",
            allowedValues: ["2 - High", "3 - Medium"],
            usedValues: ["2 - High", "3 - Medium"],
            examples: ["2 - High", "3 - Medium"],
        });
        expect(template._hints?.assignedTo?.usedValues).toEqual(["alice@example.com", "bob@example.com"]);
        expect(template._source).toEqual({
            queryId: "query-1",
            analyzedItemCount: 3,
            generatedAt: "2026-03-04T05:06:07.890Z",
        });
    });

    test("orders the tag hint by how often the query results used each tag", () => {
        const template = generateTemplateFromQuery(items, "Task", "Widgets", "query-1");

        expect(template._hints?.tags?.usedValues).toEqual(["crash", "ui", "api"]);
        expect(template._hints?.tags?.examples).toEqual(["crash", "ui", "api"]);
        expect(template._hints?.severity?.allowedValues).toBeUndefined();
    });

    test("gives a blank template with no parent and no examples for an empty result", () => {
        const template = generateTemplateFromQuery([], "Task", "Widgets", "query-2");

        expect(template.fields).toEqual({
            title: "",
            description: "",
            severity: "",
            areaPath: "",
            iterationPath: "",
            tags: [],
            assignedTo: "",
        });
        expect(template.relations).toEqual({ parent: undefined, children: [], related: [] });
        expect(template._hints?.parent?.examples).toEqual([]);
        expect(template._source?.analyzedItemCount).toBe(0);
    });
});

describe("saveTemplate", () => {
    test("writes the template as indented JSON named by timestamp and type, creating the folder", () => {
        setSystemTime(FIXED_NOW);
        const baseDir = join(mkdtempSync(join(tmpdir(), "ado-templates-")), "nested", "created");
        const template = generateEmptyTemplate("User Story");

        const filePath = saveTemplate(template, baseDir);

        expect(filePath).toBe(join(baseDir, "2026-03-04T05-06-07-NewUserStory.json"));

        const text = readFileSync(filePath, "utf8");

        expect(text).toContain('\n  "type": "User Story"');
        expect(SafeJSON.parse(text)).toEqual(template);
    });

    test("writes under .claude/azure/tasks/created of the working directory when no folder is given", () => {
        setSystemTime(FIXED_NOW);
        const cwd = mkdtempSync(join(tmpdir(), "ado-templates-cwd-"));
        const cwdSpy = spyOn(process, "cwd").mockReturnValue(cwd);

        try {
            const filePath = saveTemplate(generateEmptyTemplate("Bug"));

            expect(filePath).toBe(join(cwd, ".claude/azure/tasks/created", "2026-03-04T05-06-07-NewBug.json"));
            expect(existsSync(filePath)).toBe(true);
        } finally {
            cwdSpy.mockRestore();
        }
    });
});
