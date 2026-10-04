import { describe, expect, it, spyOn } from "bun:test";
import { logger } from "@genesiscz/utils/logger";
import jscodeshift, { type ASTPath, type Collection, type JSXAttribute, type JSXElement } from "jscodeshift";
import * as guards from "./guards";
import {
    addOrUpdateImport,
    applyConditionalTransformations,
    areElementsIdentical,
    ComponentNode,
    consolidateImportsFromModule,
    copyAttributes,
    createAutoLogger,
    ensureEnumImports,
    ensureTypeImport,
    extractPropToChildren,
    findJSXAttribute,
    getAllImports,
    getJSXAttributeValue,
    getPropValue,
    hasImport,
    ImportConflictResolver,
    ImportManagerImpl,
    ImportManagerMemoryImpl,
    isBooleanJsxAttribute,
    isPropertyKey,
    moveImports,
    movePropToNestedObject,
    processJSXElements,
    removeImportsFromModule,
    setJSXAttribute,
    setPropValue,
    type TransformContext,
    transformImports,
    transformJSXComponent,
    updateTypeReferences,
    WarningCollector,
    wrapComponent,
} from "./index";
import { getRecastOptions } from "./recast-options";

const j = jscodeshift.withParser("tsx");

/** Source with whitespace runs collapsed, so assertions do not depend on where recast breaks lines. */
function flat(source: string): string {
    return source.replace(/\s+/g, " ").trim();
}

function elementPath(root: Collection, name: string): ASTPath<JSXElement> {
    const path = root
        .find(j.JSXElement)
        .paths()
        .find((p) => p.node.openingElement.name.type === "JSXIdentifier" && p.node.openingElement.name.name === name);
    if (!path) {
        throw new Error(`fixture has no <${name}>`);
    }

    return path;
}

function element(root: Collection, name: string): JSXElement {
    return elementPath(root, name).node;
}

function firstAttribute(source: string): JSXAttribute {
    const attr = j(source).find(j.JSXAttribute).nodes()[0];
    if (!attr) {
        throw new Error(`fixture has no attribute: ${source}`);
    }

    return attr;
}

describe("createAutoLogger", () => {
    it("records every reported change as an entry for its file", () => {
        const log = createAutoLogger();

        log.importChange("a.tsx", "ui-lib", "Button", "added", "as Btn");
        log.componentRename("a.tsx", "OldCard", "Card");
        log.propChange("b.tsx", "Card", "elevated", "removed");
        log.typeChange("b.tsx", "OldProps", "renamed", "CardProps");
        log.warning("c.tsx", "spread props left as is");
        log.debug("c.tsx", "[Imports] scan() found 2 import declarations");

        expect(log.entries).toEqual([
            { kind: "import", file: "a.tsx", message: "added import Button (ui-lib)", details: "as Btn" },
            { kind: "component", file: "a.tsx", message: "renamed component OldCard -> Card" },
            { kind: "prop", file: "b.tsx", message: "removed prop elevated on Card" },
            { kind: "type", file: "b.tsx", message: "renamed type OldProps -> CardProps" },
            { kind: "warning", file: "c.tsx", message: "spread props left as is" },
            { kind: "debug", file: "c.tsx", message: "[Imports] scan() found 2 import declarations" },
        ]);
    });
});

describe("getRecastOptions", () => {
    it("maps a supplied formatter config instead of the default one", () => {
        const options = getRecastOptions({
            arrowParens: "avoid",
            bracketSpacing: false,
            endOfLine: "crlf",
            jsxBracketSameLine: false,
            jsxSingleQuote: false,
            trailingComma: "none",
            printWidth: 100,
            singleQuote: true,
            semi: true,
            tabWidth: 2,
            useTabs: false,
        });

        expect(options).toEqual({
            quote: "single",
            trailingComma: false,
            tabWidth: 2,
            useTabs: false,
            wrapColumn: 100,
            objectCurlySpacing: false,
            arrowParensAlways: false,
            lineTerminator: "\r\n",
            flowObjectCommas: true,
            arrayBracketSpacing: false,
            reuseWhitespace: false,
        });
    });

    it("prints trailing commas for Prettier's trailingComma all, not only es5", () => {
        const options = getRecastOptions({
            arrowParens: "always",
            bracketSpacing: true,
            endOfLine: "lf",
            jsxBracketSameLine: false,
            jsxSingleQuote: false,
            trailingComma: "all",
            printWidth: 120,
            singleQuote: false,
            semi: true,
            tabWidth: 4,
            useTabs: false,
        });

        expect(options.trailingComma).toBe(true);
    });

    it("defaults to tabs, 4 wide, 140 columns, double quotes, trailing commas", () => {
        expect(getRecastOptions()).toEqual({
            quote: "double",
            trailingComma: true,
            tabWidth: 4,
            useTabs: true,
            wrapColumn: 140,
            objectCurlySpacing: true,
            arrowParensAlways: true,
            lineTerminator: "\n",
            flowObjectCommas: true,
            arrayBracketSpacing: false,
            reuseWhitespace: false,
        });
    });
});

// ============================================================================
// guards
// ============================================================================

/** First node of the given AST type in `source`, so the guards are fed real parser output. */
function nodeOf(source: string, type: string): unknown {
    const found = j(source)
        .find(j.Node)
        .filter((path) => path.node.type === type)
        .nodes();

    if (!found[0]) {
        throw new Error(`fixture produced no ${type}: ${source}`);
    }

    return found[0];
}

const SAMPLES: Array<{ guard: (node: unknown) => boolean; source: string; type: string }> = [
    { guard: guards.isJSXExpressionContainer, source: "const a = <A b={c} />;", type: "JSXExpressionContainer" },
    { guard: guards.isJSXAttribute, source: 'const a = <A b="c" />;', type: "JSXAttribute" },
    { guard: guards.isJSXElement, source: "const a = <A />;", type: "JSXElement" },
    { guard: guards.isJSXIdentifier, source: "const a = <A />;", type: "JSXIdentifier" },
    { guard: guards.isJSXOpeningElement, source: "const a = <A />;", type: "JSXOpeningElement" },
    { guard: guards.isJSXSpreadAttribute, source: "const a = <A {...b} />;", type: "JSXSpreadAttribute" },
    { guard: guards.isIdentifier, source: "const a = b;", type: "Identifier" },
    { guard: guards.isMemberExpression, source: "const a = b.c;", type: "MemberExpression" },
    { guard: guards.isCallExpression, source: "const a = b();", type: "CallExpression" },
    { guard: guards.isObjectExpression, source: "const a = {};", type: "ObjectExpression" },
    { guard: guards.isConditionalExpression, source: "const a = b ? c : d;", type: "ConditionalExpression" },
    { guard: guards.isTemplateLiteral, source: "const a = `x`;", type: "TemplateLiteral" },
    { guard: guards.isBlockStatement, source: "function a() { return 1; }", type: "BlockStatement" },
    { guard: guards.isVariableDeclaration, source: "const a = 1;", type: "VariableDeclaration" },
    { guard: guards.isVariableDeclarator, source: "const a = 1;", type: "VariableDeclarator" },
    { guard: guards.isFunctionExpression, source: "const a = function () {};", type: "FunctionExpression" },
    { guard: guards.isArrowFunctionExpression, source: "const a = () => 1;", type: "ArrowFunctionExpression" },
    { guard: guards.isFunctionDeclaration, source: "function a() {}", type: "FunctionDeclaration" },
    { guard: guards.isImportDeclaration, source: 'import a from "b";', type: "ImportDeclaration" },
    { guard: guards.isImportSpecifier, source: 'import { a } from "b";', type: "ImportSpecifier" },
    { guard: guards.isObjectPattern, source: "const { a } = b;", type: "ObjectPattern" },
    { guard: guards.isTSTypeAnnotation, source: "let a: string;", type: "TSTypeAnnotation" },
    { guard: guards.isTSTypeReference, source: "let a: Foo;", type: "TSTypeReference" },
    { guard: guards.isOptionalMemberExpression, source: "const a = b?.c;", type: "OptionalMemberExpression" },
];

describe("ast guards accept the node they name", () => {
    for (const { guard, source, type } of SAMPLES) {
        it(`${guard.name} accepts a parsed ${type}`, () => {
            expect(guard(nodeOf(source, type))).toBe(true);
        });
    }
});

describe("ast guards reject what they do not name", () => {
    const identifier = nodeOf("const a = b;", "Identifier");

    for (const { guard } of SAMPLES.filter((s) => s.guard !== guards.isIdentifier)) {
        it(`${guard.name} rejects an Identifier`, () => {
            expect(guard(identifier)).toBeFalsy();
        });
    }
});

describe("ast guards survive the absent node", () => {
    // a codemod walks optional fields constantly (`attr.value`, `spec.imported`), so every guard is
    // called with null and undefined in practice; throwing there aborts a whole file's transform
    for (const [name, guard] of Object.entries(guards)) {
        it(`${name} returns falsy for null and undefined instead of throwing`, () => {
            expect(guard(null)).toBeFalsy();
            expect(guard(undefined)).toBeFalsy();
        });
    }
});

describe("literal guards accept both parser spellings", () => {
    // the tsx parser emits StringLiteral/NumericLiteral/BooleanLiteral, older parsers emit Literal
    it("isStringLiteral accepts StringLiteral and a string-valued Literal", () => {
        expect(guards.isStringLiteral(nodeOf('const a = "x";', "StringLiteral"))).toBe(true);
        expect(guards.isStringLiteral({ type: "Literal", value: "x" })).toBe(true);
        expect(guards.isStringLiteral({ type: "Literal", value: 1 })).toBeFalsy();
    });

    it("isNumericLiteral accepts NumericLiteral and a number-valued Literal", () => {
        expect(guards.isNumericLiteral({ type: "NumericLiteral", value: 1 })).toBe(true);
        expect(guards.isNumericLiteral({ type: "Literal", value: 1 })).toBe(true);
        expect(guards.isNumericLiteral({ type: "Literal", value: "1" })).toBeFalsy();
    });

    it("isBooleanLiteral accepts BooleanLiteral and a boolean-valued Literal", () => {
        expect(guards.isBooleanLiteral({ type: "BooleanLiteral", value: true })).toBe(true);
        expect(guards.isBooleanLiteral({ type: "Literal", value: false })).toBe(true);
        expect(guards.isBooleanLiteral({ type: "Literal", value: 0 })).toBeFalsy();
    });

    it("isLiteral accepts every literal spelling but not a template", () => {
        expect(guards.isLiteral({ type: "Literal", value: null })).toBe(true);
        expect(guards.isLiteral({ type: "NumericLiteral", value: 1 })).toBe(true);
        expect(guards.isLiteral({ type: "TemplateLiteral" })).toBeFalsy();
    });

    it("isProperty accepts both Property and ObjectProperty spellings", () => {
        expect(guards.isProperty({ type: "Property" })).toBe(true);
        expect(guards.isProperty({ type: "ObjectProperty" })).toBe(true);
        expect(guards.isProperty({ type: "SpreadElement" })).toBeFalsy();
    });
});

describe("composite guards", () => {
    it("hasJSXExpressionValue is true only when the attribute holds an expression container", () => {
        expect(guards.hasJSXExpressionValue(firstAttribute("const a = <A b={c} />;"))).toBe(true);
        expect(guards.hasJSXExpressionValue(firstAttribute('const a = <A b="c" />;'))).toBe(false);
    });

    it("hasJSXExpressionValue is false for a bare boolean attribute, whose value is null", () => {
        expect(guards.hasJSXExpressionValue(firstAttribute("const a = <A b />;"))).toBe(false);
    });

    it("isPropertyWithIdentifierKey separates an identifier key from a quoted one", () => {
        expect(
            guards.isPropertyWithIdentifierKey({ type: "ObjectProperty", key: { type: "Identifier", name: "a" } })
        ).toBe(true);
        expect(
            guards.isPropertyWithIdentifierKey({ type: "ObjectProperty", key: { type: "StringLiteral", value: "a" } })
        ).toBeFalsy();
    });
});

// ============================================================================
// JSX helpers
// ============================================================================

describe("JSX attribute helpers", () => {
    it("getJSXAttributeValue reads a quoted string and a braced string literal only", () => {
        const el = element(j(`const a = <Card a="x" b={"y"} c={z} d />;`), "Card");
        const read = (name: string) => {
            const attr = findJSXAttribute(el.openingElement, name);
            return attr ? getJSXAttributeValue(attr) : "missing";
        };

        expect([read("a"), read("b"), read("c"), read("d"), read("e")]).toEqual([
            "x",
            "y",
            undefined,
            undefined,
            "missing",
        ]);
    });

    it("setJSXAttribute updates a present prop, removes one set to null, adds a missing one", () => {
        const root = j(`const a = <Card a="x" b="y" />;`);
        const opening = element(root, "Card").openingElement;

        setJSXAttribute(j, opening, "a", "changed");
        setJSXAttribute(j, opening, "b", null);
        setJSXAttribute(j, opening, "c", "new");

        expect(flat(root.toSource())).toBe(`const a = <Card a="changed" c="new" />;`);
    });

    it("isBooleanJsxAttribute is true for a bare prop and a boolean literal, false for a string", () => {
        const el = element(j(`const a = <Card a b={false} c="true" />;`), "Card");
        const attrs = (el.openingElement.attributes ?? []).filter((a): a is JSXAttribute => a.type === "JSXAttribute");

        expect(attrs.map((a) => isBooleanJsxAttribute(j, a))).toEqual([true, true, false]);
    });

    it("areElementsIdentical compares names and literal prop values in order", () => {
        const root = j(`const a = [<Card a="x" b />, <Card a="x" b />, <Card a="y" b />, <Card b a="x" />];`);
        const [first, same, otherValue, otherOrder] = root.find(j.JSXElement).nodes();
        if (!first || !same || !otherValue || !otherOrder) {
            throw new Error("fixture needs four elements");
        }

        // a bare prop has no literal value, so it never compares equal
        expect(areElementsIdentical(j, first, same)).toBe(false);

        const root2 = j(`const a = [<Card a="x" b={true} />, <Card a="x" b={true} />, <Card a="y" b={true} />];`);
        const [x1, x2, y] = root2.find(j.JSXElement).nodes();
        if (!x1 || !x2 || !y) {
            throw new Error("fixture needs three elements");
        }

        expect([areElementsIdentical(j, x1, x2), areElementsIdentical(j, x1, y)]).toEqual([true, false]);
    });
});

describe("transformJSXComponent", () => {
    it("renames both tags, renames props, and adds only props that are missing", () => {
        const root = j(`const a = <OldCard tone="x" kind="a">body</OldCard>;`);

        const changed = transformJSXComponent(j, element(root, "OldCard"), {
            renameTo: "Card",
            renameProps: { tone: "variant" },
            addProps: { kind: "b", size: "md" },
        });

        expect(changed).toBe(true);
        expect(flat(root.toSource())).toBe(`const a = <Card variant="x" kind="a" size="md">body</Card>;`);
    });

    it("removing the children prop empties the element and self-closes it", () => {
        const root = j(`const a = <Card title="t">body</Card>;`);

        transformJSXComponent(j, element(root, "Card"), { removeProps: ["children", "title"] });

        expect(flat(root.toSource())).toBe("const a = <Card />;");
    });

    it("reports no change when a prop transformer returns the same value", () => {
        const root = j(`const a = <Card size="md" />;`);

        expect(transformJSXComponent(j, element(root, "Card"), { transformProps: { size: (v) => v } })).toBe(false);
        expect(
            transformJSXComponent(j, element(root, "Card"), {
                transformProps: { size: (v) => (v === "md" ? "medium" : v) },
            })
        ).toBe(true);
        expect(flat(root.toSource())).toBe(`const a = <Card size="medium" />;`);
    });

    it("wraps a value in Boolean() unless it already reads as a boolean", () => {
        const root = j(
            "const a = <Card open={count} visible={isOpen} active={items.includes(x)} done={true} ok={Boolean(n)} />;"
        );

        transformJSXComponent(j, element(root, "Card"), {
            ensurePropsAreBoolean: ["open", "visible", "active", "done", "ok"],
        });

        expect(flat(root.toSource())).toBe(
            "const a = <Card open={Boolean(count)} visible={isOpen} active={items.includes(x)} done={true} ok={Boolean(n)} />;"
        );
    });

    it("moves a prop into a nested object prop", () => {
        const root = j(`const a = <Field label="Name" id="f" />;`);

        transformJSXComponent(j, element(root, "Field"), {
            movePropsToNested: { label: { targetProp: "inputProps", nestedProp: "label" } },
        });

        expect(flat(root.toSource())).toBe(`const a = <Field id="f" inputProps={{ label: "Name" }} />;`);
    });

    it("keeps the prop and warns when the target prop holds something other than an object literal", () => {
        const root = j(
            `const a = [<Card label="foo" fieldProps={props} />, <Field label="bar" inputProps={props} />];`
        );
        const warn = spyOn(logger, "warn").mockImplementation(() => {});

        try {
            expect(movePropToNestedObject(j, element(root, "Card"), "label", "fieldProps", "label")).toBe(false);
            expect(
                transformJSXComponent(j, element(root, "Field"), {
                    movePropsToNested: { label: { targetProp: "inputProps", nestedProp: "label" } },
                })
            ).toBe(false);
            expect(warn).toHaveBeenCalledTimes(2);
        } finally {
            warn.mockRestore();
        }

        expect(flat(root.toSource())).toBe(
            `const a = [<Card label="foo" fieldProps={props} />, <Field label="bar" inputProps={props} />];`
        );
    });
});

describe("JSX element helpers", () => {
    it("extractPropToChildren turns a string prop into the element's text", () => {
        const root = j(`const a = <Button label="Save" />;`);

        expect(extractPropToChildren(j, element(root, "Button"), "label")).toBe(true);
        expect(flat(root.toSource())).toBe("const a = <Button>Save</Button>;");
    });

    it("wrapComponent nests the element inside a wrapper with string props", () => {
        const root = j("const a = <Card />;");
        const wrapped = wrapComponent(j, element(root, "Card"), "Box", { gap: "2" });
        root.find(j.JSXElement).at(0).replaceWith(wrapped);

        expect(flat(root.toSource())).toBe(`const a = <Box gap="2"><Card /></Box>;`);
    });

    it("copyAttributes copies only the named props the target lacks", () => {
        const root = j(`const a = [<From a="1" b="2" c="3" />, <To b="keep" />];`);

        copyAttributes(j, element(root, "From"), element(root, "To"), ["a", "b"]);

        expect(flat(root.toSource())).toBe(`const a = [<From a="1" b="2" c="3" />, <To b="keep" a="1" />];`);
    });

    it("processJSXElements calls back only for the listed component names", () => {
        const root = j("const a = <div><Card /><Panel /><Other /></div>;");
        const seen: string[] = [];

        const changed = processJSXElements(j, root, ["Card", "Panel"], (_el, name) => {
            seen.push(name);
            return name === "Panel";
        });

        expect(seen).toEqual(["Card", "Panel"]);
        expect(changed).toBe(true);
    });

    it("isPropertyKey is true for a non-computed object key or member property only", () => {
        const root = j("const o = { key: key }; o.key; o[key];");
        const flags = root
            .find(j.Identifier, { name: "key" })
            .paths()
            .map((p) => isPropertyKey(p));

        expect(flags).toEqual([true, false, true, false]);
    });
});

// ============================================================================
// Import helpers
// ============================================================================

describe("import helpers", () => {
    it("transformImports moves named imports, renaming a component's local binding but not a utility's", () => {
        const root = j(`import { Text, styled, Box } from "old-ui";\nconst a = <Text />;`);

        const changed = transformImports(j, root, [
            {
                fromModule: "old-ui",
                namedImports: {
                    Text: { rename: "Label", toModule: "new-ui" },
                    styled: { rename: "makeStyled", toModule: "new-ui" },
                },
            },
        ]);

        expect(changed).toBe(true);
        expect(flat(root.toSource())).toBe(
            `import { Box } from "old-ui"; import { Label, makeStyled as styled } from "new-ui"; const a = <Text />;`
        );
    });

    it("transformImports turns a default import into a named one in another module", () => {
        const root = j(`import Btn from "old-ui";\nconst a = <Btn />;`);

        transformImports(j, root, [{ fromModule: "old-ui", defaultImport: { toNamed: "Button", toModule: "new-ui" } }]);

        expect(flat(root.toSource())).toBe(`import { Button as Btn } from "new-ui"; const a = <Btn />;`);
    });

    it("transformImports turns a default import into a named one of the same module, keeping its binding", () => {
        const root = j(`import Btn from "ui";\nimport Def, { Card } from "ui-lib";\nconst a = <Btn />;`);

        transformImports(j, root, [
            { fromModule: "ui", defaultImport: { toNamed: "Button" } },
            { fromModule: "ui-lib", defaultImport: { toNamed: "Panel" } },
        ]);

        expect(flat(root.toSource())).toBe(
            `import { Button as Btn } from "ui"; import { Panel as Def, Card } from "ui-lib"; const a = <Btn />;`
        );
    });

    it("transformImports removes a whole module and renames another", () => {
        const root = j(`import { a } from "gone";\nimport { b } from "old-path";\nb(a);`);

        transformImports(j, root, [
            { fromModule: "gone", removeAll: true },
            { fromModule: "old-path", toModule: "new-path" },
        ]);

        expect(flat(root.toSource())).toBe(`import { b } from "new-path"; b(a);`);
    });

    it("transformImports reports no change when no import matches", () => {
        const root = j(`import { a } from "m";`);

        expect(transformImports(j, root, [{ fromModule: "other", removeAll: true }])).toBe(false);
    });

    it("addOrUpdateImport merges into the module's import and sorts by imported name", () => {
        const root = j(`import { Zeta, alpha } from "m";`);

        addOrUpdateImport(j, root, "m", new Map([["Beta", "Beta"]]));

        expect(flat(root.toSource())).toBe(`import { alpha, Beta, Zeta } from "m";`);
    });

    it("addOrUpdateImport keeps default and namespace imports, adding beside a namespace import instead of into it", () => {
        const root = j(`import React from "react";\nimport * as UI from "ui-lib";\nconst a = 1;`);

        addOrUpdateImport(j, root, "react", new Map([["useState", "useState"]]));
        addOrUpdateImport(j, root, "ui-lib", new Map([["Card", "Card"]]));

        expect(flat(root.toSource())).toBe(
            `import React, { useState } from "react"; import * as UI from "ui-lib"; import { Card } from "ui-lib"; const a = 1;`
        );
    });

    it("addOrUpdateImport adds a name once, to one declaration, and skips a name the module already imports", () => {
        const root = j(`import { x } from "m";\nimport { y } from "m";\nimport type { T } from "m";`);

        addOrUpdateImport(
            j,
            root,
            "m",
            new Map([
                ["z", "z"],
                ["y", "y"],
                ["T", "T"],
            ])
        );

        expect(flat(root.toSource())).toBe(
            `import { x, z } from "m"; import { y } from "m"; import type { T } from "m";`
        );
    });

    it("moveImports into a module with a default import keeps that default binding", () => {
        const root = j(`import { a } from "from";\nimport Def, { x } from "to";`);

        moveImports(j, root, "from", "to", new Set(["a"]));

        expect(flat(root.toSource())).toBe(`import Def, { a, x } from "to";`);
    });

    it("consolidateImportsFromModule merges value and type imports separately", () => {
        const root = j(
            `import { b } from "m";\nimport type { T } from "m";\nimport Def, { a } from "m";\nimport type { S } from "m";`
        );

        expect(consolidateImportsFromModule(j, root, "m")).toBe(true);
        expect(flat(root.toSource())).toBe(`import Def, { a, b } from "m"; import type { S, T } from "m";`);
    });

    it("moveImports moves and renames named imports, keeping their local names", () => {
        const root = j(`import { a, b, c } from "from";\nimport { x } from "to";`);

        const moved = moveImports(j, root, "from", "to", new Set(["a", "b"]), new Map([["a", "aa"]]));

        expect(Object.fromEntries(moved)).toEqual({ a: "a", b: "b" });
        expect(flat(root.toSource())).toBe(`import { c } from "from"; import { aa as a, b, x } from "to";`);
    });

    it("removeImportsFromModule returns what it removed and drops the emptied declaration", () => {
        const root = j(`import { a, b as bee } from "m";\nimport { c } from "n";`);

        const removed = removeImportsFromModule(j, root, "m", new Set(["a", "b"]));

        expect(Object.fromEntries(removed)).toEqual({ a: "a", b: "bee" });
        expect(flat(root.toSource())).toBe(`import { c } from "n";`);
    });

    it("getAllImports lists named and default local names, not namespaces", () => {
        const root = j(`import D, { a, b as c } from "m";\nimport * as ns from "n";`);

        expect([...getAllImports(j, root)].sort()).toEqual(["D", "a", "c"]);
        expect([hasImport(j, root, "m", "b"), hasImport(j, root, "m", "c")]).toEqual([true, false]);
    });

    it("updateTypeReferences renames type references and their import", () => {
        const root = j(`import { OldProps } from "m";\nlet p: OldProps;`);

        expect(updateTypeReferences(j, root, { OldProps: "CardProps" })).toBe(true);
        expect(flat(root.toSource())).toBe(`import { CardProps } from "m"; let p: CardProps;`);
    });

    it("ensureTypeImport imports a referenced type once and ignores an unreferenced one", () => {
        const root = j("let p: CardProps;");

        expect(ensureTypeImport(j, root, "Unused", "m")).toBe(false);
        expect(ensureTypeImport(j, root, "CardProps", "m")).toBe(true);
        expect(ensureTypeImport(j, root, "CardProps", "m")).toBe(false);
        expect(flat(root.toSource())).toBe(`import { CardProps } from "m"; let p: CardProps;`);
    });

    it("ensureEnumImports imports each enum PropValue from its module", () => {
        const root = j("const a = 1;");

        ensureEnumImports(j, root, [
            { type: "enum", name: "Size", value: "LG", namedImportFrom: "ui-lib" },
            { type: "enum", name: "Tone", value: "MUTED" },
            "plain",
        ]);

        expect(flat(root.toSource())).toBe(`import { Size } from "ui-lib"; const a = 1;`);
    });
});

describe("PropValue helpers", () => {
    it("setPropValue writes enum, expression and identifier values, and removes a prop for null", () => {
        const root = j(`const a = <Card old="x" />;`);
        const opening = element(root, "Card").openingElement;

        setPropValue(j, opening, "size", { type: "enum", name: "Size", value: "LARGE" });
        setPropValue(j, opening, "total", { type: "expression", code: "count + 1" });
        setPropValue(j, opening, "label", { type: "identifier", name: "title" });
        setPropValue(j, opening, "old", null);

        expect(flat(root.toSource())).toBe("const a = <Card size={Size.LARGE} total={count + 1} label={title} />;");
    });

    it("getPropValue reads strings, booleans, identifiers and Enum.MEMBER back as PropValues", () => {
        const opening = element(
            j(`const a = <Card a="x" b={false} c={title} d={Size.LG} e={1 + 1} />;`),
            "Card"
        ).openingElement;

        expect(["a", "b", "c", "d", "e"].map((name) => getPropValue(opening, name))).toEqual([
            "x",
            false,
            { type: "identifier", name: "title" },
            { type: "enum", name: "Size", value: "LG" },
            undefined,
        ]);
    });

    it("applyConditionalTransformations applies only the transformations whose condition holds", () => {
        const root = j(`const a = <Card variant="flat" />;`);
        const el = element(root, "Card");

        const result = applyConditionalTransformations(j, el, [
            {
                condition: (e) => getPropValue(e.openingElement, "variant") === "flat",
                renameTo: "Panel",
                setProps: [{ propName: "elevated", value: false }],
                removeProps: ["variant"],
            },
            { condition: () => false, renameTo: "Never" },
        ]);

        expect(flat(root.toSource())).toBe("const a = <Panel elevated={false} />;");
        expect(result).toEqual({
            hasChanges: true,
            changes: [
                { type: "rename", newName: "Panel" },
                { type: "setProp", propName: "elevated", value: false },
                { type: "removeProp", propName: "variant" },
            ],
        });
    });
});

describe("WarningCollector", () => {
    it("has warnings only after one is added", () => {
        const warnings = new WarningCollector();
        expect(warnings.hasWarnings()).toBe(false);

        warnings.add("a.tsx", "left as is");
        expect(warnings.hasWarnings()).toBe(true);
    });
});

// ============================================================================
// ImportManagerImpl
// ============================================================================

function importManager(source: string) {
    const root = j(source);
    const log = createAutoLogger();
    const imports = new ImportManagerImpl(j, root, log, { path: "file.tsx", source });
    return { root, log, imports };
}

describe("ImportManagerImpl", () => {
    it("ensureImport merges into the module's existing named import", () => {
        const { root, imports } = importManager(`import { A } from "ui";`);

        expect(imports.ensureImport("ui", "B")).toEqual({ localName: "B" });
        expect(flat(root.toSource())).toBe(`import { A, B } from "ui";`);
    });

    it("ensureImport reports the change to the logger under the file's path", () => {
        const { log, imports } = importManager(`import { A } from "ui";`);

        imports.ensureImport("ui", "B");

        expect(log.entries).toContainEqual({
            kind: "import",
            file: "file.tsx",
            message: "ensure import B (ui)",
            details: "",
        });
    });

    it("ensureImport adds an aliased declaration after the last import", () => {
        const { root, imports } = importManager(`import x from "other";\nconst a = 1;`);

        expect(imports.ensureImport("ui", "Button", "Btn")).toEqual({ localName: "Btn" });
        expect(flat(root.toSource())).toBe(`import x from "other"; import { Button as Btn } from "ui"; const a = 1;`);
    });

    it("ensureImport does not merge into a type-only or namespace import", () => {
        const { root, imports } = importManager(`import type { T } from "ui";\nimport * as UI from "ui";`);

        imports.ensureImport("ui", "A");

        expect(flat(root.toSource())).toBe(
            `import type { T } from "ui"; import * as UI from "ui"; import { A } from "ui";`
        );
    });

    it("ensureImport removes another module's import of the same local name", () => {
        const { root, imports } = importManager(`import { Card } from "old";\nimport { X } from "ui";`);

        imports.ensureImport("ui", "Card");

        expect(flat(root.toSource())).toBe(`import { X, Card } from "ui";`);
    });

    it("removeImport drops a named or default specifier and keeps side-effect imports", () => {
        const { root, imports } = importManager(`import "./styles.css";\nimport Def, { a, b } from "m";`);

        imports.removeImport("m", "a");
        imports.removeImport("m", "default");

        expect(flat(root.toSource())).toBe(`import "./styles.css"; import { b } from "m";`);
    });

    it("consolidate merges value and type declarations per module and skips namespace modules", () => {
        const { root, imports } = importManager(
            `import { a } from "m";\nimport Def from "m";\nimport type { T } from "m";\nimport type { U } from "m";\nimport * as NS from "n";\nimport { b } from "n";`
        );

        imports.applyChanges();

        expect(flat(root.toSource())).toBe(
            `import Def, { a } from "m"; import type { T, U } from "m"; import * as NS from "n"; import { b } from "n";`
        );
    });

    it("resolveImportRename moves a named import to another module under its local name", () => {
        const { root, imports } = importManager(`import { Old as Alias, Keep } from "a";`);

        const result = imports.resolveImportRename(
            { module: "a", importedName: "Old" },
            { module: "b", importedName: "New" }
        );

        expect(result).toEqual({ localName: "Alias" });
        expect(flat(root.toSource())).toBe(`import { Keep } from "a"; import { New as Alias } from "b";`);
    });

    it("resolveImportRename turns a default import into a named import of the new name", () => {
        const { root, imports } = importManager(`import Thing from "a";`);

        const result = imports.resolveImportRename(
            { module: "a", importedName: "default" },
            { module: "b", importedName: "Thing" }
        );

        expect(result).toEqual({ localName: "Thing" });
        expect(flat(root.toSource())).toBe(`import { Thing } from "b";`);
    });

    it("resolveModuleRename points every import of the module at the new one", () => {
        const { root, imports } = importManager(`import { a } from "old";\nimport { b } from "old";`);

        imports.resolveModuleRename("old", "new");

        expect(flat(root.toSource())).toBe(`import { a } from "new"; import { b } from "new";`);
    });

    it("resolveComponentRename to the same name in another module replaces the old import", () => {
        const { root, imports } = importManager(`import { Card } from "old-ui";\nconst a = <Card />;`);

        const result = imports.resolveComponentRename({
            from: { name: "Card", module: "old-ui" },
            to: { name: "Card", module: "ui" },
        });

        expect(result).toEqual({ useName: "Card", importActions: [] });
        expect(flat(root.toSource())).toBe(`import { Card } from "ui"; const a = <Card />;`);
    });
});

describe("ImportManagerMemoryImpl", () => {
    it("rebuilds the import block from memory: side effects, then values, then types", () => {
        const source = [
            `import "./polyfill";`,
            `import { A } from "ui";`,
            `import type { P } from "ui";`,
            `import * as utils from "utils";`,
            "const x = 1;",
        ].join("\n");
        const root = j(source);
        const imports = new ImportManagerMemoryImpl(j, root, createAutoLogger(), { path: "file.tsx", source });

        imports.scan();
        imports.ensureImport("ui", "B");
        imports.ensureTypeImport({ name: "Q", module: "types" });
        imports.resolveModuleRename("utils", "helpers");
        imports.applyChanges();

        expect(flat(root.toSource())).toBe(
            `import "./polyfill"; import { A, B } from "ui"; import * as utils from "helpers"; import type { P } from "ui"; import type { Q } from "types"; const x = 1;`
        );
    });
});

describe("ImportManagerMemoryImpl inline type markers", () => {
    it("keeps `type` on a named import, and ensureImport of that name turns it into a value import", () => {
        const source = `import { type Props, Card } from "ui";\nimport { type Size } from "tokens";\nconst x = 1;`;
        const root = j(source);
        const imports = new ImportManagerMemoryImpl(j, root, createAutoLogger(), { path: "file.tsx", source });

        imports.scan();
        imports.ensureImport("tokens", "Size");
        imports.applyChanges();

        expect(flat(root.toSource())).toBe(
            `import { type Props, Card } from "ui"; import { Size } from "tokens"; const x = 1;`
        );
    });
});

// ============================================================================
// ImportConflictResolver
// ============================================================================

const PRIMARY = "ui-lib";
const SHIM = "app/ui-shim";
const PREFIX = "Local";
const SUFFIX = "Lib";

function conflictResolver(source: string, config?: ConstructorParameters<typeof ImportConflictResolver>[2]) {
    const root = j(source);
    const resolver = new ImportConflictResolver(j, root, config, {
        primaryModule: PRIMARY,
        equivalentModules: [SHIM],
        internalAliasPrefix: PREFIX,
        primaryAliasSuffix: SUFFIX,
    });
    return { root, resolver };
}

describe("ImportConflictResolver", () => {
    it("a rename with no conflict adds the new import and drops the old one from the same module", () => {
        const { root, resolver } = conflictResolver(
            `import { OldHeader } from "${PRIMARY}";\nconst a = <OldHeader />;`
        );

        const resolution = resolver.resolveComponentUsage("OldHeader", "PageHeader", PRIMARY);
        resolver.trackResolution(resolution);
        resolver.applyImportChanges();

        expect(resolution).toEqual({
            useName: "PageHeader",
            importAction: "add",
            importDetails: { module: PRIMARY, importedName: "PageHeader", localName: "PageHeader" },
        });
        expect(flat(root.toSource())).toBe(`import { PageHeader } from "${PRIMARY}"; const a = <OldHeader />;`);
    });

    it("removing a renamed component's import keeps every side-effect import", () => {
        const { root, resolver } = conflictResolver(
            `import "./styles.css";\nimport { OldHeader } from "${PRIMARY}";\nimport "./polyfill";\nconst a = <OldHeader />;`
        );

        resolver.trackResolution(resolver.resolveComponentUsage("OldHeader", "PageHeader", PRIMARY));
        resolver.applyImportChanges();

        expect(flat(root.toSource())).toBe(
            `import "./styles.css"; import "./polyfill"; import { PageHeader } from "${PRIMARY}"; const a = <OldHeader />;`
        );
    });

    it("an app-local import that clashes with the target is aliased, JSX usages included", () => {
        // Regression test: found by this port's parity run against the original toolkit — aliasing a shorthand
        // `{ Button }` printed `{ LocalButton }`, importing a name the module does not export
        const { root, resolver } = conflictResolver(
            `import { Button } from "./Button";\nconst a = <Button>x</Button>;`
        );

        const resolution = resolver.resolveComponentUsage("OldButton", "Button", PRIMARY, PRIMARY);
        resolver.trackResolution(resolution);
        resolver.applyImportChanges();

        expect(resolution.useName).toBe("Button");
        expect(flat(root.toSource())).toBe(
            `import { Button as ${PREFIX}Button } from "./Button"; import { Button } from "${PRIMARY}"; const a = <${PREFIX}Button>x</${PREFIX}Button>;`
        );
    });

    it("aliasing an app-local import renames every reference to it, but not a shadowing binding or a key", () => {
        const { root, resolver } = conflictResolver(
            [
                `import { Button } from "./Button";`,
                "const Wrapped = memo(Button);",
                `Button.displayName = "Button";`,
                "const parts = { Button, label: <Button.Label /> };",
                "const keys = { Button: 1 };",
                "let props: React.ComponentProps<typeof Button>;",
                "function render(Button: string) { return Button; }",
                "export { Button };",
            ].join("\n")
        );

        resolver.trackResolution(resolver.resolveComponentUsage("OldButton", "Button", PRIMARY, PRIMARY));
        resolver.applyImportChanges();

        expect(flat(root.toSource())).toBe(
            flat(
                [
                    `import { Button as ${PREFIX}Button } from "./Button";`,
                    `import { Button } from "${PRIMARY}";`,
                    `const Wrapped = memo(${PREFIX}Button);`,
                    `${PREFIX}Button.displayName = "Button";`,
                    `const parts = { Button: ${PREFIX}Button, label: <${PREFIX}Button.Label /> };`,
                    "const keys = { Button: 1 };",
                    `let props: React.ComponentProps<typeof ${PREFIX}Button>;`,
                    "function render(Button: string) { return Button; }",
                    `export { ${PREFIX}Button as Button };`,
                ].join("\n")
            )
        );
    });

    it("aliasing a binding keeps the name an export specifier already exports", () => {
        const { root, resolver } = conflictResolver(
            `import { Button } from "./Button";\nexport { Button as PublicButton };`
        );

        resolver.trackResolution(resolver.resolveComponentUsage("OldButton", "Button", PRIMARY, PRIMARY));
        resolver.applyImportChanges();

        expect(flat(root.toSource())).toBe(
            `import { Button as ${PREFIX}Button } from "./Button"; import { Button } from "${PRIMARY}"; export { ${PREFIX}Button as PublicButton };`
        );
    });

    it("a new import joins one plain value import of the module, never a type-only or namespace one", () => {
        const typeAndNamespace = conflictResolver(
            `import type { Props } from "${PRIMARY}";\nimport * as UI from "${PRIMARY}";\nconst a = <OldHeader />;`
        );
        const twoValueImports = conflictResolver(`import { A } from "${PRIMARY}";\nimport { B } from "${PRIMARY}";`);

        for (const { resolver } of [typeAndNamespace, twoValueImports]) {
            resolver.trackResolution(resolver.resolveComponentUsage("OldHeader", "PageHeader", "./old", PRIMARY));
            resolver.applyImportChanges();
        }

        expect(flat(typeAndNamespace.root.toSource())).toBe(
            `import type { Props } from "${PRIMARY}"; import * as UI from "${PRIMARY}"; import { PageHeader } from "${PRIMARY}"; const a = <OldHeader />;`
        );
        expect(flat(twoValueImports.root.toSource())).toBe(
            `import { A, PageHeader } from "${PRIMARY}"; import { B } from "${PRIMARY}";`
        );
    });

    it("a target that would come from an app-local module is aliased with the prefix", () => {
        const { resolver } = conflictResolver(`import { Card } from "${PRIMARY}";`);

        expect(resolver.resolveComponentUsage("Card", "Card", "./old", "./components")).toEqual({
            useName: `${PREFIX}Card`,
            importAction: "alias",
            importDetails: { module: "./components", importedName: "Card", localName: `${PREFIX}Card` },
        });
    });

    it("a rename between two primary modules keeps the existing import and removes the old name", () => {
        const { resolver } = conflictResolver(`import { Card } from "${SHIM}";`);

        expect(resolver.resolveComponentUsage("OldCard", "Card", PRIMARY, PRIMARY)).toEqual({
            useName: "Card",
            importAction: "remove",
            importDetails: { module: PRIMARY, importedName: "OldCard", localName: "OldCard" },
        });
    });

    it("the last resort suffixes the primary import", () => {
        const { resolver } = conflictResolver(`import { Button } from "${SHIM}";`);

        expect(resolver.resolveComponentUsage("Button", "Button", "./legacy", PRIMARY)).toEqual({
            useName: `Button${SUFFIX}`,
            importAction: "alias",
            importDetails: { module: PRIMARY, importedName: "Button", localName: `Button${SUFFIX}` },
        });
    });

    it("a default import of the target name is replaced by a named import", () => {
        const { root, resolver } = conflictResolver(`import Card from "./Card";\nconst a = <Card />;`);

        resolver.trackResolution(resolver.resolveComponentUsage("Card", "Card", "./Card", PRIMARY));
        resolver.applyImportChanges();

        expect(flat(root.toSource())).toBe(`import { Card } from "${PRIMARY}"; const a = <Card />;`);
    });

    it("fixComponentRename sends the new name to the module the migration config names", () => {
        const { resolver } = conflictResolver(`import { OldHeader } from "${PRIMARY}";`, {
            imports: [
                { fromModule: PRIMARY, namedImports: { OldHeader: { rename: "PageHeader", toModule: "layout-lib" } } },
            ],
        });

        expect(resolver.fixComponentRename("OldHeader", "PageHeader")).toEqual({
            useName: "PageHeader",
            importAction: "add",
            importDetails: { module: "layout-lib", importedName: "PageHeader", localName: "PageHeader" },
        });
    });

    it("type imports never make a name unavailable", () => {
        const { resolver } = conflictResolver(`import type { T } from "m";\nimport { A } from "m";`);

        expect([resolver.isNameAvailable("T"), resolver.isNameAvailable("A")]).toEqual([true, false]);
    });

    it("aliases default to a Local prefix and a Lib suffix", () => {
        const root = j(`import { Button } from "app/ui-shim";\nimport { Card } from "ui-lib";`);
        const resolver = new ImportConflictResolver(j, root, undefined, {
            primaryModule: "ui-lib",
            equivalentModules: ["app/ui-shim"],
        });

        expect([
            resolver.resolveComponentUsage("Card", "Card", "./old", "./components").useName,
            resolver.resolveComponentUsage("Button", "Button", "./legacy", "ui-lib").useName,
        ]).toEqual(["LocalCard", "ButtonLib"]);
    });
});

// ============================================================================
// ComponentNode
// ============================================================================

function componentContext(source: string) {
    const root = j(source);
    const logger = createAutoLogger();
    const importManager = new ImportManagerImpl(j, root, logger, { path: "file.tsx", source });
    const ctx: TransformContext = { filePath: "file.tsx", j, root, importManager, logger };
    const nodeFor = (name: string, fromModule?: string) => {
        const path = elementPath(root, name);
        return new ComponentNode(ctx, path.node, "JSX", path, fromModule);
    };
    return { root, logger, ctx, nodeFor };
}

describe("ComponentNode", () => {
    it("renameTo renames both tags and imports the new component", () => {
        const { root, logger, nodeFor } = componentContext(
            `import { OldCard } from "old-ui";\nconst a = <OldCard>x</OldCard>;`
        );
        const node = nodeFor("OldCard", "old-ui");

        node.renameTo({ name: "Card", module: "ui" });

        expect(flat(root.toSource())).toBe(
            `import { OldCard } from "old-ui"; import { Card } from "ui"; const a = <Card>x</Card>;`
        );
        expect(node.getImportModule()).toBe("ui");
        expect(logger.entries).toContainEqual({
            kind: "component",
            file: "file.tsx",
            message: "renamed component OldCard -> Card",
        });
    });

    it("setProp replaces in place, braces numbers, and imports an enum value's module", () => {
        const { root, nodeFor } = componentContext(`const a = <Card a="x" />;`);
        const node = nodeFor("Card");

        node.setProp("a", "y");
        node.setProp("count", 3);
        node.setProp("size", { type: "enum", value: "LG", namedImport: "Size", namedImportFrom: "ui" });

        expect(flat(root.toSource())).toBe(
            `import { Size } from "ui"; const a = <Card a="y" count={3} size={Size.LG} />;`
        );
    });

    it("getPropValue reads literals and a bare prop, not other expressions", () => {
        const { nodeFor } = componentContext(`const a = <Card a="x" b c={2} d={flag} />;`);
        const node = nodeFor("Card");

        expect(["a", "b", "c", "d", "e"].map((name) => node.getPropValue(name))).toEqual([
            "x",
            true,
            2,
            undefined,
            undefined,
        ]);
    });

    it("removeNestedProp and renameNestedProp edit an object-literal prop", () => {
        const { root, nodeFor } = componentContext(`const a = <Card style={{ color: "red", margin: 0 }} />;`);
        const node = nodeFor("Card");

        node.removeNestedProp("style", "margin");
        node.renameNestedProp("style", "color", "tone");

        expect(flat(root.toSource())).toBe(`const a = <Card style={{ tone: "red" }} />;`);
    });

    it("movePropToNested creates the target object, merges into one, or replaces a non-object value", () => {
        const { root, nodeFor } = componentContext(
            `const a = [<Create label="A" />, <Merge label="B" inputProps={{ id: "f" }} />, <Replace label="C" inputProps={props} />];`
        );

        for (const name of ["Create", "Merge", "Replace"]) {
            nodeFor(name).movePropToNested("label", "inputProps", "label");
        }

        expect(flat(root.toSource())).toBe(
            `const a = [<Create inputProps={{ label: "A" }} />, <Merge inputProps={{ id: "f", label: "B" }} />, <Replace inputProps={{ label: "C" }} />];`
        );
    });

    it("appendAfter inserts a sibling once when onlyIfUnique is set, and imports it", () => {
        const { root, nodeFor } = componentContext("const a = <div><Card /></div>;");
        const node = nodeFor("Card");
        const op = { component: "Divider", props: { size: "sm" }, importPath: "ui", onlyIfUnique: true };

        node.appendAfter(op);
        node.appendAfter(op);

        expect(flat(root.toSource())).toBe(
            `import { Divider } from "ui"; const a = <div><Card /><Divider size="sm" /></div>;`
        );
    });

    it("a JSX-only operation on a non-JSX node only logs a warning", () => {
        const { ctx, logger } = componentContext("const a = 1;");
        const node = new ComponentNode(ctx, null, "Identifier");

        node.setProp("a", "b");

        expect(logger.entries).toEqual([
            { kind: "warning", file: "file.tsx", message: "Tried to call JSX-only op on non-JSX node" },
        ]);
    });
});
