import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
    buildCommandIndex,
    type CommandIndex,
    checkRef,
    checkTree,
    exemptFromHardcodedScan,
    findHardcodedToolCommands,
    findToolCommandRefs,
} from "./check-tool-commands";

const fakeIndex: CommandIndex = {
    hasTool: (tool) => tool === "macos" || tool === "notify",
    alias: (tool) => (tool === "calendar" ? ["macos", "calendar"] : undefined),
    commandWords: (tool) => new Set(tool === "macos" ? ["permissions", "build", "calendar", "doctor"] : ["status"]),
};

describe("findToolCommandRefs", () => {
    test("finds a toolCommand literal with its line", () => {
        const text = 'const a = 1;\nout.info(`Run ${toolCommand("macos permissions build")}`);';

        expect(findToolCommandRefs("x.ts", text)).toEqual([
            { file: "x.ts", line: 2, command: "macos permissions build", via: "toolCommand" },
        ]);
    });

    test("finds the tools path of a suggestCommand literal", () => {
        const text = 'suggestCommand("tools notify status", { add: ["--json"] })';

        expect(findToolCommandRefs("x.ts", text)).toEqual([
            { file: "x.ts", line: 1, command: "notify status", via: "suggestCommand" },
        ]);
    });

    test("skips a path built at runtime", () => {
        expect(findToolCommandRefs("x.ts", "toolCommand(`${tool} status`)")).toEqual([]);
    });

    test("reads the literal head of a suggestCommand template up to the first value", () => {
        const text = "suggestCommand(`tools notify status ${name} --yes`);\nsuggestCommand(`tools notify sta${x}`);";

        expect(findToolCommandRefs("x.ts", text)).toEqual([
            { file: "x.ts", line: 1, command: "notify status", via: "suggestCommand" },
            { file: "x.ts", line: 2, command: "notify", via: "suggestCommand" },
        ]);
    });

    // A renamed subcommand inside replaceCommand went unnoticed: only the tool name was read.
    test("adds the leading command words of replaceCommand to a suggestCommand path", () => {
        const text = 'suggestCommand("tools macos", {\n    replaceCommand: ["permissions", "build", "--force"],\n})';

        expect(findToolCommandRefs("x.ts", text)).toEqual([
            { file: "x.ts", line: 1, command: "macos permissions build --force", via: "suggestCommand" },
        ]);
    });

    test("stops reading replaceCommand at the first element that is not a string literal", () => {
        const text = 'suggestCommand("tools macos", { replaceCommand: [sub, "build"] })';

        expect(findToolCommandRefs("x.ts", text)[0]?.command).toBe("macos");
    });

    test("resolves a tool name held in a const of the same file", () => {
        const text = 'const TOOL = "tools notify";\nsuggestCommand(TOOL, { replaceCommand: ["status"] })';

        expect(findToolCommandRefs("x.ts", text)).toEqual([
            { file: "x.ts", line: 2, command: "notify status", via: "suggestCommand" },
        ]);
    });
});

describe("checkRef", () => {
    const ref = (command: string) => ({ file: "x.ts", line: 3, command, via: "toolCommand" as const });

    test("accepts a command whose tool and subcommands exist", () => {
        expect(checkRef(ref("macos permissions build"), fakeIndex)).toBeNull();
    });

    test("rejects a tool that does not exist", () => {
        expect(checkRef(ref("mac permissions"), fakeIndex)).toContain("x.ts:3");
    });

    test("rejects a subcommand that is not registered under the tool", () => {
        expect(checkRef(ref("macos permission build"), fakeIndex)).toContain('"permission"');
    });

    test("resolves a dispatcher alias before checking the subcommands", () => {
        expect(checkRef(ref("calendar doctor"), fakeIndex)).toBeNull();
    });

    test("stops at the first word that is not a command word", () => {
        expect(checkRef(ref("macos permissions <pane>"), fakeIndex)).toBeNull();
    });
});

describe("checkTree", () => {
    function tree(files: Record<string, string>): string {
        const root = mkdtempSync(join(tmpdir(), "check-tool-commands-"));

        for (const [path, text] of Object.entries(files)) {
            mkdirSync(dirname(join(root, path)), { recursive: true });
            writeFileSync(join(root, path), text);
        }

        return root;
    }

    // The guard must catch the rename it exists for: `foo bar` renamed to `foo baz`.
    test("reports a reference to a renamed subcommand", () => {
        const root = tree({
            tools: "const TOOL_ALIASES = new Map([]);",
            "src/foo/index.ts": 'program.command("baz");',
            "src/other/index.ts": 'out.info(toolCommand("foo bar"));',
        });

        const errors = checkTree(root, ["src/foo/index.ts", "src/other/index.ts"]);

        expect(errors).toHaveLength(1);
        expect(errors[0]).toContain("src/other/index.ts:1");
    });

    test("accepts a group built by a helper and a lazy registrar key", () => {
        const root = tree({
            tools: "const TOOL_ALIASES = new Map([]);",
            "src/foo/index.ts":
                'const REGISTRARS = {\n    clones: async () => (await import("x")).register,\n};\nprogram.addCommand(buildGroup("apfs"));',
            "src/other/index.ts": 'toolCommand("foo clones"); toolCommand("foo apfs");',
        });

        expect(checkTree(root, ["src/foo/index.ts", "src/other/index.ts"])).toEqual([]);
    });

    // `tools cc` has no commander program: it routes argv by hand against a SUBCOMMANDS set.
    test("accepts a subcommand a hand-routed tool lists in its SUBCOMMANDS set, and still rejects others", () => {
        const root = tree({
            tools: "const TOOL_ALIASES = new Map([]);",
            "src/foo/index.ts": 'const SUBCOMMANDS = new Set([\n    "run",\n    "resume",\n]);',
            "src/other/index.ts": 'toolCommand("foo run");\ntoolCommand("foo gone");',
        });

        const errors = checkTree(root, ["src/foo/index.ts", "src/other/index.ts"]);

        expect(errors).toHaveLength(1);
        expect(errors[0]).toContain("src/other/index.ts:2");
    });

    test("accepts a command registered in a @genesiscz/utils module the tool imports", () => {
        const root = tree({
            tools: "const TOOL_ALIASES = new Map([]);",
            "src/foo/index.ts": 'import { registerConfig } from "@genesiscz/utils/eval/config-cli";',
            "src/utils/eval/config-cli.ts": 'program.command("config");',
            "src/other/index.ts": 'toolCommand("foo config");',
        });

        expect(checkTree(root, ["src/foo/index.ts", "src/other/index.ts"])).toEqual([]);
    });

    test("accepts a command registered behind a @genesiscz/utils barrel's re-export", () => {
        const root = tree({
            tools: "const TOOL_ALIASES = new Map([]);",
            "src/foo/index.ts": 'import { defineApp } from "@genesiscz/utils/App";',
            "src/utils/App/index.ts": 'export { registerAppCommands } from "./commander";',
            "src/utils/App/commander.ts": 'cmd.command("up");',
            "src/other/index.ts": 'toolCommand("foo up");',
        });

        expect(checkTree(root, ["src/foo/index.ts", "src/other/index.ts"])).toEqual([]);
    });

    test("matches a tool folder whatever its letter case, as the macOS dispatcher does", () => {
        const root = tree({
            tools: "const TOOL_ALIASES = new Map([]);",
            "src/Internal/index.ts": 'program.command("reas");',
            "src/other/index.ts": 'suggestCommand("tools internal reas");',
        });

        expect(checkTree(root, ["src/Internal/index.ts", "src/other/index.ts"])).toEqual([]);
    });

    test("stops at the positional values of a command that declares arguments", () => {
        const root = tree({
            tools: "const TOOL_ALIASES = new Map([]);",
            "src/foo/index.ts":
                'notify.command("set")\n    .argument("<channel>")\n    .action(run);\nprofile.command("add <name>");',
            "src/other/index.ts": 'toolCommand("foo set say"); toolCommand("foo add me");',
        });

        expect(checkTree(root, ["src/foo/index.ts", "src/other/index.ts"])).toEqual([]);
    });

    test("still rejects a renamed word before the positional values", () => {
        const root = tree({
            tools: "const TOOL_ALIASES = new Map([]);",
            "src/foo/index.ts": 'notify.command("put").argument("<channel>");',
            "src/other/index.ts": 'toolCommand("foo set say");',
        });

        expect(checkTree(root, ["src/foo/index.ts", "src/other/index.ts"])).toHaveLength(1);
    });

    test("accepts a command named by a dashboard registry entry", () => {
        const root = tree({
            tools: "const TOOL_ALIASES = new Map([]);",
            "src/foo/index.ts": 'registerDashboard({ type: "ui", commandName: "ui" });',
            "src/other/index.ts": 'toolCommand("foo ui");',
        });

        expect(checkTree(root, ["src/foo/index.ts", "src/other/index.ts"])).toEqual([]);
    });

    test("passes a tree whose references all exist", () => {
        const root = tree({
            tools: "const TOOL_ALIASES = new Map([]);",
            "src/foo/index.ts": 'program.command("baz <id>");',
            "src/other/index.ts": 'out.info(toolCommand("foo baz"));',
        });

        expect(checkTree(root, ["src/foo/index.ts", "src/other/index.ts"])).toEqual([]);
    });
});

describe("buildCommandIndex on this repository", () => {
    test("knows the macos tool and its permissions command", () => {
        const index = buildCommandIndex(join(import.meta.dir, "..", ".."));

        expect(index.hasTool("macos")).toBe(true);
        expect(index.commandWords("macos").has("permissions")).toBe(true);
    });
});

describe("findHardcodedToolCommands", () => {
    const isTool = (name: string) => name === "macos" || name === "notify";
    const lines = (file: string, text: string) => findHardcodedToolCommands(file, text, isTool).map((hit) => hit.line);

    test("reports a string that names a command without a helper", () => {
        expect(lines("a.ts", 'const a = 1;\nout.info("Run `tools macos permissions build`");')).toEqual([2]);
    });

    test("reports the text parts of a template", () => {
        expect(lines("a.ts", "out.info(`Run ${x}, then tools notify status`);")).toEqual([1]);
    });

    test("reports JSX text", () => {
        expect(lines("a.tsx", "const a = <p>Run tools notify status</p>;")).toEqual([1]);
    });

    test("leaves the tools-name argument of suggestCommand alone", () => {
        expect(lines("a.ts", 'suggestCommand("tools notify", { add: ["--json"] });')).toEqual([]);
    });

    test("leaves a suggestCommand template argument alone, value parts included", () => {
        expect(lines("a.ts", "suggestCommand(`tools notify status ${name} --yes ${more} tools notify`);")).toEqual([]);
    });

    test("leaves prose where the next word is not a tool, comments, and a -tools suffix alone", () => {
        expect(
            lines("a.ts", '// tools notify\nconst a = "dev tools are fine";\nconst b = "genesis-tools notify";')
        ).toEqual([]);
    });
});

describe("exemptFromHardcodedScan", () => {
    test.each([
        ["src/artifact/runtime/starters/dashboard.tsx", true],
        ["src/utils/shell/fix/test.data.ts", true],
        ["src/jev/lib/grep/evaluations/budget/cases.ts", true],
        ["src/notify/index.ts", false],
        ["src/artifact/index.ts", false],
    ])("%s -> %p", (path, exempt) => {
        expect(exemptFromHardcodedScan(path)).toBe(exempt);
    });
});

describe("findHardcodedToolCommands ignore marker", () => {
    // A sentence that happens to contain "tools <tool>" as prose can opt out, with a reason.
    test("skips a line carrying the check-tool-commands-ignore marker", () => {
        const text = 'const a = "the tools notify banner"; // check-tool-commands-ignore: prose, not a command';

        expect(findHardcodedToolCommands("a.ts", text, (name) => name === "notify")).toEqual([]);
    });
});
