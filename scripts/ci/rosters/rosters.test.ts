import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { copyNames, type FunctionFact, fingerprint, isDistinctName } from "@app/ts/lib/inventory";
import { Lang, parse } from "@ast-grep/napi";
import { checkSource, maskSwiftNonCode, withinCountRatchets } from "../lint-rules";
import adoFetchOutsideApi from "./ado-fetch-outside-api.definition";
import appStatusOutsidePermissions from "./app-status-outside-permissions.definition";
import cdpConnOutsideConnect from "./cdp-conn-outside-connect.definition";
import cdpSocketOutsideConnect from "./cdp-socket-outside-connect.definition";
import chooseCostOutsidePricedUsage from "./choose-cost-outside-priced-usage.definition";
import clarityFillOutsideMonthFill from "./clarity-fill-outside-month-fill.definition";
import cmuxSendOutsideSurfaceInput from "./cmux-send-outside-surface-input.definition";
import cmuxTreeOutsideReader from "./cmux-tree-outside-reader.definition";
import cmuxTreeParseOutsideReader from "./cmux-tree-parse-outside-reader.definition";
import type { RosterDefinition } from "./define";
import { callTo, importFrom, literal } from "./define";
import doctorDirectDelete from "./doctor-direct-delete.definition";
import { baseRosters, planRosters, rosterFiles } from "./generate";
import { ROSTER_DEFINITIONS, ROSTERS_FILE, rosterGrowth } from "./index";
import launchctlOutsideLaunchdAgent from "./launchctl-outside-launchd-agent.definition";
import lockUnlinkOutsidePidfile from "./lock-unlink-outside-pidfile.definition";
import mcpBackupPromptOutsideCycle from "./mcp-backup-prompt-outside-cycle.definition";
import mcpProviderWriteOutsideCycle from "./mcp-provider-write-outside-cycle.definition";
import providerFetchOutsideExchange from "./provider-fetch-outside-exchange.definition";
import providerPoolOutsideLifecycle from "./provider-pool-outside-lifecycle.definition";
import questionItemsOutsideVerbs from "./question-items-outside-verbs.definition";
import sessionListingOutsideClaude from "./session-listing-outside-claude.definition";
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

interface RosterCase {
    definition: RosterDefinition;
    /** One planted violation: exactly one match. */
    bad: string;
    /** A look-alike that must pass. */
    good: string;
    /** The real owning file, which `allowedIn` lets hold the pattern; null for a roster without an owner. */
    owner: string | null;
    /** A new file the roster covers. */
    planted: string;
    /** What this case shows beyond the plain pattern. */
    form?: string;
}

const ROSTER_CASES: RosterCase[] = [
    {
        definition: adoFetchOutsideApi,
        bad: 'await fetch("https://dev.azure.com/x")',
        good: "await api.send(request)",
        owner: "src/azure-devops/api.ts",
        planted: "src/azure-devops/planted-roster.ts",
    },
    {
        definition: appStatusOutsidePermissions,
        bad: "const status = await appStatus(part);",
        good: "const status = await appStatusLabel(part);",
        owner: "src/macos/lib/permissions/app.ts",
        planted: "src/planted/roster.ts",
    },
    {
        definition: cdpConnOutsideConnect,
        bad: "const conn = new Conn(socket);",
        good: "const conn = await connect(target, port);",
        owner: "src/chrome-devtools/lib/cdp.ts",
        planted: "src/planted/roster.ts",
    },
    {
        definition: cdpSocketOutsideConnect,
        bad: "const socket = new WebSocket(target.webSocketDebuggerUrl)",
        good: "connect(target, port)",
        owner: "src/chrome-devtools/lib/cdp.ts",
        planted: "src/chrome-devtools/planted-roster.ts",
    },
    {
        definition: chooseCostOutsidePricedUsage,
        bad: "const cost = chooseCost(row);",
        good: "const cost = pricedUsage(row).cost;",
        owner: "src/utils/ai/usage/spend/priced-usage.ts",
        planted: "src/planted/roster.ts",
    },
    {
        definition: clarityFillOutsideMonthFill,
        bad: "const plan = planFill(month, weeks);",
        good: "const plan = await runMonthFill(month);",
        owner: "src/clarity/lib/month-fill.ts",
        planted: "src/planted/roster.ts",
    },
    {
        definition: cmuxSendOutsideSurfaceInput,
        bad: 'await runCmuxOk(["send", ...where, text])',
        good: 'z.enum(["send", "confirm"])',
        owner: "src/utils/cmux/surface-input.ts",
        planted: "src/planted/roster.ts",
    },
    {
        definition: cmuxSendOutsideSurfaceInput,
        form: "an argv kept in an object first, in a file that runs cmux",
        bad: 'const steps = [{ args: ["send-key", ...where, "enter"] }];\nawait runCmuxOk(steps[0].args);',
        good: 'import { runCmuxOk } from "./cmux";\nconst verb = z.enum(["send", "confirm"]);',
        owner: "src/utils/cmux/surface-input.ts",
        planted: "src/planted/roster.ts",
    },
    {
        definition: cmuxTreeOutsideReader,
        bad: 'await runCmux(["tree", "--all"])',
        good: 'runAx(["tree", "--app", app])',
        owner: "src/utils/cmux/tree-read.ts",
        planted: "src/planted/roster.ts",
    },
    {
        definition: cmuxTreeOutsideReader,
        form: "an argv kept in a constant first, as the owner keeps its own",
        bad:
            'import { runCmuxJSON } from "@genesiscz/utils/cmux/lib/cli";\n' +
            'const TREE_ARGS = ["--id-format", "both", "tree", "--all"] as const;\nawait run(TREE_ARGS);',
        good: 'const TREE_ARGS = ["tree", "--app", app];\nawait runAx(TREE_ARGS);',
        owner: "src/utils/cmux/tree-read.ts",
        planted: "src/planted/roster.ts",
    },
    {
        definition: cmuxTreeParseOutsideReader,
        bad: "const tree = parseCmuxTree(stdout);",
        good: "const tree = await readCmuxTree();",
        owner: "src/utils/cmux/live-layout.ts",
        planted: "src/planted/roster.ts",
    },
    {
        definition: doctorDirectDelete,
        bad: "await rm(path, { recursive: true })",
        good: "await removeByName(path)",
        owner: null,
        planted: "src/doctor/planted-roster.ts",
    },
    {
        definition: launchctlOutsideLaunchdAgent,
        bad: 'spawn(["launchctl", "load", plist])',
        good: 'const label = "launchctl-like"',
        owner: "src/utils/process/launchd-agent.ts",
        planted: "src/planted/roster.ts",
    },
    {
        definition: lockUnlinkOutsidePidfile,
        bad: "unlinkSync(lockPath)",
        good: "unlinkSync(outputPath)",
        owner: "src/utils/process/pidfile.ts",
        planted: "src/planted/roster.ts",
    },
    {
        definition: mcpBackupPromptOutsideCycle,
        bad: "const ok = await this.backupManager.askConfirmation(diff);",
        good: "const ok = await this.confirm(diff);",
        owner: "src/mcp-manager/utils/providers/types.ts",
        planted: "src/mcp-manager/planted-roster.ts",
    },
    {
        definition: mcpProviderWriteOutsideCycle,
        bad: "writeFileSync(path, text)",
        good: "process.stdout.write(text)",
        owner: "src/mcp-manager/utils/providers/types.ts",
        planted: "src/mcp-manager/utils/providers/planted-roster.ts",
    },
    {
        definition: providerFetchOutsideExchange,
        bad: "return fetch(url, init)",
        good: "return this.fetch(url, init)",
        owner: "src/ai-proxy/lib/providers/http-relay.ts",
        planted: "src/ai-proxy/lib/providers/planted-roster.ts",
    },
    {
        definition: providerPoolOutsideLifecycle,
        bad: "const provider = await acquireProvider(pool, model);",
        good: "const provider = await lifecycle.run(request);",
        owner: "src/ai-proxy/lib/request-lifecycle.ts",
        planted: "src/planted/roster.ts",
    },
    {
        definition: questionItemsOutsideVerbs,
        bad: "const items = splitItems(input);",
        good: "const items = await postQuestion(input);",
        owner: "src/question/lib/verbs.ts",
        planted: "src/planted/roster.ts",
    },
    {
        definition: sessionListingOutsideClaude,
        bad: "const sessions = await getSessionListing();",
        good: "const sessions = await listSessions({ limit: 5 });",
        owner: "src/claude/lib/history/search.ts",
        planted: "src/planted/roster.ts",
    },
];

describe("roster patterns", () => {
    test("every definition has a planted case", () => {
        expect(new Set(ROSTER_CASES.map((rosterCase) => rosterCase.definition.name))).toEqual(
            new Set(ROSTER_DEFINITIONS.map((definition) => definition.name))
        );
    });

    for (const { definition, bad, good, owner, planted, form } of ROSTER_CASES) {
        const title = form ? `${definition.name} (${form})` : definition.name;

        test(`${title}: matches the pattern and not its look-alike`, () => {
            expect(matches(definition, bad)).toBe(1);
            expect(matches(definition, good)).toBe(0);
        });

        test(`${title}: lint-rules fails a new file with it and names the file; the owner is no finding`, () => {
            const findings = (file: string) =>
                withinCountRatchets(checkSource(file, bad)).filter((finding) => finding.rule === definition.name);

            expect(findings(planted).map((finding) => finding.file)).toEqual([planted]);

            if (owner === null) {
                expect(definition.allowedIn).toBeUndefined();
                return;
            }

            expect([existsSync(owner), definition.allowedIn?.test(owner)]).toEqual([true, true]);
            expect(findings(owner)).toEqual([]);
            expect(rosterFiles(definition, [owner, planted])).toEqual([planted]);
        });
    }

    test.each([
        [cmuxTreeOutsideReader, "src/utils/cmux/tree-read.ts"],
        [cmuxSendOutsideSurfaceInput, "src/utils/cmux/surface-input.ts"],
    ])(
        "%#: the owner's own argv, copied to another file, is a finding there and none in the owner",
        (definition, owner) => {
            const source = readFileSync(owner, "utf8");
            const findings = (file: string) =>
                checkSource(file, source).filter((finding) => finding.rule === definition.name);

            expect(findings("src/planted/copy.ts").length).toBeGreaterThan(0);
            expect(findings(owner)).toEqual([]);
        }
    );

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
