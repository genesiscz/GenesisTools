import { describe, expect, test } from "bun:test";
import { renderPrompt } from "@genesiscz/utils/template";
import { describeTransclusions, formatTransclusionHelp } from "./describe";
import { capChars, TranscludeFailedError, transclude } from "./engine";
import { defaultTransclusionRegistry } from "./kinds";
import { mapInclude, parseTranscludeText, type TokenSegment } from "./parse";
import { formatRecheck, recheck } from "./recheck";
import { redactSecretsInText } from "./redact";
import {
    createTransclusionRegistry,
    defineTransclusion,
    parseLineRange,
    TransclusionError,
    validateTransclusionParams,
} from "./registry";
import type { TransclusionDefinition } from "./types";

function tokens(text: string): TokenSegment[] {
    return parseTranscludeText(text).filter((segment): segment is TokenSegment => segment.type === "token");
}

const echo = defineTransclusion({
    name: "echo",
    description: "Echoes its params.",
    params: [
        { name: "path", type: "path", required: true, description: "a path" },
        { name: "range", type: "range", description: "lines" },
        { name: "n", type: "int", default: 5, description: "count" },
        { name: "mode", type: "enum", values: ["a", "b"], description: "mode" },
        { name: "flag", type: "bool", description: "flag" },
    ],
    examples: ['{{echo path="x"}}'],
    action: "substitute",
    async resolve(params) {
        const range = params.optionalRange("range");
        return {
            markdown: `[${params.string("path")}|${params.int("n")}|${range ? `${range.start}-${range.end}` : "-"}|${params.optionalString("mode") ?? "-"}|${params.bool("flag")}]`,
            meta: { echoed: true },
        };
    },
});

const slow = defineTransclusion({
    name: "slow",
    description: "Never finishes unless aborted.",
    params: [{ name: "x", type: "string", description: "any" }],
    examples: ["{{slow x=1}}"],
    action: "substitute",
    resolve: (_params, ctx) =>
        new Promise((resolve) => {
            ctx.signal.addEventListener("abort", () => resolve({ markdown: "late" }));
        }),
});

const big = defineTransclusion({
    name: "big",
    description: "A large block.",
    params: [{ name: "n", type: "int", default: 100, description: "chars" }],
    examples: ["{{big}}"],
    action: "substitute",
    resolve: async (params) => ({ markdown: `\`\`\`text\n${"x".repeat(params.int("n"))}\n\`\`\``, block: true }),
});

function registry(...extra: TransclusionDefinition[]) {
    return createTransclusionRegistry([echo, slow, big, ...extra]);
}

describe("parseTranscludeText", () => {
    test("named params in any order, both quote styles, bare values", () => {
        const [token] = tokens(`see {{lines range=10-40 path='/abs/a b.ts' commit="abc"}} now`);
        expect(token.kind).toBe("lines");
        expect(token.params).toEqual({ range: "10-40", path: "/abs/a b.ts", commit: "abc" });
        expect(token.standalone).toBe(false);
    });

    test("tolerates key: value and commas, as typed by hand", () => {
        const [token] = tokens('{{lines path="/abs/app.t", range: "10-40", commit="x"}}');
        expect(token.error).toBeUndefined();
        expect(token.params).toEqual({ path: "/abs/app.t", range: "10-40", commit: "x" });
        expect(token.standalone).toBe(true);
    });

    test("Windows paths keep their backslashes; only \\\" \\' \\\\ are escapes", () => {
        const [token] = tokens('{{file path="C:\\Users\\dev\\a.ts" note="say \\"hi\\" \\\\ done"}}');
        expect(token.params.path).toBe("C:\\Users\\dev\\a.ts");
        expect(token.params.note).toBe('say "hi" \\ done');
    });

    test("braces inside a quoted value do not end the token", () => {
        const [token] = tokens('{{json path="a.json" pointer="$[\\"}}\\"]"}} tail');
        expect(token.params.pointer).toBe('$["}}"]');
        expect(token.raw.endsWith("}}")).toBe(true);
    });

    test("an escaped \\{{ is a literal and tokens in code stay literal", () => {
        const segments = parseTranscludeText(
            'a \\{{lines path="x"}} `{{lines path="y"}}`\n```\n{{file path="z"}}\n```\n'
        );
        expect(segments.every((segment) => segment.type === "text")).toBe(true);
        expect(segments.map((segment) => (segment.type === "text" ? segment.value : "")).join("")).toBe(
            'a {{lines path="x"}} `{{lines path="y"}}`\n```\n{{file path="z"}}\n```\n'
        );
    });

    test("a template like {{ user.name }} is not a token", () => {
        expect(tokens("Hello {{ user.name }} and {{ }}")).toEqual([]);
    });

    test("syntax errors become failed tokens, never exceptions", () => {
        expect(tokens('{{lines path="x" path="y"}}')[0].error).toBe('duplicate param "path"');
        expect(tokens('{{lines path="x}}')[0].error).toContain("unterminated quote");
        expect(tokens('{{lines path="x"\nnext')[0].error).toContain("missing }}");

        expect(tokens("{{lines path=}}")[0].error).toBe('empty value for "path"');
    });

    test("mdBook #include forms map onto file and lines", () => {
        expect(mapInclude("src/a.rs")).toEqual({ kind: "file", params: { path: "src/a.rs" } });
        expect(mapInclude("src/a.rs:2:10")).toEqual({ kind: "lines", params: { path: "src/a.rs", range: "2-10" } });
        expect(mapInclude("src/a.rs::10")).toEqual({ kind: "lines", params: { path: "src/a.rs", range: "1-10" } });
        expect(mapInclude("src/a.rs:2:")).toEqual({ kind: "lines", params: { path: "src/a.rs", range: "2-" } });
        expect(mapInclude("src/a.rs:7")).toEqual({ kind: "lines", params: { path: "src/a.rs", range: "7" } });
        expect(mapInclude("src/a.rs:setup")).toEqual({ kind: "lines", params: { path: "src/a.rs", anchor: "setup" } });
        expect(mapInclude("C:\\code\\a.rs")).toEqual({ kind: "file", params: { path: "C:\\code\\a.rs" } });
        const [token] = tokens("{{#include my file.ts:3:4}}");
        expect(token.alias).toBe("#include");
        expect(token.params).toEqual({ path: "my file.ts", range: "3-4" });
    });
});

describe("validateTransclusionParams", () => {
    const validate = (raw: Record<string, string>) =>
        validateTransclusionParams({ definition: echo, raw, cwd: "/work" });

    test("types, defaults and relative paths", () => {
        const params = validate({ path: "src/a.ts", range: "L3-L9", mode: "b", flag: "yes" });
        expect(params.string("path")).toBe("/work/src/a.ts");
        expect(params.range("range")).toEqual({ start: 3, end: 9 });
        expect(params.int("n")).toBe(5);
        expect(params.bool("flag")).toBe(true);
    });

    test("names the bad param and what was expected", () => {
        expect(() => validate({ path: "a", rng: "1" })).toThrow(
            'unknown param "rng" for echo (expected: path, range, n, mode, flag; did you mean range?)'
        );
        expect(() => validate({})).toThrow('missing required param "path" for echo');
        expect(() => validate({ path: "a", n: "x" })).toThrow('param "n" of echo expects an integer, got "x"');
        expect(() => validate({ path: "a", mode: "c" })).toThrow('param "mode" of echo expects one of a, b, got "c"');
        expect(() => validate({ path: "a", range: "9-3" })).toThrow("expects a line range");
    });

    test("requireOneOf needs exactly one of the group", () => {
        const lines = defaultTransclusionRegistry().get("lines");

        if (!lines) {
            throw new Error("lines kind missing");
        }

        expect(() => validateTransclusionParams({ definition: lines, raw: { path: "a" }, cwd: "/" })).toThrow(
            "lines needs one of range, anchor"
        );
        expect(() =>
            validateTransclusionParams({ definition: lines, raw: { path: "a", range: "1", anchor: "x" }, cwd: "/" })
        ).toThrow("lines takes only one of range, anchor");
    });

    test("parseLineRange forms", () => {
        expect(parseLineRange("10-40")).toEqual({ start: 10, end: 40 });
        expect(parseLineRange("10")).toEqual({ start: 10, end: 10 });
        expect(parseLineRange("10-")).toEqual({ start: 10, end: null });
        expect(parseLineRange("-40")).toEqual({ start: 1, end: 40 });
        expect(parseLineRange("abc")).toBeNull();
    });
});

describe("registry", () => {
    test("a new kind is one object, and a duplicate name is refused", () => {
        const tail = defineTransclusion({
            name: "tail2",
            description: "d",
            params: [{ name: "n", type: "int", description: "lines" }],
            examples: ["{{tail2 n=3}}"],
            action: "substitute",
            resolve: async () => ({ markdown: "ok" }),
        });
        const reg = registry(tail);
        expect(reg.get("tail2")?.name).toBe("tail2");
        expect(() => reg.define(tail)).toThrow('transclusion kind "tail2" is already defined');
    });

    test("help and descriptions come from the registry", () => {
        const reg = defaultTransclusionRegistry();
        const help = formatTransclusionHelp(reg);
        const names = describeTransclusions(reg).map((entry) => entry.name);
        expect(names).toEqual(["lines", "file", "symbol", "diff", "tail", "json", "cmd", "url", "image", "pr-thread"]);

        for (const name of names) {
            expect(help).toContain(`  ${name}`);
        }

        expect(help).toContain("params: path* range:range anchor commit (one of range|anchor)");
        expect(help).toContain("url [verify]");
        expect(help).toContain("pr-thread [verify]");
        expect(describeTransclusions(reg).find((entry) => entry.name === "lines")?.action).toBe("substitute");
    });
});

describe("transclude", () => {
    test("substitutes, records, and marks failures visibly", async () => {
        const result = await transclude('A {{echo path="p" n=2}} B {{ecko path="p"}} C {{echo path="p" bogus=1}}', {
            registry: registry(),
            cwd: "/w",
        });
        expect(result.text).toBe(
            'A [/w/p|2|-|-|false] B ⚠️ unresolved `{{ecko path="p"}}`: unknown kind "ecko" (did you mean echo?) C ' +
                '⚠️ unresolved `{{echo path="p" bogus=1}}`: unknown param "bogus" for echo (expected: path, range, n, mode, flag)'
        );
        expect(result.tokens.map((token) => token.ok)).toEqual([true, false, false]);
        expect(result.tokens[0].meta).toMatchObject({ echoed: true, provenance: { token: '{{echo path="p" n=2}}' } });
        expect(result.tokens[0].signature).toMatch(/^[0-9a-f]{64}$/);
        expect(result.tokens[0].params).toEqual({ path: "p", n: "2" });
    });

    test("a standalone failure is its own quote paragraph", async () => {
        const result = await transclude("before\n{{nope x=1}}\nafter", { registry: registry(), cwd: "/" });
        expect(result.text).toContain('before\n\n> ⚠️ unresolved `{{nope x=1}}`: unknown kind "nope"');
        expect(result.text).toEndWith("\n\nafter");
    });

    test("a text without tokens only loses its escapes", async () => {
        const result = await transclude("keep \\{{this}} and {{ x.y }}", { registry: registry(), cwd: "/" });
        expect(result).toEqual({ text: "keep {{this}} and {{ x.y }}", tokens: [] });
    });

    test("the deadline fails a slow token with a reason", async () => {
        const result = await transclude("{{slow x=1}}", { registry: registry(), cwd: "/", timeoutMs: 20 });
        expect(result.tokens[0]).toMatchObject({ ok: false, error: "timed out after 20 ms" });
    });

    test("per-token cap cuts with a marker and closes the fence; the text cap skips later tokens", async () => {
        const result = await transclude("{{big n=500}}\n{{big n=500}}", {
            registry: registry(),
            cwd: "/",
            maxTokenChars: 200,
            maxTextChars: 450,
        });
        expect(result.tokens[0]).toMatchObject({ ok: true, truncated: true });
        expect(result.text).toContain("```\n… [truncated:");
        expect(result.tokens[1]).toMatchObject({ ok: false });
        expect(result.tokens[1].error).toContain("text size cap reached");
    });

    test("every substitution is redacted", async () => {
        const secret = defineTransclusion({
            name: "secret",
            description: "d",
            params: [{ name: "x", type: "string", description: "any" }],
            examples: ["{{secret x=1}}"],
            action: "substitute",
            resolve: async () => ({ markdown: `key ghp_${"a".repeat(36)}` }),
        });
        const result = await transclude("{{secret x=1}}", { registry: registry(secret), cwd: "/" });
        expect(result.text).toBe("key [redacted]");
    });

    test("a resolver's TransclusionError is the reason", async () => {
        const failing = defineTransclusion({
            name: "failing",
            description: "d",
            params: [{ name: "x", type: "string", description: "any" }],
            examples: ["{{failing x=1}}"],
            action: "substitute",
            resolve: async () => {
                throw new TransclusionError("file not found: /x");
            },
        });
        const result = await transclude("{{failing x=1}}", { registry: registry(failing), cwd: "/" });
        expect(result.tokens[0].error).toBe("file not found: /x");
    });
});

describe("helpers", () => {
    test("capChars leaves short text alone", () => {
        expect(capChars("abc", 10)).toEqual({ text: "abc", truncated: false });
    });

    test("redaction keeps code readable", () => {
        const text = [
            "refreshToken: string;",
            "const token = readToken();",
            "Authorization: Bearer abcdefghijklmnop1234",
            "API_KEY=sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123",
            "https://alice:hunter2@example.com/x",
            "password: Sup3rSecretValue123456",
        ].join("\n");
        expect(redactSecretsInText(text)).toBe(
            [
                "refreshToken: string;",
                "const token = readToken();",
                "Authorization: Bearer [redacted]",
                "API_KEY=[redacted]",
                "https://alice:[redacted]@example.com/x",
                "password: [redacted]",
            ].join("\n")
        );
    });
});

describe("template collisions", () => {
    test("a token needs a key=value param, so bare {{name}} prompt variables stay for renderPrompt", async () => {
        const text = 'Hi {{name}}, see {{lines}} and {{ lines }} and {{lines path "x"}}';
        expect(tokens(text)).toEqual([]);
        const result = await transclude(text, { registry: defaultTransclusionRegistry(), cwd: "/" });
        expect(result.text).toBe(text);
        expect(renderPrompt(result.text, { name: "Ada", lines: "3" }).text).toBe(
            'Hi Ada, see 3 and 3 and {{lines path "x"}}'
        );
    });

    test("the mdBook form is a token without key=value", () => {
        expect(tokens("{{#include a.ts}}")[0]).toMatchObject({ kind: "file", params: { path: "a.ts" } });
    });
});

describe("provenance, verify and fail-closed", () => {
    const clock = () => new Date("2026-09-30T17:11:00.000Z");

    test("a block ends with a one-line footer; meta carries the same provenance", async () => {
        const sourced = defineTransclusion({
            name: "sourced",
            description: "d",
            params: [{ name: "n", type: "int", description: "n" }],
            examples: ["{{sourced n=1}}"],
            action: "substitute",
            resolve: async () => ({
                markdown: "```text\nx\n```",
                block: true,
                source: "a.ts@abc123",
                shown: { shown: 40, total: 212, unit: "lines" },
            }),
        });
        const result = await transclude("{{sourced n=1}}", { registry: registry(sourced), cwd: "/", now: clock });
        const footer = result.text.split("\n").at(-1);
        expect(footer).toBe(
            "_↳ captured 2026-09-30 17:11 UTC · a.ts@abc123 · showing 40 of 212 lines · re-check: `{{sourced n=1}}`_"
        );
        expect(result.tokens[0].meta?.provenance).toEqual({
            capturedAt: "2026-09-30T17:11:00.000Z",
            source: "a.ts@abc123",
            token: "{{sourced n=1}}",
            recheck: "tools question tokens resolve '{{sourced n=1}}'",
            shown: { shown: 40, total: 212, unit: "lines" },
        });
        expect(result.tokens[0].action).toBe("substitute");
        expect(result.tokens[0].snapshot).toBeUndefined();
    });

    test("recheck reports unchanged, changed (was/now) and frozen", async () => {
        let value = "green";
        const status = defineTransclusion({
            name: "status",
            description: "d",
            params: [{ name: "of", type: "string", description: "what" }],
            examples: ['{{status of="ci"}}'],
            action: "verify",
            resolve: async () => ({ markdown: `CI: ${value}`, block: true }),
        });
        const reg = registry(status);
        const first = await transclude('{{status of="ci"}} {{echo path="p"}}', { registry: reg, cwd: "/", now: clock });
        expect(first.tokens[0]).toMatchObject({ action: "verify", snapshot: "CI: green" });

        expect((await recheck(first.tokens, { registry: reg })).map((outcome) => outcome.status)).toEqual([
            "unchanged",
            "frozen",
        ]);

        value = "red";
        const [changed] = await recheck(first.tokens, { registry: reg, now: () => new Date("2026-09-30T19:00:00Z") });
        expect(changed).toMatchObject({ status: "changed", was: "CI: green", now: "CI: red" });
        expect(formatRecheck(changed)).toContain(
            'changed since capture: {{status of="ci"}}: was "CI: green", now "CI: red" (as of 2026-09-30 19:00 UTC'
        );
    });

    test("onFailure throw fails closed after trying every token", async () => {
        await expect(
            transclude('{{echo path="ok"}} {{ecko path="p"}}', { registry: registry(), cwd: "/", onFailure: "throw" })
        ).rejects.toThrow(TranscludeFailedError);
        await expect(
            transclude('{{ecko path="p"}}', { registry: registry(), cwd: "/", onFailure: "throw" })
        ).rejects.toThrow('1 token(s) did not resolve: {{ecko path="p"}}: unknown kind "ecko"');
        expect(
            (await transclude('{{echo path="ok"}}', { registry: registry(), cwd: "/", onFailure: "throw" })).tokens[0]
                .ok
        ).toBe(true);
    });
});
