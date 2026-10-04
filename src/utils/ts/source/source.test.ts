import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { calleeName, declarationsIn, importsIn, parseSource, unwrap, walk } from "@genesiscz/utils/ts/source/parse";
import { resolveSpecifier } from "@genesiscz/utils/ts/source/resolve";
import ts from "typescript";

describe("parseSource", () => {
    test("reports a syntax error instead of throwing, so an unparseable file cannot read as an empty one", () => {
        expect(parseSource("a.ts", "const a = {").errors).not.toHaveLength(0);
    });

    test("parses JSX under a .tsx name", () => {
        expect(parseSource("a.tsx", 'const a = <Foo bar="1" />;').errors).toHaveLength(0);
    });

    test("the same JSX under a .ts name is a syntax error, which is why the real path must be passed", () => {
        expect(parseSource("a.ts", 'const a = <Foo bar="1" />;').errors).not.toHaveLength(0);
    });
});

describe("declarationsIn", () => {
    const spansOf = (text: string, name: string) =>
        declarationsIn(parseSource("a.ts", text)).filter((span) => span.name === name);

    test("separates an overload signature from its implementation by hasBody", () => {
        const overloaded =
            "function s(a: number): void;\nfunction s(a: string): void;\nfunction s(a: unknown) {\n\tcall(a);\n}";
        const spans = spansOf(overloaded, "s");

        expect(spans.map((span) => span.hasBody)).toEqual([false, false, true]);
        expect(spans.find((span) => span.hasBody)).toMatchObject({ end: 5, start: 3 });
    });

    test("finds a declaration nested inside a call, which source.statements would miss", () => {
        expect(spansOf('describe("d", () => {\n\tconst helper = () => 1;\n});', "helper")).toHaveLength(1);
    });

    test("names a generator function, the shape most sagas take", () => {
        expect(spansOf("export function* loadSaga() {\n\tyield 1;\n}", "loadSaga")[0]).toMatchObject({
            hasBody: true,
            start: 1,
        });
    });
});

describe("importsIn", () => {
    const modulesOf = (text: string) => importsIn(parseSource("a.ts", text));

    test("reads every module specifier, deduplicated", () => {
        expect(
            modulesOf(
                'import { a } from "packages/x";\nimport { b } from "packages/x";\nimport { c } from "packages/y";'
            )
        ).toEqual(["packages/x", "packages/y"]);
    });

    test("counts a type-only import, because a missing path is still a broken edit", () => {
        expect(modulesOf('import type { A } from "packages/x";')).toEqual(["packages/x"]);
    });

    test("ignores a dynamic import, which cannot be resolved statically", () => {
        expect(modulesOf('const a = await import("packages/x");')).toEqual([]);
    });
});

describe("walk", () => {
    test("visits the node itself and every node below it, parents first", () => {
        const kinds: string[] = [];

        walk(parseSource("a.ts", "f(1);").source, (node) => kinds.push(ts.SyntaxKind[node.kind]));

        expect(kinds).toEqual([
            "SourceFile",
            "ExpressionStatement",
            "CallExpression",
            "Identifier",
            "FirstLiteralToken",
            "EndOfFileToken",
        ]);
    });
});

const firstCall = (text: string): ts.CallExpression => {
    let found: ts.CallExpression | undefined;

    walk(parseSource("a.ts", text).source, (node) => {
        if (found === undefined && ts.isCallExpression(node)) {
            found = node;
        }
    });

    if (found === undefined) {
        throw new Error(`no call in ${text}`);
    }

    return found;
};

describe("unwrap", () => {
    test("strips parentheses, `as`, `!` and an angle-bracket assertion, in any nesting", () => {
        const call = firstCall("f((<T>(x as U)!));");

        const [argument] = call.arguments;

        expect(argument && unwrap(argument).getText()).toBe("x");
    });
});

describe("calleeName", () => {
    test("names a plain call and the last segment of a member call", () => {
        expect(calleeName(firstCall("takeLatest(a, b);"))).toBe("takeLatest");
        expect(calleeName(firstCall("api.billings.getBills();"))).toBe("getBills");
    });

    test("looks through a wrapped callee", () => {
        expect(calleeName(firstCall("(select as Fn)(state);"))).toBe("select");
    });

    test("returns null for a callee that is neither a name nor a member access", () => {
        expect(calleeName(firstCall("factory()();"))).toBeNull();
    });
});

const files = (paths: string[]): ((path: string) => boolean) => {
    const set = new Set(paths);

    return (path) => set.has(path);
};

describe("resolveSpecifier", () => {
    test("joins a relative specifier to the importing file's folder", () => {
        const exists = files(["packages/a/actions/UserActions.ts"]);

        expect(
            resolveSpecifier({ exists, from: "packages/a/reducers/r.ts", specifier: "../actions/UserActions" })
        ).toBe("packages/a/actions/UserActions.ts");
    });

    test("takes a repository-root specifier as written", () => {
        const exists = files(["packages/a/Thing.tsx"]);

        expect(resolveSpecifier({ exists, from: "apps/web/src/x.ts", specifier: "packages/a/Thing" })).toBe(
            "packages/a/Thing.tsx"
        );
    });

    test("prefers the file over the folder of the same name", () => {
        const exists = files(["packages/a/actions.ts", "packages/a/actions/index.ts"]);

        expect(resolveSpecifier({ exists, from: "x.ts", specifier: "packages/a/actions" })).toBe(
            "packages/a/actions.ts"
        );
    });

    test("falls back to the folder's index", () => {
        const exists = files(["packages/a/actions/index.tsx"]);

        expect(resolveSpecifier({ exists, from: "x.ts", specifier: "packages/a/actions" })).toBe(
            "packages/a/actions/index.tsx"
        );
    });

    test("accepts a specifier that already names the file", () => {
        const exists = files(["packages/a/data.json"]);

        expect(resolveSpecifier({ exists, from: "packages/a/x.ts", specifier: "./data.json" })).toBe(
            "packages/a/data.json"
        );
    });

    test("returns null for a package name", () => {
        expect(
            resolveSpecifier({ exists: files(["packages/a/x.ts"]), from: "packages/a/x.ts", specifier: "react" })
        ).toBeNull();
    });

    test("returns null for a relative specifier when the importing file is unknown", () => {
        expect(resolveSpecifier({ exists: files(["x.ts"]), specifier: "./x" })).toBeNull();
    });
});

describe("package surface", () => {
    test("`@genesiscz/utils/ts/source` is a package export, and its barrel serves everything parse and resolve export", async () => {
        const manifest: unknown = SafeJSON.parse(
            readFileSync(join(import.meta.dir, "..", "..", "package.json"), "utf8")
        );
        const entry = "./ts/source/index.ts";

        expect(manifest).toMatchObject({ exports: { "./ts/source": { bun: entry, types: entry, default: entry } } });

        const barrel = Object.keys(await import("./index"));
        const parts = [...Object.keys(await import("./parse")), ...Object.keys(await import("./resolve"))];

        expect(barrel.sort()).toEqual(parts.sort());
    });
});
