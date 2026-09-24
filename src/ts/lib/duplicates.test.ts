import { describe, expect, it } from "bun:test";
import { declarationSimilarity, type FileSymbols, findDuplicates } from "./duplicates";
import { parseModule } from "./parse";
import { runRefactors } from "./refactors";
import { shadowedAnalyser } from "./refactors/shadowed";
import { parameterCount, parameterTypes, returnType, signatureSimilarity } from "./signature";
import { enrichSymbols, extractSkeleton, hashDeclaration, normalizeDeclaration, parseSource } from "./skeleton";
import type { ParsedModule } from "./types";

function entry(file: string, text: string, locals = false): FileSymbols {
    const source = parseSource(file, text);

    return { file, text, symbols: enrichSymbols(extractSkeleton(source, { locals }), text, { hash: true }) };
}

const REQUIRE_TOKEN = `async function requireToken(): Promise<string> {
\ttry {
\t\treturn await glab.getToken();
\t} catch (e) {
\t\tconsole.error(e instanceof Error ? e.message : String(e));
\t\tprocess.exit(1);
\t}
}
`;

describe("normalizeDeclaration", () => {
    it("blanks the declared name, so a renamed copy fingerprints the same", () => {
        const left = "function walk(dir: string) {\n\treturn walk(dir);\n}";
        const right = "function walkFiles(dir: string) {\n\treturn walkFiles(dir);\n}";

        expect(hashDeclaration(left, "walk")).toBe(hashDeclaration(right, "walkFiles"));
    });

    it("blanks a name that contains $, and never a name inside a longer $-identifier", () => {
        expect(hashDeclaration("const $el = () => $el.find();", "$el")).toBe(
            hashDeclaration("const $node = () => $node.find();", "$node")
        );
        expect(normalizeDeclaration("function foo() { return $foo + foo$bar; }", "foo")).toContain("$foo + foo$bar");
    });

    it("blanks only the declared name, so two different helpers stay different", () => {
        const left = "function a(x: number) {\n\treturn x + 1;\n}";
        const right = "function b(x: number) {\n\treturn x * 2;\n}";

        expect(hashDeclaration(left, "a")).not.toBe(hashDeclaration(right, "b"));
    });

    it("drops comments, so a re-worded doc block is not a difference", () => {
        expect(normalizeDeclaration("// one\nconst a = 1;", "a")).toBe(
            normalizeDeclaration("/* two */\nconst a = 1;", "a")
        );
    });
});

describe("findDuplicates", () => {
    it("groups an identical helper copied across files", () => {
        const report = findDuplicates(
            [
                entry("src/a/one.ts", REQUIRE_TOKEN),
                entry("src/a/two.ts", REQUIRE_TOKEN),
                entry("src/a/three.ts", REQUIRE_TOKEN),
            ],
            { recommend: true }
        );

        expect(report.groups).toHaveLength(1);
        expect(report.groups[0]?.reason).toBe("identical");
        expect(report.groups[0]?.copies).toBe(3);
        expect(report.groups[0]?.canonical?.file).toBe("src/a/one.ts");
        // No copy lives in a shared module, so the edit is a lift, not "import from src/a/one.ts".
        expect(report.groups[0]?.action).toContain("no copy lives in a shared module");
    });

    it("finds a copy that was renamed", () => {
        const report = findDuplicates([
            entry("src/a/one.ts", REQUIRE_TOKEN),
            entry("src/a/two.ts", REQUIRE_TOKEN.replace(/requireToken/g, "mustHaveToken")),
        ]);

        expect(report.groups[0]?.names.sort()).toEqual(["mustHaveToken", "requireToken"]);
    });

    it("ignores a declaration under the line floor", () => {
        const report = findDuplicates(
            [
                entry("src/a/one.ts", "const id = (x: number) => x;\n"),
                entry("src/a/two.ts", "const id = (x: number) => x;\n"),
            ],
            { minLines: 3 }
        );

        expect(report.groups).toHaveLength(0);
        expect(report.suppressed.tooSmall).toBe(2);
    });

    it("keeps a group whose copies share one name inside one directory", () => {
        // 🛑 `requireToken` five times in `src/gitlab/commands/` is the defect this tool was
        // written for. A directory-only pattern rule suppressed it, which is why the rule
        // also requires the copies to carry their own names.
        const report = findDuplicates([
            entry("src/gitlab/commands/a.ts", REQUIRE_TOKEN),
            entry("src/gitlab/commands/b.ts", REQUIRE_TOKEN),
            entry("src/gitlab/commands/c.ts", REQUIRE_TOKEN),
            entry("src/gitlab/commands/d.ts", REQUIRE_TOKEN),
        ]);

        expect(report.groups).toHaveLength(1);
        expect(report.groups[0]?.pattern).toBe(false);
    });

    it("suppresses a numbered family of sibling files", () => {
        const suite = (id: string) =>
            `export function suite${id}() {\n` +
            `\tconst page = openPage();\n\tawait page.signIn(user);\n\tawait page.openSection("detail");\n` +
            `\tawait page.expectVisible("header");\n\tawait page.expectVisible("table");\n` +
            `\tawait page.click("${id}");\n\tawait page.close();\n}\n`;
        const report = findDuplicates([
            entry("src/specs/40302.e2e.ts", suite("40302")),
            entry("src/specs/40303.e2e.ts", suite("40303")),
        ]);

        expect(report.groups).toHaveLength(0);
        expect(report.suppressed.patterns).toBe(1);
    });

    it("suppresses a method that a family of classes all implement", () => {
        const screen = (name: string) =>
            `export class ${name} {\n\tasync waitForVisible(): Promise<void> {\n\t\tawait this.root.waitForDisplayed();\n\t\treturn;\n\t}\n}\n`;
        const report = findDuplicates([
            entry("src/pages/a/AScreen.ts", screen("AScreen")),
            entry("src/pages/b/BScreen.ts", screen("BScreen")),
            entry("src/pages/c/CScreen.ts", screen("CScreen")),
            entry("src/pages/d/DScreen.ts", screen("DScreen")),
        ]);

        expect(report.groups.some((group) => group.names.includes("waitForVisible"))).toBe(false);
        expect(report.suppressed.patterns).toBeGreaterThan(0);
    });

    it("never lists members of a hidden pattern as a same-name collision of different code", () => {
        const screen = (name: string) =>
            `export class ${name} {\n\tasync waitForVisible(): Promise<void> {\n\t\tawait this.root.waitForDisplayed();\n\t\treturn;\n\t}\n}\n`;
        const report = findDuplicates(
            ["A", "B", "C", "D"].map((id) => entry(`src/pages/${id}Screen.ts`, screen(`${id}Screen`))),
            { nameCollisions: true }
        );

        expect(report.suppressed.patterns).toBeGreaterThan(0);
        expect(report.collisions.some((collision) => collision.name === "waitForVisible")).toBe(false);
    });

    it("does not treat identical file names or a .types suffix as a naming family", () => {
        // Four `index.ts` files share every letter of their name, which read as a family and
        // hid four differently named copies of one helper.
        const helper = (name: string) =>
            `export function ${name}(path: string): string {\n\tconst text = readFileSync(path, "utf8");\n\tconst lines = text.split("\\n");\n\treturn lines.filter(Boolean).join(",");\n}\n`;
        const indexes = findDuplicates(
            ["a", "b", "c", "d"].map((id) => entry(`src/${id}/index.ts`, helper(`read${id.toUpperCase()}`)))
        );
        const types = findDuplicates(
            ["api", "user", "order", "cart"].map((id) => entry(`src/${id}.types.ts`, helper(`read${id}`)))
        );

        expect(indexes.groups).toHaveLength(1);
        expect(types.groups).toHaveLength(1);
    });

    it("never recommends a vendored copy as the home", () => {
        const report = findDuplicates(
            [
                entry("src/utils/vendor/profile.ts", REQUIRE_TOKEN.replace("async function", "export async function")),
                entry("src/utils/profile.ts", REQUIRE_TOKEN.replace("async function", "export async function")),
            ],
            { recommend: true }
        );

        expect(report.groups[0]?.canonical?.file).toBe("src/utils/profile.ts");
    });

    it("lists a same-name collision only when it is not already a duplicate group", () => {
        const report = findDuplicates(
            [
                entry("src/a/one.ts", "function main() {\n\tstart();\n\trunA();\n}\n"),
                entry("src/b/two.ts", "function main() {\n\tconfigure();\n\tserve(8080);\n}\n"),
            ],
            { nameCollisions: true }
        );

        expect(report.groups).toHaveLength(0);
        expect(report.collisions[0]?.name).toBe("main");
    });
});

describe("signature shape", () => {
    it("reads the parameter types and the return type", () => {
        const signature = "export function git(cwd: string, args: string[]): string";

        expect(parameterCount(signature)).toBe(2);
        expect(parameterTypes(signature)).toEqual(["string", "string[]"]);
        expect(returnType(signature)).toBe("string");
    });

    it("does not close the list at the arrow of a callback-typed parameter", () => {
        const signature = "function f(cb: (x: number) => void, y: string): string";

        expect(parameterCount(signature)).toBe(2);
        expect(parameterTypes(signature)).toEqual(["(x:number)=>void", "string"]);
        expect(returnType(signature)).toBe("string");
    });

    it("counts no parameters for an empty list", () => {
        expect(parameterCount("function stamp(): string")).toBe(0);
    });

    it("separates a rewritten helper from an unrelated name-sharer", () => {
        // 🛑 Body similarity cannot do this. Measured on a sibling repo: the two `git` helpers
        // score 8% on bodies and two unrelated `renderMarkdown` functions score 2%.
        const gitHome = "export function git(cwd: string, args: string[]): string";
        const gitCopy = "const git = (dir: string, args: string[]): string";
        const renderHome =
            "export function renderMarkdown(json: string, opts: RenderMarkdownOpts): RenderMarkdownResult";
        const renderOther = "function renderMarkdown(data: ReturnType<typeof scan>, stamp: string): string";

        expect(signatureSimilarity(gitHome, gitCopy)).toBeGreaterThan(0.5);
        expect(signatureSimilarity(renderHome, renderOther)).toBeLessThan(0.5);
    });
});

describe("declarationSimilarity", () => {
    it("is 1 for the same code under two names", () => {
        expect(
            declarationSimilarity(
                { text: REQUIRE_TOKEN, name: "requireToken" },
                { text: REQUIRE_TOKEN.replace(/requireToken/g, "needToken"), name: "needToken" }
            )
        ).toBe(1);
    });
});

describe("shadowed", () => {
    const run = (files: { file: string; text: string }[]) => {
        const entries = files.map(({ file, text }) => entry(file, text));
        const modules = new Map<string, ParsedModule>(
            files.map(({ file, text }) => [file, parseModule(text, file)] as const)
        );

        return runRefactors([shadowedAnalyser], { entries, modules, options: {} }).recommendations;
    };

    const HOME = "export function git(cwd: string, args: string[]): string {\n\treturn run(cwd, args).stdout;\n}\n";
    const COPY =
        "const git = (dir: string, args: string[]): string => {\n\treturn execFileSync('git', args, { cwd: dir });\n};\n";

    it("names the shared home a private copy ignored", () => {
        const found = run([
            { file: "src/utils/gitHelper.ts", text: HOME },
            { file: "src/feature/thing.ts", text: COPY },
        ]);

        expect(found).toHaveLength(1);
        expect(found[0]?.title).toContain("src/utils/gitHelper.ts");
        expect(found[0]?.sites[0]?.canonical).toBe(true);
    });

    it("says nothing when the file already imports the shared helper", () => {
        const found = run([
            { file: "src/utils/gitHelper.ts", text: HOME },
            { file: "src/feature/thing.ts", text: `import { git } from "../utils/gitHelper";\n${COPY}` },
        ]);

        expect(found).toHaveLength(0);
    });

    it("ignores an unrelated declaration that only shares the name", () => {
        // 🛑 `data` exported from a kit module was reported as "redefined 34 times" by a
        // fixture object of the same name in every e2e spec.
        const found = run([
            {
                file: "src/utils/kit.ts",
                text: "export function data<T>(raw: unknown): T | undefined {\n\treturn raw as T;\n}\n",
            },
            { file: "src/specs/one.ts", text: "const data = {\n\tid: 1,\n\tname: 'x',\n};\n" },
        ]);

        expect(found).toHaveLength(0);
    });

    it("matches a copy against the shared home it actually resembles", () => {
        // 🛑 Keeping one home per name and breaking the tie by body length pointed every
        // `git` copy at an unrelated async `git` and dropped all of them.
        const found = run([
            {
                file: "src/update/lib/recovery.ts",
                text: "export async function git(args: string[], cwd: string): Promise<{ code: number }> {\n\treturn spawn(args, cwd);\n}\n",
            },
            { file: "src/utils/gitHelper.ts", text: HOME },
            { file: "src/feature/thing.ts", text: COPY },
        ]);

        expect(found).toHaveLength(1);
        expect(found[0]?.title).toContain("src/utils/gitHelper.ts");
    });

    it("never reports one exported home as a copy of another", () => {
        const found = run([
            { file: "src/utils/gitHelper.ts", text: HOME },
            { file: "src/shared/git.ts", text: HOME.replace("run(cwd, args)", "exec(cwd, args)") },
        ]);

        expect(found).toHaveLength(0);
    });
});

describe("extractSkeleton locals", () => {
    const source = "function outer() {\n\tconst read = (f: string) => load(f);\n\treturn read('x');\n}\n";

    it("skips a declaration inside a function body by default", () => {
        expect(extractSkeleton(parseSource("f.ts", source)).map((symbol) => symbol.name)).toEqual(["outer"]);
    });

    it("collects it and flags it as local when asked", () => {
        const symbols = extractSkeleton(parseSource("f.ts", source), { locals: true });

        expect(symbols.map((symbol) => symbol.name)).toEqual(["outer", "read"]);
        expect(symbols[1]?.local).toBe(true);
    });
});

describe("enrichSymbols", () => {
    const source =
        "export function pick(n: number): number {\n\tconst a = n + 1;\n\tconst b = a * 2;\n\treturn b;\n}\n";

    it("attaches the first lines of the body for --function-context", () => {
        const symbols = enrichSymbols(extractSkeleton(parseSource("f.ts", source)), source, { functionContext: 2 });

        expect(symbols[0]?.body).toEqual(["\tconst a = n + 1;", "\tconst b = a * 2;"]);
        expect(symbols[0]?.bodyTruncated).toBe(true);
    });

    it("costs nothing when neither field was asked for", () => {
        const plain = extractSkeleton(parseSource("f.ts", source));

        expect(enrichSymbols(plain, source, {})).toBe(plain);
    });
});
