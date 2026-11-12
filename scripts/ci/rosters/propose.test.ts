import { describe, expect, test } from "bun:test";
import { collectShapes, rankCandidates, scaffold, shadowedCandidates, shapesOf } from "./propose";

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
