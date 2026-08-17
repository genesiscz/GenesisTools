import { describe, expect, it } from "bun:test";
import { allOptional, isEmptySchema, schemaToType } from "./schema-ts.ts";

describe("schemaToType", () => {
    it("primitives, arrays and nested objects", () => {
        expect(schemaToType({ type: "string" })).toBe("string");
        expect(schemaToType({ type: "integer" })).toBe("number");
        expect(schemaToType({ type: "array", items: { type: "string" } })).toBe("string[]");

        const nested = schemaToType({
            type: "object",
            properties: {
                tasks: {
                    type: "array",
                    items: {
                        type: "object",
                        properties: { text: { type: "string" } },
                        required: ["text"],
                    },
                },
            },
            required: ["tasks"],
        });
        expect(nested).toContain("tasks: {");
        expect(nested).toContain("text: string;");
    });

    it("tuple items render as a tuple, additionalProperties as an index signature", () => {
        expect(schemaToType({ items: [{ type: "string" }, { type: "number" }] })).toBe("[string, number]");

        const open = schemaToType({
            type: "object",
            properties: { id: { type: "string" } },
            additionalProperties: true,
        });
        expect(open).toContain("id?: string;");
        expect(open).toContain("[key: string]: unknown;");
    });

    it("enums, consts and unions", () => {
        expect(schemaToType({ enum: ["a", "b"] })).toBe('"a" | "b"');
        expect(schemaToType({ const: 5 })).toBe("5");
        expect(schemaToType({ anyOf: [{ type: "string" }, { type: "number" }] })).toBe("string | number");
        expect(schemaToType({ type: ["string", "null"] })).toBe("string | null");
    });

    it("resolves $ref into $defs and degrades unknowns", () => {
        const schema = {
            type: "object",
            properties: { target: { $ref: "#/$defs/Target" } },
            $defs: { Target: { type: "object", properties: { id: { type: "string" } } } },
        };
        expect(schemaToType(schema)).toContain("id?: string;");
        expect(schemaToType({ $ref: "#/nowhere/X" })).toBe("unknown");
        expect(schemaToType(42)).toBe("Record<string, unknown>");
    });

    it("marks required vs optional properties and quotes odd keys", () => {
        const rendered = schemaToType({
            type: "object",
            properties: { ok: { type: "boolean" }, "odd-key": { type: "string" } },
            required: ["ok"],
        });
        expect(rendered).toContain("ok: boolean;");
        expect(rendered).toContain('"odd-key"?: string;');
    });
});

describe("isEmptySchema / allOptional", () => {
    it("no properties means empty; no required means all-optional", () => {
        expect(isEmptySchema({ type: "object" })).toBe(true);
        expect(isEmptySchema({ type: "object", properties: {} })).toBe(true);
        expect(isEmptySchema({ type: "object", properties: { a: { type: "string" } } })).toBe(false);

        expect(allOptional({ type: "object", properties: { a: { type: "string" } } })).toBe(true);
        expect(allOptional({ type: "object", properties: { a: { type: "string" } }, required: ["a"] })).toBe(false);
        expect(allOptional(null)).toBe(true);
    });
});
