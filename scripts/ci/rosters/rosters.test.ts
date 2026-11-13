import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { copyNames, type FunctionFact, fingerprint, isDistinctName } from "@app/ts/lib/inventory";
import { Lang, parse } from "@ast-grep/napi";
import { maskSwiftNonCode } from "../lint-rules";
import adoFetchOutsideApi from "./ado-fetch-outside-api.definition";
import cdpSocketOutsideConnect from "./cdp-socket-outside-connect.definition";
import cmuxSendOutsideSurfaceInput from "./cmux-send-outside-surface-input.definition";
import cmuxTreeOutsideReader from "./cmux-tree-outside-reader.definition";
import type { RosterDefinition } from "./define";
import { callTo, importFrom, literal } from "./define";
import doctorDirectDelete from "./doctor-direct-delete.definition";
import { baseRosters, planRosters } from "./generate";
import { ROSTER_DEFINITIONS, ROSTERS_FILE, rosterGrowth } from "./index";
import launchctlOutsideLaunchdAgent from "./launchctl-outside-launchd-agent.definition";
import lockUnlinkOutsidePidfile from "./lock-unlink-outside-pidfile.definition";
import mcpProviderWriteOutsideCycle from "./mcp-provider-write-outside-cycle.definition";
import providerFetchOutsideExchange from "./provider-fetch-outside-exchange.definition";
import { SWIFT_ROSTERS, swiftRosterApplies, swiftRosterLines } from "./swift";
import {
    countByKey,
    FUNCTION_BODY_COPIED,
    SHARED_EXPORT_REDECLARED,
    TOOL_DEPENDENCY_ADDED,
    toolOf,
    unsuppressed,
} from "./tree";

function matches(definition: RosterDefinition, source: string): number {
    const root = parse(Lang.TypeScript, source).root();
    return root.findAll(definition.matcher).filter((node) => definition.test?.(node) ?? true).length;
}

describe("roster patterns", () => {
    test.each([
        [adoFetchOutsideApi, 'await fetch("https://dev.azure.com/x")', "await api.send(request)"],
        [providerFetchOutsideExchange, "return fetch(url, init)", "return this.fetch(url, init)"],
        [launchctlOutsideLaunchdAgent, 'spawn(["launchctl", "load", plist])', 'const label = "launchctl-like"'],
        [lockUnlinkOutsidePidfile, "unlinkSync(lockPath)", "unlinkSync(outputPath)"],
        [cmuxSendOutsideSurfaceInput, 'await runCmuxOk(["send", ...where, text])', 'z.enum(["send", "confirm"])'],
        [doctorDirectDelete, "await rm(path, { recursive: true })", "await removeByName(path)"],
        [cmuxTreeOutsideReader, 'await runCmux(["tree", "--all"])', 'runAx(["tree", "--app", app])'],
        [mcpProviderWriteOutsideCycle, "writeFileSync(path, text)", "process.stdout.write(text)"],
        [cdpSocketOutsideConnect, "const socket = new WebSocket(target.webSocketDebuggerUrl)", "connect(target, port)"],
    ])("%#: matches the pattern and not its look-alike", (definition, bad, good) => {
        expect(matches(definition, bad)).toBe(1);
        expect(matches(definition, good)).toBe(0);
    });

    test("every definition has a unique roster- name and a candidate", () => {
        const names = ROSTER_DEFINITIONS.map((definition) => definition.name);
        expect(new Set(names).size).toBe(names.length);

        for (const definition of ROSTER_DEFINITIONS) {
            expect(definition.name).toMatch(/^roster-[a-z0-9-]+$/);
            expect(definition.candidate).toMatch(/^[CF]\d+$/);
        }
    });
});

describe("planRosters", () => {
    test("seeds a new roster, lowers a count, drops a clean file and refuses growth", () => {
        const plan = planRosters(
            { "roster-a": { "src/one.ts": 2, "src/two.ts": 1 } },
            { "roster-a": { "src/one.ts": 1, "src/three.ts": 1 }, "roster-b": { "src/four.ts": 3 } }
        );

        expect(plan.next).toEqual({ "roster-a": { "src/one.ts": 1 }, "roster-b": { "src/four.ts": 3 } });
        expect(plan.grown).toEqual(["roster-a: src/three.ts has 1, the roster allows 0"]);
        expect(plan.shrunk).toEqual(["roster-a: src/one.ts 2 → 1", "roster-a: src/two.ts 1 → 0"]);
    });
});

describe("generate: an input it cannot read stops the run", () => {
    /** No GIT_DIR or GIT_INDEX_FILE from a hook that runs the tests, and no repository above the fixture. */
    const gitEnv = (dir: string): Record<string, string> => ({
        ...Object.fromEntries(
            Object.entries(process.env).filter(
                (entry): entry is [string, string] => !entry[0].startsWith("GIT_") && entry[1] !== undefined
            )
        ),
        GIT_CEILING_DIRECTORIES: dirname(dir),
    });

    test("a base before the manifest is no baseline, a base with it is read, an unknown ref throws", () => {
        const dir = mkdtempSync(join(tmpdir(), "rosters-base-"));
        const identity = ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.com"];
        const git = (...args: string[]) => {
            const run = spawnSync("git", ["-c", "core.hooksPath=/dev/null", ...identity, ...args], {
                cwd: dir,
                encoding: "utf8",
                env: gitEnv(dir),
            });
            expect(run.status, run.stderr).toBe(0);
            return run.stdout.trim();
        };

        try {
            git("init", "-q");
            writeFileSync(join(dir, "README.md"), "fixture\n");
            git("add", "README.md");
            git("commit", "-qm", "before the manifest");
            const before = git("rev-parse", "HEAD");
            mkdirSync(join(dir, "scripts/ci/rosters"), { recursive: true });
            writeFileSync(join(dir, ROSTERS_FILE), '{ "roster-a": { "src/one.ts": 2 } }\n');
            git("add", ROSTERS_FILE);
            git("commit", "-qm", "the manifest");

            expect(baseRosters(before, { cwd: dir })).toBeNull();
            expect(baseRosters("HEAD", { cwd: dir })).toEqual({ "roster-a": { "src/one.ts": 2 } });
            expect(() => baseRosters("origin/not-fetched", { cwd: dir })).toThrow("read --base origin/not-fetched");
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    }, 30_000);

    test("outside a repository the file list fails, the run exits 2 and the manifest keeps its counts", () => {
        const dir = mkdtempSync(join(tmpdir(), "rosters-nogit-"));
        const manifest = `{\n    "roster-ado-fetch-outside-api": {\n        "src/one.ts": 1\n    }\n}\n`;

        try {
            writeFileSync(join(dir, "biome.json"), "{}");
            mkdirSync(join(dir, "scripts/ci/rosters"), { recursive: true });
            writeFileSync(join(dir, ROSTERS_FILE), manifest);
            const run = spawnSync(process.execPath, [join(import.meta.dir, "generate.ts")], {
                cwd: dir,
                encoding: "utf8",
                env: gitEnv(dir),
            });

            expect(run.status, run.stdout).toBe(2);
            expect(run.stderr).toContain("git ls-files exited");
            expect(readFileSync(join(dir, ROSTERS_FILE), "utf8")).toBe(manifest);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    }, 60_000);
});

describe("rosterGrowth", () => {
    test("names an entry edited up by hand and lets a new roster in", () => {
        expect(
            rosterGrowth(
                { "roster-a": { "src/one.ts": 1 } },
                { "roster-a": { "src/one.ts": 2, "src/two.ts": 1 }, "roster-new": { "src/x.ts": 4 } }
            )
        ).toEqual(["roster-a: src/one.ts 1 → 2", "roster-a: src/two.ts 0 → 1"]);
    });
});

describe("tree rosters: what one file cannot show", () => {
    const fn = (over: Partial<FunctionFact>): FunctionFact => ({
        file: "src/port/lib/a.ts",
        line: 1,
        name: "helper",
        exported: false,
        fingerprint: "",
        ...over,
    });
    const record = (name: string) =>
        `{ return typeof ${name} === "object" && ${name} !== null && !Array.isArray(${name}); }`;
    const shared = [
        fn({ file: "src/utils/format.ts", name: "formatDuration", exported: true }),
        fn({ file: "src/utils/deep/nested/format.ts", name: "formatDuration", exported: true }),
        fn({
            file: "src/utils/object.ts",
            name: "isObject",
            exported: true,
            fingerprint: fingerprint(record("value"), ["value"]),
        }),
        fn({ file: "src/utils/text.ts", name: "walk", exported: true }),
    ];

    test("a body is the same when only parameter names, comments and spacing differ", () => {
        const a = fingerprint(record("value"), ["value"]);
        const b = fingerprint(
            `{\n    // is it a record?\n    return typeof v === "object" /* yes */ && v !== null && !Array.isArray(v);\n}`,
            ["v"]
        );

        expect(b).toBe(a);
        expect(a).toBe('1|{return typeof $0==="object"&&$0!==null&&!Array.isArray($0);}');
        // A property with a parameter's name, and the text of a string, are not the parameter.
        expect(fingerprint('{ return other.value + "value // not a comment"; }', ["value"])).toBe(
            '1|{return other.value+"value // not a comment";}'
        );
        expect(fingerprint(record("value"), ["value"])).not.toBe(
            fingerprint('{ return typeof value === "string"; }', ["value"])
        );
    });

    test("a name counts when it is two words, and a copy affix does not hide it", () => {
        expect(isDistinctName("formatDuration")).toBe(true);
        expect(isDistinctName("walk")).toBe(false);
        expect(isDistinctName("gitroot")).toBe(false);
        expect(copyNames("myParseTranscript")).toContain("parseTranscript");
        expect(copyNames("parseTranscriptLocal")).toContain("parseTranscript");
        expect(copyNames("parseTranscript2")).toContain("parseTranscript");
        expect(copyNames("_parseTranscript")).toContain("parseTranscript");
        // A component is not its lower-case namesake, and `local…` names what a function computes.
        expect(copyNames("RouterLink")).not.toContain("routerLink");
        expect(copyNames("localDaysBefore")).not.toContain("daysBefore");
    });

    test("the same name, and a renamed copy, outside the owner; never the owner or a one-word name", () => {
        const matches = SHARED_EXPORT_REDECLARED.scan({
            functions: [
                ...shared,
                fn({ name: "formatDuration", line: 3 }),
                fn({ name: "myFormatDuration", line: 9 }),
                fn({ file: "src/hub/lib/b.ts", name: "walk" }),
                fn({ file: "src/hub/lib/b.ts", name: "formatBytes" }),
            ],
            imports: [],
        });

        expect(matches.map((match) => [match.key, match.line, match.detail])).toEqual([
            ["src/port/lib/a.ts", 3, "formatDuration: exported from src/utils/format.ts"],
            [
                "src/port/lib/a.ts",
                9,
                "myFormatDuration: a renamed copy of formatDuration, exported from src/utils/format.ts",
            ],
        ]);
    });

    test("a copied body under another name names the shared owner; the owner itself is no finding", () => {
        const matches = FUNCTION_BODY_COPIED.scan({
            functions: [
                ...shared,
                fn({ name: "isJsonRecord", line: 20, fingerprint: fingerprint(record("input"), ["input"]) }),
                fn({
                    name: "isText",
                    line: 30,
                    fingerprint: fingerprint(
                        "{ return typeof input === 'string' && input.length > 0 && input.trim() !== ''; }",
                        ["input"]
                    ),
                }),
            ],
            imports: [],
        });

        expect(matches.map((match) => [match.file, match.line, match.detail])).toEqual([
            ["src/port/lib/a.ts", 20, "isJsonRecord: the body of isObject (src/utils/object.ts:1)"],
        ]);
    });

    test("a dependency is one entry per pair of tools; utils is free to import, and never free to import a tool", () => {
        const from = (file: string, target: string, line = 1) => ({ file, line, target });
        const matches = TOOL_DEPENDENCY_ADDED.scan({
            functions: [],
            imports: [
                from("src/hub/lib/a.ts", "src/question/lib/store"),
                from("src/hub/lib/b.ts", "src/question/lib/verbs", 7),
                from("src/hub/lib/a.ts", "src/hub/lib/b"),
                from("src/hub/lib/a.ts", "src/utils/json"),
                from("src/utils/agent-sessions/x.ts", "src/claude/lib/history/search", 4),
                from("src/single.ts", "src/hub/lib/a"),
            ],
        });

        expect(matches.map((match) => match.key)).toEqual(["hub → question", "utils → claude"]);
        expect(toolOf("src/hub/lib/a.ts")).toBe("hub");
        expect(toolOf("src/single.ts")).toBeNull();
        expect(countByKey(matches)).toEqual({ "hub → question": 1, "utils → claude": 1 });
    });

    test("a suppressed line is no match, and a new entry is growth the plan refuses", () => {
        const match = { key: "src/a.ts", file: "src/a.ts", line: 2, detail: "x" };

        expect(unsuppressed([match], () => "// lint-rules-ignore: wanted\nfunction x() {}")).toEqual([]);
        expect(unsuppressed([match], () => "\nfunction x() {}")).toEqual([match]);

        const plan = planRosters(
            { "roster-tool-dependency-added": { "hub → question": 1 } },
            { "roster-tool-dependency-added": { "hub → question": 1, "port → spotify": 1 } }
        );

        expect(plan.grown).toEqual(["roster-tool-dependency-added: port → spotify has 1, the roster allows 0"]);
        expect(plan.next["roster-tool-dependency-added"]).toEqual({ "hub → question": 1 });
    });

    test("the literal and import helpers match the whole text, in quotes and in a template", () => {
        const root = parse(
            Lang.TypeScript,
            'import axios from "axios";\nexport { x } from "axios";\nimport y from "axios-retry";\n' +
                'const z = await import("axios"); const w = load("axios");\n' +
                'const a = "refs.jsonl"; const b = `$' +
                '{dir}/refs.jsonl`; const c = "not-refs.jsonl";'
        ).root();

        expect(root.findAll(importFrom(/^axios$/)).map((node) => node.text())).toEqual([
            'import axios from "axios";',
            'export { x } from "axios";',
            'import("axios")',
        ]);
        expect(root.findAll(literal(/^refs\.jsonl$/)).map((node) => node.text())).toEqual(["refs.jsonl"]);
        expect(root.findAll(literal(/(?:^|\/)refs\.jsonl$/)).map((node) => node.text())).toEqual([
            "refs.jsonl",
            "/refs.jsonl",
        ]);
    });
});

describe("swift rosters", () => {
    const masks = (source: string) => ({
        code: maskSwiftNonCode(source).split("\n"),
        withStrings: maskSwiftNonCode(source, { keepStrings: true }).split("\n"),
    });
    const byName = (name: string) => {
        const roster = SWIFT_ROSTERS.find((item) => item.name === name);

        if (!roster) {
            throw new Error(`no roster ${name}`);
        }

        return roster;
    };

    test("a comment never counts; a string counts only for a roster that reads strings", () => {
        const source = [
            '// "GENESIS_TOOLS_HOME" and <script> in a comment',
            'let home = env["GENESIS_TOOLS_HOME"]',
            'let text = "NSPasteboard.general.setString( in a string"',
            'NSPasteboard.general.setString("x", forType: .string)',
            'let path = "\\(root)/.genesis-tools/app"',
        ].join("\n");
        const none = () => false;

        expect(
            swiftRosterLines(byName("roster-swift-genesis-tools-home-name-outside-owner"), masks(source), none)
        ).toEqual([{ line: 2, column: 16 }]);
        expect(swiftRosterLines(byName("roster-swift-pasteboard-copy-outside-clipboard"), masks(source), none)).toEqual(
            [{ line: 4, column: 1 }]
        );
        expect(
            swiftRosterLines(byName("roster-swift-hand-built-genesis-tools-path"), masks(source), none)
        ).toHaveLength(1);
        expect(swiftRosterLines(byName("roster-swift-inline-page-script"), masks(source), none)).toEqual([]);
        expect(
            swiftRosterLines(
                byName("roster-swift-genesis-tools-home-name-outside-owner"),
                masks(source),
                (line) => line === 2
            )
        ).toEqual([]);
    });

    test("the owner and the test targets are no findings", () => {
        const roster = byName("roster-swift-pasteboard-copy-outside-clipboard");

        expect(swiftRosterApplies(roster, "src/macos/GenesisKit/Sources/GenesisKitBase/Paths/Clipboard.swift")).toBe(
            false
        );
        expect(swiftRosterApplies(roster, "src/macos/GenesisTools/Tests/ClipboardTests.swift")).toBe(false);
        expect(swiftRosterApplies(roster, "src/macos/GenesisTools/Sources/Parts/Focus/FocusStudioView.swift")).toBe(
            true
        );
    });

    test("the comments-only mask keeps every column and line where it was", () => {
        const source = 'let a = "x // not a comment" // a comment\n/* block\n "still" */ let b = 1';
        const kept = maskSwiftNonCode(source, { keepStrings: true });

        expect(kept.length).toBe(source.length);
        expect(kept.split("\n")[0]).toBe(`let a = "x // not a comment" ${" ".repeat("// a comment".length)}`);
        expect(kept.split("\n")[2]?.endsWith("let b = 1")).toBe(true);
        expect(kept).not.toContain("still");
    });
});

describe("callTo: a rename at the import does not evade a roster", () => {
    test("an aliased import, a rebinding and a destructured rename are findings; a plain import and a lookalike are not", () => {
        const root = parse(
            Lang.TypeScript,
            [
                'import { acquireProvider as take, other } from "./pool";',
                'import { acquireProvider } from "./pool";',
                "const grab = pool.acquireProvider;",
                "const { acquireProvider: viaPattern } = pool;",
                "const result = acquireProviderFor(1);",
                "const text = pool.acquireProvider.name.length;",
                "acquireProvider(1);",
            ].join("\n")
        ).root();

        expect(root.findAll(callTo(["acquireProvider"])).map((node) => node.range().start.line + 1)).toEqual([
            1, 3, 4, 7,
        ]);
    });
});
