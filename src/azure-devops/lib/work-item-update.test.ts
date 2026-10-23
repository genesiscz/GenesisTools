import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerWorkItemUpdateCommand, resolveImages } from "@app/azure-devops/commands/workitem-update";
import {
    executeWorkItemUpdate,
    imageReuseMap,
    localImageSources,
    parseFieldSpec,
    parseReuseFile,
    replaceImageSources,
    sameStoredText,
    sha256Hex,
    type WorkItemUpdateClient,
    type WorkItemUpdateImage,
    workItemPatch,
} from "@app/azure-devops/lib/work-item-update";
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

function image(src: string, bytes: Uint8Array, sha256 = sha256Hex(bytes)): WorkItemUpdateImage {
    return { src, name: src.slice(src.lastIndexOf("/") + 1), sha256, bytes };
}

function client(
    item: WorkItemLive,
    uploadUrl = ATTACHMENT
): WorkItemUpdateClient & { uploads: string[]; operations: JsonPatchOperation[][] } {
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
        const uploaded = new Map([["a.png", { sha256, url: ATTACHMENT }]]);
        const same = image("shots/a.png", bytes, sha256);
        const changed = image("shots/a.png", bytes, "f".repeat(64));

        expect(imageReuseMap([same.src], new Map([[same.src, same.sha256]]), uploaded).get(same.src)).toBe(ATTACHMENT);
        expect(imageReuseMap([changed.src], new Map([[changed.src, changed.sha256]]), uploaded).size).toBe(0);
    });

    test("a confirmed update does not upload a file whose sha256 is already uploaded", async () => {
        const shot = image("shots/a.png", bytes);
        const ado = client(live());
        const result = await executeWorkItemUpdate(ado, {
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
        const result = await executeWorkItemUpdate(ado, {
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
        const result = await executeWorkItemUpdate(ado, {
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
    const same = (stored: string, sent: string, images?: ReadonlyMap<string, string>) =>
        sameStoredText({ stored, sent, format: "markdown", images });

    test("an emoji stored as a character reference matches the emoji that was sent", () => {
        expect(same("see &#128279; this", "see 🔗 this")).toBe(true);
        expect(same("see &#x1F517; this", "see 🔗 this")).toBe(true);
    });

    test("a quoted integer attribute may lose its quotes, and a percent value keeps them", () => {
        expect(same('<img width="375">', "<img width=375>")).toBe(true);
        expect(same('<img width="48%">', '<img width="48%">')).toBe(true);
        expect(same('<img width="48%">', "<img width=48%>")).toBe(false);
    });

    test("a local image src matches the attachment URL it was replaced with", () => {
        const images = new Map([["shots/a.png", ATTACHMENT]]);

        expect(same(`<img src="${ATTACHMENT}">`, '<img src="shots/a.png">', images)).toBe(true);
        expect(same(`<img src="${ATTACHMENT}">`, '<img src="shots/a.png">')).toBe(false);
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
        registerWorkItemUpdateCommand(program);
        const command = program.commands.find((item) => item.name() === "workitem-update");
        const flags = command?.options.map((option) => option.long) ?? [];

        expect(flags).toEqual(
            expect.arrayContaining(["--field", "--markdown", "--rev", "--image-root", "--reuse", "--confirm", "--json"])
        );
        expect(command?.description().length).toBeGreaterThan(0);
        expect(command?.aliases()).toEqual(["update"]);

        for (const option of command?.options ?? []) {
            expect(option.description.length, option.long).toBeGreaterThan(0);
        }
    });
});

describe("the read-back of typed fields", () => {
    function typedClient(stored: Record<string, unknown>): WorkItemUpdateClient {
        let rev = 6;
        return {
            async read() {
                return { id: 100, rev, fields: rev > 6 ? stored : {}, multilineFieldsFormat: {} };
            },
            async upload() {
                return ATTACHMENT;
            },
            async update() {
                rev += 1;
            },
        };
    }

    const update = (ado: WorkItemUpdateClient, name: string, value: string) =>
        executeWorkItemUpdate(ado, {
            id: 100,
            fields: [{ name, value }],
            markdownFields: [],
            images: [],
            reuse: new Map(),
            confirm: true,
        });

    test("a number, a boolean and an identity the server stores in its own type match what was sent", async () => {
        const identity = { displayName: "Alice Example", uniqueName: "alice@example.com" };
        const ado = typedClient({
            "Microsoft.VSTS.Scheduling.RemainingWork": 5,
            "Custom.Blocked": false,
            "System.AssignedTo": identity,
        });

        expect((await update(ado, "Microsoft.VSTS.Scheduling.RemainingWork", "5")).ok).toBe(true);
        expect((await update(ado, "Custom.Blocked", "False")).ok).toBe(true);
        expect((await update(ado, "System.AssignedTo", "alice@example.com")).ok).toBe(true);
        expect((await update(ado, "System.AssignedTo", "Alice Example <alice@example.com>")).ok).toBe(true);
    });

    test("a different stored number is still a mismatch, reported as text", async () => {
        const result = await update(
            typedClient({ "Microsoft.VSTS.Scheduling.RemainingWork": 4 }),
            "Microsoft.VSTS.Scheduling.RemainingWork",
            "5"
        );

        expect(result).toMatchObject({
            ok: false,
            mismatches: [{ field: "Microsoft.VSTS.Scheduling.RemainingWork", sent: "5", stored: "4" }],
        });
    });
});

describe("what the read-back may forgive", () => {
    test("a plain field matches exactly: a semicolon or a space the server dropped is a mismatch", async () => {
        const ado = client(live({ fields: { "System.Title": "old" }, multilineFieldsFormat: {} }));
        ado.update = async () => {};
        const read = ado.read;
        ado.read = async (id) => ({ ...(await read(id)), rev: 7, fields: { "System.Title": "ab" } });
        const result = await executeWorkItemUpdate(ado, {
            id: 100,
            fields: [{ name: "System.Title", value: "a;b" }],
            markdownFields: [],
            images: [],
            reuse: new Map(),
            confirm: true,
        });

        expect(result).toMatchObject({ ok: false, mismatches: [{ field: "System.Title", sent: "a;b", stored: "ab" }] });
        expect(sameStoredText({ stored: "a  b", sent: "a b", format: "plain" })).toBe(false);
    });

    test("Markdown keeps semicolons, paragraph breaks and code indentation", () => {
        const md = (stored: string, sent: string) => sameStoredText({ stored, sent, format: "markdown" });

        expect(md("ab", "a;b")).toBe(false);
        expect(md("one two", "one\n\ntwo")).toBe(false);
        expect(md("```\ncode\n```", "```\n    code\n```")).toBe(false);
        expect(md("one\r\n\r\ntwo  \n", "one\n\ntwo")).toBe(true);
    });

    test("HTML forgives insignificant space and the semicolon the server adds to a style", () => {
        const html = (stored: string, sent: string) => sameStoredText({ stored, sent, format: "html" });

        expect(html('<p>\n  <span style="color:red;">a</span>\n</p>', '<p><span style="color:red">a</span></p>')).toBe(
            true
        );
        expect(html("<p>a;b</p>", "<p>ab</p>")).toBe(false);
    });

    test("read-back keeps space beside inline tags and Markdown hard breaks, and never throws on a bad reference", () => {
        const html = (stored: string, sent: string) => sameStoredText({ stored, sent, format: "html" });
        const md = (stored: string, sent: string) => sameStoredText({ stored, sent, format: "markdown" });

        expect(html("<p>Hello<b>world</b></p>", "<p>Hello <b>world</b></p>")).toBe(false);
        expect(md("one\ntwo", "one  \ntwo")).toBe(false);
        expect(md("one   \ntwo", "one  \ntwo")).toBe(true);
        expect(html("<p>&#1114112; &#x110000;</p>", "<p>&#1114112; &#x110000;</p>")).toBe(true);
        expect(html("<p>&#x110000;</p>", "<p>x</p>")).toBe(false);
    });

    test("a local image outside --image-root is refused before it is read", () => {
        const dir = mkdtempSync(join(tmpdir(), "wi-images-"));
        mkdirSync(join(dir, "root"));
        writeFileSync(join(dir, "root", "in.png"), "in");
        writeFileSync(join(dir, "secret.txt"), "secret");
        const root = join(dir, "root");

        expect(resolveImages(['<img src="in.png">'], root).map((image) => image.name)).toEqual(["in.png"]);
        expect(() => resolveImages(['<img src="../secret.txt">'], root)).toThrow("outside --image-root");
        expect(() => resolveImages([`<img src="${join(dir, "secret.txt")}">`], root)).toThrow("outside --image-root");
    });

    test("local image sources are found and replaced in every valid src spelling", () => {
        const input = `<img src='shots/a.png'><IMG SRC="shots/b.png"><img alt="x" src = shots/c.png><img src="https://h/d.png">`;

        expect(localImageSources(input)).toEqual(["shots/a.png", "shots/b.png", "shots/c.png"]);
        expect(
            replaceImageSources(
                input,
                new Map([
                    ["shots/a.png", "https://h/1"],
                    ["shots/b.png", "https://h/2"],
                    ["shots/c.png", "https://h/3"],
                ])
            )
        ).toBe(
            `<img src="https://h/1"><IMG SRC="https://h/2"><img alt="x" src = "https://h/3"><img src="https://h/d.png">`
        );
    });

    test("--markdown without --field still checks that the field became Markdown", async () => {
        const ado = client(live({ fields: { "System.Description": "body", "System.Title": "t" } }));
        ado.update = async () => {};
        const read = ado.read;
        ado.read = async (id) => ({ ...(await read(id)), rev: 7 });
        const formatOnly = await executeWorkItemUpdate(ado, {
            id: 100,
            fields: [],
            markdownFields: ["System.Description"],
            images: [],
            reuse: new Map(),
            confirm: true,
        });
        const otherField = await executeWorkItemUpdate(ado, {
            id: 100,
            fields: [{ name: "System.Title", value: "t" }],
            markdownFields: ["System.Description"],
            images: [],
            reuse: new Map(),
            confirm: true,
        });

        for (const result of [formatOnly, otherField]) {
            expect(result).toMatchObject({
                ok: false,
                mismatches: [{ field: "System.Description", sent: "Markdown", stored: "html" }],
            });
        }
    });
});
