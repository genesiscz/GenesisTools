import { describe, expect, test } from "bun:test";
import { registerWorkItemPostCommand } from "@app/azure-devops/commands/workitem-post";
import {
    executeWorkItemPost,
    imageReuseMap,
    parseFieldSpec,
    parseReuseFile,
    samePostedMarkdown,
    sha256Hex,
    type WorkItemPostClient,
    type WorkItemPostImage,
    workItemPatch,
} from "@app/azure-devops/lib/work-item-post";
import type { JsonPatchOperation, WorkItemLive } from "@app/azure-devops/types";
import { Command } from "commander";

const ATTACHMENT = "https://example.invalid/org/_apis/wit/attachments/abc?fileName=a.png";

function live(overrides: Partial<WorkItemLive> = {}): WorkItemLive {
    return {
        id: 100,
        rev: 6,
        fields: { "System.Description": "old" },
        multilineFieldsFormat: { "System.Description": "html" },
        ...overrides,
    };
}

function image(src: string, bytes: Uint8Array, sha256 = sha256Hex(bytes)): WorkItemPostImage {
    return { src, name: src.slice(src.lastIndexOf("/") + 1), sha256, bytes };
}

function client(
    item: WorkItemLive,
    uploadUrl = ATTACHMENT
): WorkItemPostClient & { uploads: string[]; operations: JsonPatchOperation[][] } {
    const state = { ...item, fields: { ...item.fields }, multilineFieldsFormat: { ...item.multilineFieldsFormat } };
    const uploads: string[] = [];
    const operations: JsonPatchOperation[][] = [];

    return {
        uploads,
        operations,
        async read() {
            return {
                id: state.id,
                rev: state.rev,
                fields: { ...state.fields },
                multilineFieldsFormat: { ...state.multilineFieldsFormat },
            };
        },
        async upload(fileName) {
            uploads.push(fileName);
            return uploadUrl;
        },
        async update(_id, ops) {
            operations.push(ops);
            state.rev += 1;

            for (const op of ops) {
                if (op.op === "add" && op.path.startsWith("/fields/") && typeof op.value === "string") {
                    state.fields[op.path.slice("/fields/".length)] = op.value;
                }

                if (op.op === "add" && op.path.startsWith("/multilineFieldsFormat/") && typeof op.value === "string") {
                    state.multilineFieldsFormat[op.path.slice("/multilineFieldsFormat/".length)] = op.value;
                }
            }
        },
    };
}

describe("image reuse", () => {
    const bytes = new TextEncoder().encode("png-bytes");
    const sha256 = sha256Hex(bytes);

    test("reuses the attachment URL when the file sha256 is unchanged, and uploads when it changed", () => {
        const posted = new Map([["a.png", { sha256, url: ATTACHMENT }]]);
        const same = image("shots/a.png", bytes, sha256);
        const changed = image("shots/a.png", bytes, "f".repeat(64));

        expect(imageReuseMap([same.src], new Map([[same.src, same.sha256]]), posted).get(same.src)).toBe(ATTACHMENT);
        expect(imageReuseMap([changed.src], new Map([[changed.src, changed.sha256]]), posted).size).toBe(0);
    });

    test("a confirm post does not upload a file whose sha256 is already posted", async () => {
        const shot = image("shots/a.png", bytes);
        const ado = client(live());
        const result = await executeWorkItemPost(ado, {
            id: 100,
            fields: [{ name: "System.Description", value: `<img src="${shot.src}">` }],
            markdownFields: [],
            images: [shot],
            reuse: new Map([[shot.name, { sha256: shot.sha256, url: ATTACHMENT }]]),
            confirm: true,
        });

        expect(ado.uploads).toEqual([]);
        expect(result.ok).toBe(true);
        expect(
            ado.operations[0]?.some(
                (op) => op.path === "/fields/System.Description" && op.value === `<img src="${ATTACHMENT}">`
            )
        ).toBe(true);
    });
});

describe("the rev test and the format switch", () => {
    test("the patch tests /rev and switches only the named fields that are not already Markdown", () => {
        const operations = workItemPatch({
            rev: 6,
            fields: [
                { name: "System.Description", value: "next" },
                { name: "System.History", value: "note" },
            ],
            markdownFields: ["System.Description", "System.History"],
            liveFormats: { "System.History": "markdown" },
        });

        expect(operations[0]).toEqual({ op: "test", path: "/rev", value: 6 });
        expect(operations).toContainEqual({
            op: "add",
            path: "/multilineFieldsFormat/System.Description",
            value: "Markdown",
        });
        expect(operations.some((op) => op.path === "/multilineFieldsFormat/System.History")).toBe(false);
        expect(operations.filter((op) => op.path.startsWith("/fields/"))).toHaveLength(2);
    });

    test("a stale --rev sends nothing", async () => {
        const ado = client(live());
        const result = await executeWorkItemPost(ado, {
            id: 100,
            rev: 5,
            fields: [{ name: "System.Description", value: "next" }],
            markdownFields: ["System.Description"],
            images: [],
            reuse: new Map(),
            confirm: true,
        });

        expect(result).toEqual({ ok: false, error: "work item 100 is at rev 6, not 5" });
        expect(ado.operations).toEqual([]);
        expect(ado.uploads).toEqual([]);
    });

    test("confirm sends the rev test and the format switch, then accepts the read-back", async () => {
        const ado = client(live());
        const result = await executeWorkItemPost(ado, {
            id: 100,
            fields: [{ name: "System.Description", value: "next" }],
            markdownFields: ["System.Description"],
            images: [],
            reuse: new Map(),
            confirm: true,
        });

        expect(result.ok).toBe(true);

        if (result.ok && !result.dryRun) {
            expect(result.rev).toBe(7);
        }

        expect(ado.operations[0]?.[0]).toEqual({ op: "test", path: "/rev", value: 6 });
        expect(ado.operations[0]).toContainEqual({
            op: "add",
            path: "/multilineFieldsFormat/System.Description",
            value: "Markdown",
        });
    });
});

describe("read-back rewrites", () => {
    test("an emoji stored as a character reference matches the emoji that was sent", () => {
        expect(samePostedMarkdown("see &#128279; this", "see 🔗 this")).toBe(true);
        expect(samePostedMarkdown("see &#x1F517; this", "see 🔗 this")).toBe(true);
    });

    test("a quoted integer attribute may lose its quotes, and a percent value keeps them", () => {
        expect(samePostedMarkdown('<img width="375">', "<img width=375>")).toBe(true);
        expect(samePostedMarkdown('<img width="48%">', '<img width="48%">')).toBe(true);
        expect(samePostedMarkdown('<img width="48%">', "<img width=48%>")).toBe(false);
    });

    test("a local image src matches the attachment URL it was replaced with", () => {
        const images = new Map([["shots/a.png", ATTACHMENT]]);

        expect(samePostedMarkdown(`<img src="${ATTACHMENT}">`, '<img src="shots/a.png">', images)).toBe(true);
        expect(samePostedMarkdown(`<img src="${ATTACHMENT}">`, '<img src="shots/a.png">')).toBe(false);
    });
});

describe("command input", () => {
    test("a @ value is read from the file, and --reuse is a name to sha256 and url", () => {
        expect(parseFieldSpec("System.Description=@draft.html", (path) => `from ${path}`)).toEqual({
            name: "System.Description",
            value: "from draft.html",
        });
        expect(
            parseReuseFile(`{ "a.png": { "sha256": "${"a".repeat(64)}", "url": "${ATTACHMENT}" } }`).get("a.png")
        ).toEqual({
            sha256: "a".repeat(64),
            url: ATTACHMENT,
        });
    });

    test("--help names every flag", () => {
        const program = new Command();
        registerWorkItemPostCommand(program);
        const command = program.commands.find((item) => item.name() === "workitem-post");
        const flags = command?.options.map((option) => option.long) ?? [];

        expect(flags).toEqual(
            expect.arrayContaining(["--field", "--markdown", "--rev", "--image-root", "--reuse", "--confirm", "--json"])
        );
        expect(command?.description().length).toBeGreaterThan(0);

        for (const option of command?.options ?? []) {
            expect(option.description.length, option.long).toBeGreaterThan(0);
        }
    });
});
