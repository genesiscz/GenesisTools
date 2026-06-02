import { describe, expect, it } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SafeJSON } from "@app/utils/json";
import { resolveInput } from "./lib/read-input";
import { renderSchema } from "./lib/render";

const SAMPLE = '{"id":42,"name":"Ada","active":true,"roles":["admin","editor"],"profile":{"bio":"hi","age":36}}';

describe("renderSchema", () => {
    it("typescript: emits a multi-line root interface with nested interfaces", () => {
        const out = renderSchema({ text: SAMPLE, format: "typescript", name: "Root" });
        expect(out).toContain("interface Root {");
        expect(out).toContain("id: number;");
        expect(out).toContain("name: string;");
        expect(out).toContain("active: boolean;");
        expect(out).toContain("roles: string[];");
        expect(out).toContain("profile: Profile;");
        expect(out).toContain("interface Profile {");
        expect(out).toContain("\n");
    });

    it("skeleton: emits a compact-ish multi-line type tree", () => {
        const out = renderSchema({ text: SAMPLE, format: "skeleton", name: "Root" });
        expect(out).toContain("id: integer");
        expect(out).toContain("name: string");
        expect(out).toContain("roles: string[]");
    });

    it("schema: emits valid JSON Schema that round-trips", () => {
        const out = renderSchema({ text: SAMPLE, format: "schema", name: "Root" });
        const parsed = SafeJSON.parse(out);
        expect(parsed.type).toBe("object");
        expect(parsed.properties.id.type).toBe("integer");
        expect(parsed.properties.roles.type).toBe("array");
    });

    it("name: renames only the root interface, leaving nested names intact", () => {
        const out = renderSchema({ text: SAMPLE, format: "typescript", name: "User" });
        expect(out).toContain("interface User {");
        expect(out).not.toContain("interface Root {");
        expect(out).toContain("interface Profile {"); // nested name untouched
    });

    it("name: is a no-op for skeleton format", () => {
        const named = renderSchema({ text: SAMPLE, format: "skeleton", name: "User" });
        const plain = renderSchema({ text: SAMPLE, format: "skeleton", name: "Root" });
        expect(named).toBe(plain);
    });

    it("name: is a no-op for schema format", () => {
        const named = renderSchema({ text: SAMPLE, format: "schema", name: "User" });
        const plain = renderSchema({ text: SAMPLE, format: "schema", name: "Root" });
        expect(named).toBe(plain);
    });

    it("unbox: primitives are NOT misinferred as objects", () => {
        // Under default boxing parse, typeof String{}==='object' → all three
        // would become objects. This is the regression guard for unbox:true.
        const out = renderSchema({ text: '{"a":"x","b":1,"c":true}', format: "skeleton", name: "Root" });
        expect(out).toContain("a: string");
        expect(out).toContain("b: integer");
        expect(out).toContain("c: boolean");
    });

    it("unbox: a bare top-level primitive infers as that primitive", () => {
        const out = renderSchema({ text: '"hi"', format: "skeleton", name: "Root" });
        expect(out.trim()).toBe("string");
    });

    it("throws on empty input", () => {
        expect(() => renderSchema({ text: "   ", format: "typescript", name: "Root" })).toThrow();
    });

    it("throws on invalid JSON", () => {
        expect(() => renderSchema({ text: "{bad", format: "typescript", name: "Root" })).toThrow();
    });
});

describe("resolveInput", () => {
    it("reads JSON from a file path argument", async () => {
        const dir = await mkdtemp(join(tmpdir(), "infer-schema-"));
        try {
            const file = join(dir, "sample.json");
            await writeFile(file, '{"x":1}', "utf8");
            const { text } = await resolveInput({ arg: file, isTTY: true });
            expect(text).toBe('{"x":1}');
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    });

    it("throws a guidance error when no arg and stdin is a TTY", async () => {
        await expect(resolveInput({ arg: undefined, isTTY: true })).rejects.toThrow();
    });

    it("throws when the file does not exist", async () => {
        const dir = await mkdtemp(join(tmpdir(), "infer-schema-"));
        try {
            await expect(resolveInput({ arg: join(dir, "missing.json"), isTTY: true })).rejects.toThrow();
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    });
});
