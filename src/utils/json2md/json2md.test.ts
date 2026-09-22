import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { detectShape, jsonToBlocks } from "./auto";
import { builtinConverters, MAX_BLOCK_DEPTH, renderBlocks } from "./blocks";
import { joinSections, renderProvenance, renderToc, slugifyHeading } from "./document";
import {
    checkDocument,
    defineDocument,
    isDefinedDocument,
    lineDiff,
    loadDocumentModule,
    writeDocument,
} from "./document-file";
import { Json2mdError, pointerOf } from "./errors";
import { displayWidth, escapeCell, escapeInline, escapeUrl, truncateToWidth } from "./escape";
import { renderFrontmatter, splitFrontmatter, toYaml } from "./frontmatter";
import { json2md, jsonToMarkdown, withConverter } from "./index";
import { checkMarkdown, hashData, hashText, STAMP_VERSION, stampMarkdown, stripStamp } from "./integrity";
import { guessDialect, selectValue } from "./select";
import {
    defineColumns,
    inferColumns,
    omitColumns,
    pickColumns,
    renderGroupedTables,
    renderTable,
    wrapToWidth,
} from "./table";
import type { BlockInput } from "./types";
import { applyHeaderCase, count, formatScalar, getPath, percent, ratioLine, stableStringify } from "./value";

const state = { options: {}, converters: builtinConverters() };
const render = (blocks: Parameters<typeof renderBlocks>[0]) => renderBlocks(blocks, state);
const SafeJSONStringify = (value: unknown): string => SafeJSON.stringify(value, null, 2);

/** Runs `fn` and returns the Json2mdError code it threw, so tests assert on codes not prose. */
function codeOf(fn: () => unknown): string {
    try {
        fn();
    } catch (error) {
        return error instanceof Json2mdError ? error.code : `not-a-Json2mdError: ${String(error)}`;
    }

    return "did-not-throw";
}

describe("escape", () => {
    test("truncates before escaping, so a cut never orphans a backslash", () => {
        // Escaping first would give "abcd\|efgh", and a cut at 5 leaves "abcd\" whose
        // backslash then escapes the column separator and merges two columns.
        const cut = truncateToWidth("abcd|efgh", { max: 5 });

        expect(escapeCell(cut)).toBe("abcd…");
        expect(escapeCell(cut)).not.toEndWith("\\");
    });

    test("escapes pipes and flattens newlines without truncating", () => {
        expect(escapeCell("a|b")).toBe("a\\|b");
        expect(escapeCell("one\ntwo\r\nthree")).toBe("one two three");
        expect(escapeCell("x".repeat(400))).toHaveLength(400);
    });

    test("keeps line breaks as <br> when asked, and cuts at the first break when told to", () => {
        expect(escapeCell("a\nb", "preserve")).toBe("a<br>b");
        expect(escapeCell("a\nb", "truncate")).toBe("a…");
    });

    test("measures wide glyphs as two cells and joined emoji as one glyph", () => {
        expect(displayWidth("abc")).toBe(3);
        expect(displayWidth("日本語")).toBe(6);
        expect(displayWidth("\u001B[31mred\u001B[0m")).toBe(3);
        expect(displayWidth("👨‍👩‍👧")).toBe(2);
    });

    test("truncateStart keeps the tail", () => {
        expect(truncateToWidth("abcdefgh", { max: 4, strategy: "truncateStart" })).toBe("…fgh");
    });

    test("never splits a grapheme cluster", () => {
        const cut = truncateToWidth("🇨🇿🇨🇿🇨🇿", { max: 3 });

        expect(cut.endsWith("…")).toBe(true);
        expect(cut).not.toContain(String.fromCharCode(0xfffd));
    });

    test("wraps a url that carries a space in angle brackets", () => {
        expect(escapeUrl("https://example.com/a b")).toBe("<https://example.com/a b>");
        expect(escapeUrl("https://example.com/plain")).toBe("https://example.com/plain");
    });

    test("escapeInline neutralises a leading block marker", () => {
        expect(escapeInline("# not a heading")).toBe("\\# not a heading");
        expect(escapeInline("a*b")).toBe("a\\*b");
    });
});

describe("value", () => {
    test("renders null and undefined as empty, but keeps 0 and false", () => {
        expect(formatScalar(null)).toBe("");
        expect(formatScalar(undefined)).toBe("");
        expect(formatScalar(0)).toBe("0");
        expect(formatScalar(false)).toBe("false");
    });

    test("joins arrays and stringifies objects with stable key order", () => {
        expect(formatScalar(["a", "b"])).toBe("a, b");
        expect(formatScalar({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
        expect(stableStringify({ b: 1, a: 2 })).toBe(stableStringify({ a: 2, b: 1 }));
    });

    test("pins en-US grouping, because the local default uses a non-breaking space", () => {
        // Built from a code point, not a literal: the formatter turns "\u00A0" into an
        // invisible character, and an invisible character is the thing under test here.
        const nonBreakingSpace = String.fromCharCode(0x00a0);

        expect(count(24590)).toBe("24,590");
        expect(count(24590)).not.toContain(nonBreakingSpace);
    });

    test("percent reports n/a instead of dividing by zero", () => {
        expect(percent(114, 24590)).toBe("0.46%");
        expect(percent(1, 0)).toBe("n/a");
        expect(ratioLine(114, 24590, "claim sets")).toBe("114 of 24,590 claim sets (0.46%)");
    });

    test("reads dot and index paths, and returns undefined for a missing link", () => {
        const data = { a: { b: [{ c: 7 }] } };

        expect(getPath(data, "a.b.0.c")).toBe(7);
        expect(getPath(data, "a.b[0].c")).toBe(7);
        expect(getPath(data, "a.missing.c")).toBeUndefined();
    });

    test("applies each header casing", () => {
        expect(applyHeaderCase("userLoginName", "capitalCase")).toBe("User Login Name");
        expect(applyHeaderCase("userLoginName", "kebabCase")).toBe("user-login-name");
        expect(applyHeaderCase("userLoginName", "constantCase")).toBe("USER_LOGIN_NAME");
        expect(applyHeaderCase("the_cost_of_a_run", "titleCase")).toBe("The Cost of a Run");
        expect(applyHeaderCase("left_alone")).toBe("left_alone");
    });
});

describe("table", () => {
    interface Case extends Record<string, unknown> {
        name: string;
        ms: number;
        suite: string;
    }

    const rows: Case[] = [
        { name: "alpha", ms: 12, suite: "unit" },
        { name: "beta|gamma", ms: 3400, suite: "unit" },
        { name: "delta", ms: 7, suite: "e2e" },
    ];

    test("renders a header, an alignment rule and one line per row", () => {
        const table = renderTable(rows, { columns: ["name", { key: "ms", align: "right" }], alignDelimiters: false });

        expect(table.split("\n")).toEqual([
            "| name | ms |",
            "| --- | ---: |",
            "| alpha | 12 |",
            "| beta\\|gamma | 3400 |",
            "| delta | 7 |",
        ]);
    });

    test("pads cells and sizes the rule to the column, so the source lines up", () => {
        const lines = renderTable(rows, { columns: ["suite"] }).split("\n");
        const widths = new Set(lines.map((line) => line.length));

        expect(widths.size).toBe(1);
    });

    test("returns a sentence instead of a headerless table when there are no rows", () => {
        expect(renderTable([], { columns: ["name"] })).toBe("_No rows._");
        expect(renderTable([], { columns: ["name"], emptyText: "None." })).toBe("None.");
    });

    test("rejects a table declared with no columns", () => {
        expect(() => renderTable(rows, { columns: [] })).toThrow("at least one column");
    });

    test("infers the union of keys across heterogeneous rows", () => {
        expect(inferColumns([{ a: 1 }, { b: 2 }, { a: 3, c: 4 }])).toEqual(["a", "b", "c"]);
    });

    test("renders one row set at two column subsets", () => {
        const columns = defineColumns<Case>("all", ["name", "ms", "suite"]);
        const wide = renderTable(rows, { columns: columns.columns });
        const narrow = renderTable(rows, { columns: pickColumns(columns, ["name", "ms"]) });

        expect(wide).toContain("suite");
        expect(narrow).not.toContain("suite");
        expect(narrow).toContain("alpha");
        expect(omitColumns(columns, ["suite"]).map((c) => (typeof c === "string" ? c : c.key))).toEqual(["name", "ms"]);
    });

    test("pickColumns names the unknown key rather than silently dropping it", () => {
        expect(() => pickColumns(["a", "b"], ["c"])).toThrow('no column named "c"');
    });

    test("groups rows into one table per key", () => {
        const out = renderGroupedTables(rows, { columns: ["name"], group: { by: "suite", showCounts: true } });

        expect(out).toContain("### unit (2)");
        expect(out).toContain("### e2e (1)");
    });

    test("computed and formatted columns", () => {
        const out = renderTable(rows, {
            columns: [
                { key: "label", header: "Label", value: (row) => `${row.suite}/${row.name}` },
                { key: "ms", format: (value) => `${value} ms` },
            ],
            alignDelimiters: false,
        });

        expect(out).toContain("| unit/alpha | 12 ms |");
    });

    test("truncates an over-wide cell and wraps when asked", () => {
        const truncated = renderTable([{ t: "abcdefghij" }], {
            columns: [{ key: "t", maxWidth: 5 }],
            alignDelimiters: false,
        });

        expect(truncated).toContain("| abcd… |");

        const wrapped = renderTable([{ t: "one two three" }], {
            columns: [{ key: "t", maxWidth: 7, overflow: "wrap" }],
            lineBreak: "preserve",
            alignDelimiters: false,
        });

        expect(wrapped).toContain("one two<br>three");
    });

    test("wrapToWidth hard-cuts a single word that cannot fit", () => {
        expect(wrapToWidth("aaaaaaaa", 3)).toEqual(["aaa", "aaa", "aa"]);
    });

    test("unknownKey throw names the uncovered keys", () => {
        expect(() => renderTable(rows, { columns: ["name"], unknownKey: "throw" })).toThrow(/ms, suite/);
    });

    test("headerCase applies only when no explicit header is given", () => {
        const out = renderTable([{ user_login: "x" }], { headerCase: "capitalCase", alignDelimiters: false });

        expect(out).toContain("| User Login |");
    });
});

describe("blocks", () => {
    test("headings, paragraphs and rules", () => {
        expect(render([{ h2: "Title" }, { p: "Body." }, { hr: true }])).toBe("## Title\n\nBody.\n\n---");
    });

    test("nested and task lists", () => {
        expect(render([{ ul: [{ text: "parent", children: ["kid"] }, "sibling"] }])).toBe(
            "- parent\n  - kid\n- sibling"
        );
        expect(
            render([
                {
                    tasks: [
                        { text: "done", checked: true },
                        { text: "open", checked: false },
                    ],
                },
            ])
        ).toBe("- [x] done\n- [ ] open");
    });

    test("a code fence grows past any fence inside its content", () => {
        const out = render([{ code: { language: "md", content: "```\ninner\n```" } }]);

        expect(out.startsWith("````md")).toBe(true);
        expect(out.endsWith("````")).toBe(true);
    });

    test("details keeps the blank lines GitHub needs to render markdown inside HTML", () => {
        const out = render([{ details: { summary: "More", body: [{ p: "hidden" }] } }]);

        expect(out).toBe("<details>\n<summary>More</summary>\n\nhidden\n\n</details>");
    });

    test("callouts carry the label and prefix every line", () => {
        expect(render([{ callout: { kind: "warning", title: "Careful", body: [{ p: "line one\nline two" }] } }])).toBe(
            "> [!WARNING] Careful\n> line one\n> line two"
        );
    });

    test("definition lists, links, images and badges", () => {
        expect(render([{ dl: [{ term: "engine", definitions: ["string", "mdast"] }] }])).toBe(
            "engine\n: string\n: mdast"
        );
        expect(render([{ link: { source: "https://example.com", title: "site" } }])).toBe(
            "[site](https://example.com)"
        );
        expect(render([{ img: { source: "a.png", alt: "shot" } }])).toBe("![shot](a.png)");
        expect(render([{ badges: [{ label: "passed", value: 41 }] }])).toBe("**passed** `41`");
    });

    test("mermaid is generated from nodes and parents", () => {
        const out = render([
            {
                mermaid: {
                    nodes: [
                        { id: "a", label: "A" },
                        { id: "b", parent: "a" },
                    ],
                },
            },
        ]);

        expect(out).toContain("graph TD");
        expect(out).toContain('a["A"]');
        expect(out).toContain("a --> b");
    });

    test("empty sections are dropped rather than joined", () => {
        expect(render([{ p: "one" }, { nl: true }, { p: "two" }])).toBe("one\n\ntwo");
    });

    test("a multi-key block is a programming error", () => {
        expect(() => render([{ h1: "a", h2: "b" } as never])).toThrow(Json2mdError);
        expect(codeOf(() => render([{ h1: "a", h2: "b" } as never]))).toBe("MULTI_KEY_BLOCK");
    });

    test("an unknown block names the known ones", () => {
        expect(codeOf(() => render([{ nope: 1 } as never]))).toBe("UNKNOWN_BLOCK");
        expect(() => render([{ nope: 1 } as never])).toThrow(/Known blocks: badges, blockquote/);
    });

    test("nesting past the block depth limit is an error, not a stack overflow", () => {
        let nested: BlockInput = { p: "leaf" };

        for (let i = 0; i <= MAX_BLOCK_DEPTH + 1; i++) {
            nested = { details: { summary: `level ${i}`, body: nested } };
        }

        expect(codeOf(() => render(nested))).toBe("MAX_DEPTH_EXCEEDED");
    });

    test("a custom converter extends the vocabulary without touching the core", () => {
        const options = withConverter({}, "kbd", ((keys: string[]) =>
            keys.map((k) => `<kbd>${k}</kbd>`).join(" + ")) as never);

        expect(json2md([{ custom: { type: "kbd", data: ["Cmd", "K"] } }], { ...options, trailingNewline: false })).toBe(
            "<kbd>Cmd</kbd> + <kbd>K</kbd>"
        );
    });
});

describe("frontmatter", () => {
    test("quotes only what YAML would otherwise misread", () => {
        const yaml = toYaml({ plain: "hello", colon: "yes: no", numeric: "42", bool: "true", empty: "" });

        expect(yaml).toContain("plain: hello");
        expect(yaml).toContain('colon: "yes: no"');
        expect(yaml).toContain('numeric: "42"');
        expect(yaml).toContain('bool: "true"');
        expect(yaml).toContain('empty: ""');
    });

    test("lists and nested maps", () => {
        expect(toYaml({ tags: ["a", "b"] })).toBe("tags:\n  - a\n  - b");
        expect(toYaml({ outer: { inner: 1 } })).toBe("outer:\n  inner: 1");
    });

    test("a multi-line value becomes a literal block", () => {
        expect(toYaml({ body: "one\ntwo" })).toBe("body: |\n  one\n  two");
    });

    test("each format uses its own delimiter", () => {
        expect(renderFrontmatter({ a: 1 }, "yaml")).toBe("---\na: 1\n---");
        expect(renderFrontmatter({ a: 1 }, "json")).toBe('---\n{\n  "a": 1\n}\n---');
        expect(renderFrontmatter({ a: 1 }, "toml")).toBe("+++\na = 1\n+++");
        expect(renderFrontmatter({})).toBe("");
    });

    test("splits front matter back off a document", () => {
        const split = splitFrontmatter("---\na: 1\n---\nbody\n");

        expect(split.format).toBe("yaml");
        expect(split.raw).toBe("a: 1");
        expect(split.body).toBe("body\n");
        expect(splitFrontmatter("no header").raw).toBeNull();
    });
});

describe("document", () => {
    test("joinSections drops empty and whitespace-only sections", () => {
        expect(joinSections(["# Title", null, "   ", "body"])).toBe("# Title\n\nbody");
    });

    test("provenance ends every line but the last with two spaces", () => {
        const header = renderProvenance({
            generated: "2026-09-22 12:00",
            commit: "abc1234",
            reload: "tools json2md x.json",
        });
        const lines = header.split("\n");

        expect(lines[0]).toBe("**Generated:** 2026-09-22 12:00  ");
        expect(lines.at(-1)).toBe("**Reload:** `tools json2md x.json`");
        expect(lines.at(-1)).not.toEndWith("  ");
    });

    test("the contents list skips headings inside fenced blocks", () => {
        const markdown = "## Real\n\n```sh\n# not a heading\n```\n\n## Also real";

        expect(renderToc(markdown)).toBe("- [Real](#real)\n- [Also real](#also-real)");
    });

    test("duplicate headings get numbered anchors, as GitHub does", () => {
        expect(renderToc("## Same\n\n## Same")).toBe("- [Same](#same)\n- [Same](#same-1)");
    });

    test("slugify drops punctuation and keeps unicode letters", () => {
        expect(slugifyHeading("Práce: hotovo!")).toBe("práce-hotovo");
    });
});

describe("auto", () => {
    test("detects a shape per branch", () => {
        expect(detectShape([{ a: 1 }, { a: 2 }])).toBe("table");
        expect(detectShape(["a", "b"])).toBe("scalar-list");
        expect(detectShape({ a: 1, b: "x" })).toBe("definition-list");
        expect(detectShape({ a: { b: 1 } })).toBe("sections");
        expect(detectShape([])).toBe("empty");
        expect(detectShape([{ a: 1 }, { b: { c: 2 } }])).toBe("object-list");
    });

    test("a sparse array of objects is sections, not a mostly-empty table", () => {
        expect(detectShape([{ a: 1 }, { b: 2 }, { c: 3 }])).toBe("object-list");
    });

    test("a long flat object becomes a key-value table instead of a definition list", () => {
        expect(detectShape({ a: "x".repeat(200) })).toBe("key-value-table");
    });

    test("past the collapse depth the details summary replaces the heading", () => {
        const out = jsonToMarkdown(
            { one: { two: { three: { leaf: 1 } } } },
            { collapseDepth: 2, trailingNewline: false }
        );

        expect(out).toContain("<summary>three</summary>");
        expect(out).not.toContain("### three");
    });

    test("heading levels nest by one per level", () => {
        const out = jsonToMarkdown({ a: { b: { c: 1 } } }, { collapseDepth: 0, trailingNewline: false });

        expect(out).toContain("## a");
        expect(out).toContain("### b");
    });

    test("scalar fields of an object render above its sub-sections", () => {
        const blocks = jsonToBlocks({ name: "x", nested: { a: 1 } });

        expect(blocks[0]).toHaveProperty("dl");
    });

    test("data-derived strings are escaped by default, so a value cannot inject markup", () => {
        const out = jsonToMarkdown(
            { note: "# Heading", html: "<img onerror=x>", link: "[a](b)" },
            { trailingNewline: false }
        );

        expect(out).toContain("\\# Heading");
        expect(out).toContain("&lt;img onerror=x&gt;");
        expect(out).toContain("\\[a\\](b)");
        expect(out).not.toContain("<img");
    });

    test("escaping can be turned off for data that is known to hold markdown", () => {
        const out = jsonToMarkdown({ note: "**bold**" }, { escapeValues: false, trailingNewline: false });

        expect(out).toContain("**bold**");
    });

    test("a pipe in a data value never opens a column", () => {
        const out = jsonToMarkdown([{ a: "x|y" }, { a: "z" }], { trailingNewline: false });
        const rows = out.split("\n").filter((line) => line.startsWith("|"));

        for (const row of rows) {
            expect(row.replace(/\\\|/g, "").split("|").length).toBe(3);
        }
    });

    test("emptyTokens keeps null, empty string, empty array and empty object distinct", () => {
        const out = jsonToMarkdown({ a: null, b: "", c: [], d: {} }, { emptyTokens: true, trailingNewline: false });

        expect(out).toContain("`null`");
        expect(out).toContain('`""`');
        expect(out).toContain("`[]`");
        expect(out).toContain("`{}`");
    });

    test("a cycle is reported with a pointer instead of overflowing the stack", () => {
        const cyclic: Record<string, unknown> = { name: "root" };
        cyclic.self = { child: cyclic };

        expect(codeOf(() => jsonToMarkdown(cyclic))).toBe("CYCLIC_REFERENCE");
    });

    test("the same object twice side by side is not a cycle", () => {
        const shared = { id: 1, name: "shared" };

        expect(() => jsonToMarkdown({ first: shared, second: shared })).not.toThrow();
    });

    test("nesting past maxDepth is an error naming the pointer", () => {
        let deep: Record<string, unknown> = { leaf: 1 };

        for (let i = 0; i < 10; i++) {
            deep = { nested: deep };
        }

        expect(codeOf(() => jsonToMarkdown(deep, { maxDepth: 4 }))).toBe("MAX_DEPTH_EXCEEDED");
        expect(() => jsonToMarkdown(deep, { maxDepth: 4 })).toThrow(/at \/nested/);
    });

    test("pointerOf escapes the two characters RFC 6901 reserves", () => {
        expect(pointerOf(["a/b", "c~d", 0])).toBe("/a~1b/c~0d/0");
        expect(pointerOf([])).toBe("");
    });

    test("a tree becomes a mermaid graph only when asked", () => {
        const rows = [{ id: "a" }, { id: "b", parent: "a" }];

        expect(jsonToMarkdown(rows, { mermaidForTrees: true })).toContain("graph TD");
        expect(jsonToMarkdown(rows, { mermaidForTrees: false })).toContain("| id ");
    });
});

describe("select", () => {
    const data = { users: [{ login: "ada" }, { login: "grace" }] };

    test("jmespath is the default dialect", () => {
        expect(selectValue(data, "users[].login")).toEqual(["ada", "grace"]);
    });

    test("jsonpath unwraps a single match by default", () => {
        expect(selectValue(data, "$.users[*].login", { dialect: "jsonpath" })).toEqual(["ada", "grace"]);
        expect(selectValue(data, "$.users", { dialect: "jsonpath" })).toEqual(data.users);
        expect(selectValue(data, "$.users", { dialect: "jsonpath", unwrapSingle: false })).toEqual([data.users]);
    });

    test("an empty expression is the identity", () => {
        expect(selectValue(data, "  ")).toBe(data);
    });

    test("a broken expression names the dialect", () => {
        expect(() => selectValue(data, "users[", { dialect: "jmespath" })).toThrow(/jmespath expression failed/);
    });

    test("guessDialect reads the leading dollar", () => {
        expect(guessDialect("$.a")).toBe("jsonpath");
        expect(guessDialect("a.b")).toBe("jmespath");
    });
});

describe("integrity", () => {
    const body = "# Title\n\nsome generated body\n";

    test("a stamped file round-trips to its own body", () => {
        const stamped = stampMarkdown(body, { source: hashData({ a: 1 }), generator: "./x.ts" });
        const split = stripStamp(stamped);

        expect(split.stamp?.version).toBe(STAMP_VERSION);
        expect(split.stamp?.generator).toBe("./x.ts");
        expect(hashText(split.body)).toBe(split.stamp?.content ?? "");
    });

    test("stamping twice is stable, because the stamp is stripped before hashing", () => {
        const once = stampMarkdown(body, { generated: "2026-09-22 12:00" });
        const twice = stampMarkdown(once, { generated: "2026-09-22 12:00" });

        expect(twice).toBe(once);
    });

    test("an untouched file whose data moved is stale, not hand-edited", () => {
        const stamped = stampMarkdown(body, { source: hashData({ a: 1 }) });
        const result = checkMarkdown({
            current: stamped,
            regenerated: stampMarkdown("# Title\n\na different body\n"),
            sourceHash: hashData({ a: 2 }),
        });

        expect(result.verdict).toBe("stale");
        expect(result.dataChanged).toBe(true);
    });

    test("an edited body is hand-edited even when the data also moved", () => {
        const stamped = stampMarkdown(body, { source: hashData({ a: 1 }) });
        const edited = stamped.replace("some generated body", "a human wrote this");
        const result = checkMarkdown({
            current: edited,
            regenerated: stampMarkdown("# Title\n\nsomething else\n"),
            sourceHash: hashData({ a: 2 }),
        });

        expect(result.verdict).toBe("hand-edited");
        expect(result.dataChanged).toBe(true);
    });

    test("identical output on identical data is clean", () => {
        const stamped = stampMarkdown(body, { source: hashData({ a: 1 }) });
        const result = checkMarkdown({
            current: stamped,
            regenerated: stampMarkdown(body),
            sourceHash: hashData({ a: 1 }),
        });

        expect(result.verdict).toBe("clean");
    });

    test("a file with no stamp says so rather than guessing", () => {
        expect(checkMarkdown({ current: "# plain\n" }).verdict).toBe("unstamped");
    });

    test("a newer stamp version refuses rather than regenerating", () => {
        const future = `body\n\n<!-- json2md:stamp v${STAMP_VERSION + 1} content=sha256:00 -->\n`;

        expect(checkMarkdown({ current: future }).verdict).toBe("unsupported");
    });

    test("hashData ignores key order but not values", () => {
        expect(hashData({ a: 1, b: 2 })).toBe(hashData({ b: 2, a: 1 }));
        expect(hashData({ a: 1 })).not.toBe(hashData({ a: 2 }));
    });

    test("lineDiff shows the changed lines with context", () => {
        expect(lineDiff("a\nb\nc", "a\nB\nc")).toBe("  a\n- b\n+ B\n  c");
        expect(lineDiff("same", "same")).toBe("");
    });
});

describe("three-file pattern", () => {
    async function scratch(): Promise<string> {
        const dir = await mkdtemp(join(tmpdir(), "json2md-"));

        return dir;
    }

    /** A definition built in memory, so the test never has to import a generated module. */
    function definitionFor(dataFile: string) {
        return defineDocument<{ items: Array<{ id: number; name: string }> }>({
            data: dataFile,
            options: { title: "Scratch", provenance: { scope: "a test" } },
            render: (d) => [{ table: { rows: d.items } }],
        });
    }

    test("writes, then reports unchanged, and keeps the file byte-identical", async () => {
        const dir = await scratch();
        const modulePath = join(dir, "doc.ts");
        await Bun.write(join(dir, "doc.json"), SafeJSONStringify({ items: [{ id: 1, name: "one" }] }));

        const definition = definitionFor("./doc.json");
        const first = await writeDocument(modulePath, definition);

        expect(first.outcome).toBe("written");

        const afterFirst = await Bun.file(first.outPath).text();
        const second = await writeDocument(modulePath, definition);

        expect(second.outcome).toBe("unchanged");
        expect(await Bun.file(first.outPath).text()).toBe(afterFirst);
    });

    test("a data change is stale and rewrites", async () => {
        const dir = await scratch();
        const modulePath = join(dir, "doc.ts");
        const dataPath = join(dir, "doc.json");
        await Bun.write(dataPath, SafeJSONStringify({ items: [{ id: 1, name: "one" }] }));

        const definition = definitionFor("./doc.json");
        await writeDocument(modulePath, definition);
        await Bun.write(
            dataPath,
            SafeJSONStringify({
                items: [
                    { id: 1, name: "one" },
                    { id: 2, name: "two" },
                ],
            })
        );

        const check = await checkDocument(modulePath, definition);

        expect(check.verdict).toBe("stale");
        expect(check.dataChanged).toBe(true);

        const rebuilt = await writeDocument(modulePath, definition);

        expect(rebuilt.outcome).toBe("written");
        expect(await Bun.file(rebuilt.outPath).text()).toContain("two");
    });

    test("a hand edit is refused, and the edit survives", async () => {
        const dir = await scratch();
        const modulePath = join(dir, "doc.ts");
        await Bun.write(join(dir, "doc.json"), SafeJSONStringify({ items: [{ id: 1, name: "one" }] }));

        const definition = definitionFor("./doc.json");
        const written = await writeDocument(modulePath, definition);
        const original = await Bun.file(written.outPath).text();
        const edited = original.replace("**Scope:**", "HUMAN LINE\n\n**Scope:**");

        expect(edited).not.toBe(original);
        await Bun.write(written.outPath, edited);

        const check = await checkDocument(modulePath, definition);

        expect(check.verdict).toBe("hand-edited");

        const refused = await writeDocument(modulePath, definition);

        expect(refused.outcome).toBe("refused");
        expect(await Bun.file(written.outPath).text()).toContain("HUMAN LINE");

        const forced = await writeDocument(modulePath, definition, { force: true });

        expect(forced.outcome).toBe("written");
        expect(await Bun.file(written.outPath).text()).not.toContain("HUMAN LINE");
    });

    test("the recorded regenerate command does not depend on the current directory", async () => {
        // It is written into a durable file that someone else, standing somewhere else, is
        // meant to run. A cwd-relative path recorded "tools json2md build ../../../../../…".
        const dir = await scratch();
        const modulePath = join(dir, "doc.ts");
        await Bun.write(join(dir, "doc.json"), SafeJSONStringify({ items: [{ id: 1, name: "one" }] }));

        const built = await writeDocument(modulePath, definitionFor("./doc.json"));
        const stamped = await Bun.file(built.outPath).text();
        const recorded = decodeURIComponent(stamped.match(/command=([^\s]+)/)?.[1] ?? "");

        expect(recorded).not.toContain("..");
        expect(recorded).toBe(`tools json2md build ${modulePath}`);
    });

    test("dry-run reports without touching the file", async () => {
        const dir = await scratch();
        const modulePath = join(dir, "doc.ts");
        await Bun.write(join(dir, "doc.json"), SafeJSONStringify({ items: [{ id: 1, name: "one" }] }));

        const definition = definitionFor("./doc.json");
        const result = await writeDocument(modulePath, definition, { dryRun: true });

        expect(result.outcome).toBe("unchanged");
        expect(await Bun.file(result.outPath).exists()).toBe(false);
    });

    test("an unstamped definition writes no marker", async () => {
        const dir = await scratch();
        const modulePath = join(dir, "doc.ts");
        await Bun.write(join(dir, "doc.json"), SafeJSONStringify({ items: [] }));

        const definition = defineDocument({ data: "./doc.json", unstamped: true, render: () => [{ p: "plain" }] });
        const result = await writeDocument(modulePath, definition);

        expect(await Bun.file(result.outPath).text()).not.toContain("json2md:stamp");
    });

    test("a module with no defineDocument default export says what to add", async () => {
        const dir = await scratch();
        const modulePath = join(dir, "bad.ts");
        await Bun.write(modulePath, "export default { nope: true };\n");

        await expect(loadDocumentModule(modulePath)).rejects.toThrow("defineDocument");
    });

    test("lineDiff aligns on the longest common subsequence, not on line numbers", async () => {
        const diff = lineDiff("a\nb\nc\nd", "a\nINSERTED\nb\nc\nd");

        expect(diff).toContain("+ INSERTED");
        expect(diff).not.toContain("- b");
        expect(diff).not.toContain("- d");
    });
});

describe("document assembly", () => {
    test("front matter, title, provenance and contents stack in order", () => {
        const out = json2md([{ h2: "Section" }], {
            title: "Doc",
            frontmatter: { tags: ["x"] },
            provenance: { generated: "2026-09-22 12:00" },
            toc: true,
        });

        const order = ["---", "# Doc", "**Generated:**", "- [Section](#section)", "## Section"];
        let cursor = -1;

        for (const needle of order) {
            const found = out.indexOf(needle);

            expect(found).toBeGreaterThan(cursor);
            cursor = found;
        }
    });

    test("the document ends with exactly one newline unless told otherwise", () => {
        expect(json2md([{ p: "x" }])).toBe("x\n");
        expect(json2md([{ p: "x" }], { trailingNewline: false })).toBe("x");
    });

    test("crlf line endings apply to the whole document", () => {
        expect(json2md([{ p: "a" }, { p: "b" }], { lineEnding: "\r\n" })).toBe("a\r\n\r\nb\r\n");
    });
});

describe("defineDocument validation", () => {
    // 🛑 A document module is loaded by dynamic import, so TypeScript never checks it at the
    // moment it runs. Both mistakes below used to surface as a node `fs` error reading
    // `The "path" property must be of type string, got array`, which names neither the
    // document, nor the field, nor the module.
    test("rejects data given inline instead of as a path, and says which is which", () => {
        expect(() => defineDocument({ data: [{ a: 1 }] as never, render: () => [] })).toThrow(
            /`data` must be a path to the JSON file/
        );
    });

    test("names an array specifically, because passing the rows is the natural mistake", () => {
        try {
            defineDocument({ data: [{ a: 1 }] as never, render: () => [] });
            throw new Error("expected defineDocument to throw");
        } catch (error) {
            expect(error).toBeInstanceOf(Json2mdError);
            expect((error as Json2mdError).code).toBe("INVALID_DEFINITION");
            expect((error as Json2mdError).pointer).toBe("/data");
            expect((error as Error).message).toContain("not the data itself");
        }
    });

    test("rejects an empty data path rather than resolving it to the module's own folder", () => {
        expect(() => defineDocument({ data: "   ", render: () => [] })).toThrow(/must be a path/);
    });

    test("rejects a missing render, which is what writing `build` produces", () => {
        expect(() => defineDocument({ data: "./x.json", build: () => [] } as never)).toThrow(
            /`render` must be a function/
        );
    });

    test("accepts a well-formed definition", () => {
        const definition = defineDocument({ data: "./x.json", render: () => [{ h1: "ok" }] });

        expect(definition.data).toBe("./x.json");
        expect(isDefinedDocument(definition)).toBe(true);
    });
});
