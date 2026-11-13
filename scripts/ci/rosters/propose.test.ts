import { describe, expect, test } from "bun:test";
import { collectShapes, grepPattern, rankCandidates, scaffold, shadowedCandidates, shapesOf } from "./propose";
import { census } from "./propose-census";
import { collectPairs, rankPairs } from "./propose-pairs";

describe("shapesOf", () => {
    test("reads calls, imports, constructors and argv heads, and skips the noise", () => {
        const keys = (line: string) => shapesOf(line).map((shape) => `${shape.kind}:${shape.value}`);

        expect(keys("const socket = new Conn(url); await fs.unlinkSync(lock); if (x) { push(y) }")).toEqual([
            "call:fs.unlinkSync",
            "new:Conn",
        ]);
        expect(keys('import { select } from "@clack/prompts";')).toEqual(["import:@clack/prompts"]);
        expect(keys('await run(["launchctl", "load", plist]);')).toEqual(["call:run", "argv:launchctl"]);
        expect(keys('import { x } from "./local";')).toEqual([]);
    });
});

describe("collectShapes and rankCandidates", () => {
    const diff = [
        "--- a/src/a.ts",
        "+++ b/src/a.ts",
        "-    await legacyLoad(path);",
        "--- a/src/b.ts",
        "+++ b/src/b.ts",
        "-    await legacyLoad(other);",
        "--- a/src/c.ts",
        "+++ b/src/c.ts",
        "-    const v = legacyLoad(z);",
        "+    const v = loadThroughStore(z);",
        "--- a/src/utils/store.ts",
        "+++ b/src/utils/store.ts",
        "+    return legacyLoad(inner);",
        "--- a/src/d.test.ts",
        "+++ b/src/d.test.ts",
        "-    legacyLoad(fixture);",
    ].join("\n");

    test("a shape removed from three files and added back in one module is a candidate with that module", () => {
        const stats = collectShapes(diff, (file) => /\.test\.ts$/.test(file));
        const [first] = rankCandidates(stats, { minFiles: 3, remaining: () => 1 });

        expect(first.key).toBe("call:legacyLoad");
        expect(first.removedFiles).toBe(3);
        expect(first.addedIn).toEqual(["src/utils/store.ts"]);
        expect(first.remaining).toBe(1);
    });

    test("a shape that moved around as widely as it left is not a candidate", () => {
        const stats = collectShapes(diff, () => false);
        const keys = rankCandidates(stats, { minFiles: 1, remaining: () => 0 }).map((candidate) => candidate.key);

        expect(keys).not.toContain("call:loadThroughStore");
    });
});

describe("shadowedCandidates", () => {
    test("names the owner and counts the private copies, tests left out", () => {
        const candidates = shadowedCandidates({
            recommendations: [
                {
                    title: "isRecord",
                    sites: [
                        { file: "src/utils/object.ts", name: "isRecord", canonical: true },
                        { file: "src/a/x.ts", name: "isRecord" },
                        { file: "src/b/y.ts", name: "isRecord" },
                        { file: "src/b/y.test.ts", name: "isRecord" },
                    ],
                },
            ],
        });

        expect(candidates).toEqual([
            expect.objectContaining({ key: "declare:isRecord", addedIn: ["src/utils/object.ts"], remaining: 2 }),
        ]);
    });
});

describe("scaffold", () => {
    test("writes a definition with the matcher and the owner as allowedIn", () => {
        const text = scaffold({
            shape: { kind: "new", value: "Conn" },
            name: "cdp-conn-outside-connect",
            candidate: "C35",
            allowedIn: "src/chrome-devtools/lib/cdp.ts",
        });

        expect(text).toContain('name: "roster-cdp-conn-outside-connect"');
        expect(text).toContain('regex: "^Conn$"');
        expect(text).toContain("allowedIn: /^src\\/chrome-devtools\\/lib\\/cdp\\.ts$/");
    });
});

describe("collectPairs and rankPairs", () => {
    const usage = (files: number) => () => ({ files, matches: files });
    const swap = (file: string, from = "oldReadToken", to = "readVaultToken") => [
        `--- a/${file}`,
        `+++ b/${file}`,
        "@@ -1 +1 @@",
        `-    const token = ${from}(path);`,
        `+    const token = ${to}(path);`,
    ];

    test("a pair counts once per file, and more files rank first", () => {
        const diff = [
            ...swap("src/alpha/a.ts"),
            "@@ -9 +9 @@",
            "-    return oldReadToken(other);",
            "+    return readVaultToken(other);",
            ...swap("src/beta/b.ts"),
            ...swap("src/gamma/c.ts"),
            ...swap("src/delta/d.ts", "legacyPing", "pingThroughBus"),
            ...swap("src/omega/e.ts", "legacyPing", "pingThroughBus"),
        ].join("\n");
        const ranked = rankPairs(
            collectPairs(diff, () => false),
            {
                minFiles: 2,
                remaining: usage(1),
                owner: () => "src/utils/vault/token.ts",
            }
        );

        expect(ranked.map((pair) => [pair.key, pair.files])).toEqual([
            ["call:oldReadToken -> call:readVaultToken", 3],
            ["call:legacyPing -> call:pingThroughBus", 2],
        ]);
        expect(ranked[0].owner).toBe("src/utils/vault/token.ts");
    });

    test("a hunk with more than eight shapes on one side is a rewrite and gives no pair", () => {
        const removed = Array.from({ length: 9 }, (_, i) => `-    stepNumber${i}(value);`);
        const rewrite = (file: string) => [
            `--- a/${file}`,
            `+++ b/${file}`,
            "@@ -1,9 +1 @@",
            ...removed,
            "+    runAllSteps(value);",
        ];
        const diff = [...rewrite("src/a/x.ts"), ...rewrite("src/b/y.ts"), ...rewrite("src/c/z.ts")].join("\n");

        expect(collectPairs(diff, () => false).size).toBe(0);
        expect(collectPairs(diff, () => false, { maxShapes: 9 }).size).toBe(9);
    });
});

describe("census", () => {
    const osascript = 'await run(["osascript", "-e", script]);';

    test("names the module with most occurrences, its share and the files outside it", () => {
        const [first] = census(
            new Map([
                ["src/notes/a.ts", osascript],
                ["src/notes/lib/b.ts", `${osascript}\n${osascript}`],
                ["src/notes/lib/c.ts", osascript],
                ["src/clock/d.ts", osascript],
            ])
        );

        expect(first).toEqual(
            expect.objectContaining({
                key: "argv:osascript",
                owner: "src/notes/",
                share: 0.8,
                ownerFiles: 3,
                outliers: ["src/clock/d.ts"],
                fullyOwned: false,
                allowedIn: "^src\\/notes\\/",
            })
        );
    });

    test("a fully owned shape ranks before a wider shape with an outlier", () => {
        const files = new Map([
            ["src/radio/a.ts", 'const p = "radio-queue.jsonl";'],
            ["src/radio/b.ts", 'read("radio-queue.jsonl");'],
            ["src/radio/c.ts", 'write("radio-queue.jsonl");'],
            ...["e", "f", "g", "h", "i"].map((name): [string, string] => [`src/mail/${name}.ts`, osascript]),
            ["src/clock/z.ts", osascript],
        ]);

        expect(census(files).map((candidate) => candidate.key)).toEqual([
            "literal:radio-queue.jsonl",
            "argv:osascript",
        ]);
    });

    test("a generic or one-word file name is not a candidate", () => {
        const files = new Map(
            ["a", "b", "c", "d"].map((name): [string, string] => [
                `src/radio/${name}.ts`,
                'load("state.json"); load("package-lock.json"); load("queue.jsonl"); load("radio-queue.jsonl");',
            ])
        );

        expect(census(files).map((candidate) => candidate.key)).toEqual(["literal:radio-queue.jsonl"]);
    });

    test("a constructor counts only for a class imported from a package", () => {
        const shared = 'import { Player } from "@genesiscz/utils/audio/player";\nconst p = new Player();';
        const own = 'import { Deck } from "./deck";\nconst d = new Deck();';
        const pkg = 'import { Mixer } from "tone-mixer";\nconst m = new Mixer();';
        const files = new Map(
            ["a", "b", "c"].map((name): [string, string] => [`src/radio/${name}.ts`, `${shared}\n${own}\n${pkg}`])
        );

        expect(census(files).map((candidate) => candidate.key)).toEqual(["import:tone-mixer", "new:Mixer"]);
    });
});

describe("scaffold of a literal", () => {
    test("imports the literal helper and matches the exact file name, owned by a folder", () => {
        const text = scaffold({
            shape: { kind: "literal", value: "radio-queue.jsonl" },
            name: "radio-queue-outside-radio",
            candidate: "C90",
            allowedIn: "src/radio/",
        });

        expect(text).toContain('import { defineRoster, literal } from "./define";');
        expect(text).toContain("matcher: literal(/^radio-queue\\.jsonl$/),");
        expect(text).toContain("allowedIn: /^src\\/radio\\//,");
    });
});

describe("grepPattern: the tree count does not depend on the quote style", () => {
    test("an import or argv head matches with either quote, and a call keeps its parenthesis", () => {
        const imported = new RegExp(grepPattern({ kind: "import", value: "@genesiscz/utils/json" }));
        expect(imported.test('import { SafeJSON } from "@genesiscz/utils/json";')).toBe(true);
        expect(imported.test("import { SafeJSON } from '@genesiscz/utils/json';")).toBe(true);
        expect(imported.test('import { x } from "@genesiscz/utils/json5";')).toBe(false);
        const argv = new RegExp(grepPattern({ kind: "argv", value: "launchctl" }));
        expect(argv.test("spawn(['launchctl', 'list'])")).toBe(true);
        const call = new RegExp(grepPattern({ kind: "call", value: "fs.unlinkSync" }));
        expect(call.test("fs.unlinkSync(path)")).toBe(true);
        expect(call.test("fsXunlinkSync(path)")).toBe(false);
    });
});
