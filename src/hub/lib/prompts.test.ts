import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import {
    addPrompt,
    deliveryMode,
    findPrompt,
    HubPromptError,
    listPrompts,
    parseVars,
    promptVariables,
    readPrompts,
    removePrompt,
    renderPrompt,
    type SavedPrompt,
    type SendPromptDeps,
    sendPrompt,
    sortByUse,
} from "./prompts";

const SESSION = "44444444-4444-4444-8444-444444444444";

function scratch(): string {
    return join(mkdtempSync(join(tmpdir(), "hub-prompts-")), "prompts.json");
}

function saved(name: string, uses = 0, lastUsedAt: string | null = null): SavedPrompt {
    return { name, text: name, description: null, uses, lastUsedAt, createdAt: "2026-09-26T10:00:00.000Z" };
}

/** Records every send and file write; nothing reaches cmux or the disk outside the scratch folder. */
function fakeDeps(overrides: Partial<SendPromptDeps> = {}): SendPromptDeps & { sent: string[]; written: string[] } {
    const sent: string[] = [];
    const written: string[] = [];
    return {
        sent,
        written,
        cwdOf: () => "/Users/alice/Projects/shop",
        facts: async (_cwd, withPr) => ({
            branch: "feat/cart",
            root: "/Users/alice/Projects/shop",
            pr: withPr ? "42" : null,
        }),
        send: async (session, text) => {
            sent.push(`${session} ${text}`);
            return null;
        },
        write: async (file, text) => {
            written.push(`${file}\n${text}`);
        },
        dir: "/tmp/hub-prompts-sent",
        now: () => new Date("2026-09-26T18:30:00.000Z"),
        ...overrides,
    };
}

describe("variables", () => {
    test("each variable once, in the order it first appears, spaces inside the braces allowed", () => {
        expect(promptVariables("Fix {{pr}} on {{ branch }}, then {{pr}} again and {{file.path}}")).toEqual([
            "pr",
            "branch",
            "file.path",
        ]);
        expect(promptVariables("no variables {here}")).toEqual([]);
    });

    test("render fills what it has and reports the rest, which stays as written", () => {
        expect(renderPrompt("Rebase {{branch}} onto {{base}}", { branch: "feat/x" })).toEqual({
            text: "Rebase feat/x onto {{base}}",
            missing: ["base"],
        });
        expect(renderPrompt("{{a}}", { a: "" }).missing).toEqual(["a"]);
    });

    test("parseVars splits at the first =", () => {
        expect(parseVars(["branch=feat/x", "query=a=b"])).toEqual({ branch: "feat/x", query: "a=b" });
        expect(() => parseVars(["novalue"])).toThrow(HubPromptError);
    });
});

describe("ordering and lookup", () => {
    test("most used first, then most recently used, then by name", () => {
        const list = [
            saved("b"),
            saved("a"),
            saved("hot", 5),
            saved("warm", 1, "2026-09-25"),
            saved("warmer", 1, "2026-09-26"),
        ];

        expect(sortByUse(list).map((prompt) => prompt.name)).toEqual(["hot", "warmer", "warm", "a", "b"]);
    });

    test("exact name, then case-insensitive, then a unique prefix; an ambiguous or unknown name throws", () => {
        const list = [saved("review"), saved("rebase"), saved("Explain")];

        expect(findPrompt(list, "review").name).toBe("review");
        expect(findPrompt(list, "explain").name).toBe("Explain");
        expect(findPrompt(list, "rev").name).toBe("review");
        expect(() => findPrompt(list, "re")).toThrow(/matches review, rebase/);
        expect(() => findPrompt(list, "nope")).toThrow(/no saved prompt/);
    });
});

describe("the prompts file", () => {
    test("a missing file lists the defaults; a corrupt one too", () => {
        const path = scratch();

        expect(readPrompts(path).prompts.map((prompt) => prompt.name)).toEqual([
            "fix-review",
            "rebase",
            "explain-file",
        ]);
        writeFileSync(path, "{ not json");
        expect(readPrompts(path).prompts).toHaveLength(3);
    });

    test("add keeps the defaults, refuses a duplicate without --replace, and replace keeps the use count", async () => {
        const path = scratch();
        await addPrompt({ name: "ship", text: "Ship {{branch}}", path });

        expect(listPrompts(path).find((prompt) => prompt.name === "ship")?.variables).toEqual(["branch"]);
        expect(readPrompts(path).prompts).toHaveLength(4);
        await expect(addPrompt({ name: "ship", text: "again", path })).rejects.toThrow(/--replace/);

        const file = readPrompts(path);
        const ship = file.prompts.find((prompt) => prompt.name === "ship");

        if (ship) {
            ship.uses = 3;
        }

        writeFileSync(path, SafeJSON.stringify(file));
        const replaced = await addPrompt({ name: "ship", text: "Ship {{branch}} now", replace: true, path });
        expect(replaced).toMatchObject({ text: "Ship {{branch}} now", uses: 3 });
    });

    test("add refuses a bad name and an empty text; remove takes a unique prefix", async () => {
        const path = scratch();

        await expect(addPrompt({ name: "../x", text: "t", path })).rejects.toThrow(HubPromptError);
        await expect(addPrompt({ name: "ok", text: "   ", path })).rejects.toThrow(/empty/);
        expect((await removePrompt({ name: "explain", path })).name).toBe("explain-file");
        expect(readPrompts(path).prompts.map((prompt) => prompt.name)).toEqual(["fix-review", "rebase"]);
    });
});

describe("deliveryMode", () => {
    test("one plain line is typed; a line break or a cmux escape goes through a file", () => {
        expect(deliveryMode("Fix the tests")).toBe("inline");
        expect(deliveryMode("line one\nline two")).toBe("file");
        expect(deliveryMode("match \\n in the regex")).toBe("file");
        expect(deliveryMode("a path C:\\new is fine? no: \\t")).toBe("file");
    });
});

describe("sendPrompt", () => {
    test("fills branch and pr from the session's checkout, types one line, and counts the use", async () => {
        const path = scratch();
        const deps = fakeDeps();
        const result = await sendPrompt({ name: "fix-review", session: SESSION, path, deps });

        expect(result).toMatchObject({ sent: true, mode: "inline", filled: ["pr", "branch"], file: null });
        expect(deps.sent).toEqual([`${SESSION} ${result.text}`]);
        expect(result.text).toContain("PR 42 (feat/cart)");
        expect(readPrompts(path).prompts.find((prompt) => prompt.name === "fix-review")).toMatchObject({
            uses: 1,
            lastUsedAt: "2026-09-26T18:30:00.000Z",
        });
    });

    test("an explicit --var wins over the session's value, and the PR is not looked up when given", async () => {
        const path = scratch();
        let askedForPr = false;
        const deps = fakeDeps({
            facts: async (_cwd, withPr) => {
                askedForPr = withPr;
                return { branch: "feat/cart", root: null, pr: null };
            },
        });
        const result = await sendPrompt({ name: "fix-review", session: SESSION, vars: { pr: "7" }, path, deps });

        expect(result.text).toContain("PR 7 (feat/cart)");
        expect(askedForPr).toBe(false);
    });

    test("a variable nothing fills stops the send and names it", async () => {
        const path = scratch();
        const deps = fakeDeps();

        const error = await sendPrompt({ name: "explain-file", session: SESSION, path, deps }).catch(
            (caught: unknown) => caught
        );

        if (!(error instanceof HubPromptError)) {
            throw new Error(`expected a HubPromptError, got ${String(error)}`);
        }

        expect(error.code).toBe("missing-vars");
        expect(error.missing).toEqual(["file"]);

        expect(deps.sent).toEqual([]);
    });

    test("a multi-line prompt is written to a file and a one-line pointer is typed", async () => {
        const path = scratch();
        await addPrompt({ name: "plan", text: "Plan for {{branch}}:\n1. read\n2. write", path });
        const deps = fakeDeps();
        const result = await sendPrompt({ name: "plan", session: SESSION, path, deps });

        expect(result.mode).toBe("file");
        expect(result.file).toBe("/tmp/hub-prompts-sent/2026-09-26T18-30-00-000Z-plan.md");
        expect(deps.written).toEqual([`${result.file}\nPlan for feat/cart:\n1. read\n2. write\n`]);
        expect(deps.sent).toEqual([`${SESSION} ${result.typed}`]);
        expect(result.typed).not.toContain("\n");
    });

    test("a failed send throws send-failed and does not count a use; a dry run sends nothing", async () => {
        const path = scratch();
        const failing = fakeDeps({ send: async () => "no cmux pane runs this session" });

        await expect(sendPrompt({ name: "rebase", session: SESSION, path, deps: failing })).rejects.toThrow(
            /no cmux pane/
        );
        expect(readPrompts(path).prompts.find((prompt) => prompt.name === "rebase")?.uses).toBe(0);

        const dry = fakeDeps();
        const result = await sendPrompt({ name: "rebase", session: SESSION, path, deps: dry, dryRun: true });
        expect(result).toMatchObject({ sent: false, dryRun: true });
        expect(dry.sent).toEqual([]);
    });
});
