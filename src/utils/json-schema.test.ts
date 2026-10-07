import { describe, expect, it } from "bun:test";
import { SafeJSON } from "@genesiscz/utils/json";
import { formatSchema, inferSchema } from "./json-schema";

describe("inferSchema", () => {
    it("infers string type", () => {
        expect(inferSchema("hello")).toEqual({ type: "string" });
    });

    it("infers integer type", () => {
        expect(inferSchema(42)).toEqual({ type: "integer" });
    });

    it("infers number type for floats", () => {
        expect(inferSchema(3.14)).toEqual({ type: "number" });
    });

    it("infers boolean type", () => {
        expect(inferSchema(true)).toEqual({ type: "boolean" });
    });

    it("infers null type", () => {
        expect(inferSchema(null)).toEqual({ type: "null" });
    });

    it("infers object with properties", () => {
        const schema = inferSchema({ name: "test", count: 5 });
        expect(schema.type).toBe("object");
        expect(schema.properties?.name).toEqual({ type: "string" });
        expect(schema.properties?.count).toEqual({ type: "integer" });
        expect(schema.required).toEqual(["name", "count"]);
    });

    it("infers array with item schema", () => {
        const schema = inferSchema([1, 2, 3]);
        expect(schema.type).toBe("array");
        expect(schema.items?.type).toBe("integer");
    });

    it("infers empty array with unknown items", () => {
        const schema = inferSchema([]);
        expect(schema.type).toBe("array");
        expect(schema.items?.type).toBe("unknown");
    });

    it("merges mixed-type array items", () => {
        const schema = inferSchema([1, "hello"]);
        expect(schema.type).toBe("array");
        expect(Array.isArray(schema.items?.type)).toBe(true);
        expect(schema.items?.type).toContain("integer");
        expect(schema.items?.type).toContain("string");
    });

    it("handles nested objects", () => {
        const schema = inferSchema({ user: { name: "test" } });
        expect(schema.properties?.user.type).toBe("object");
        expect(schema.properties?.user.properties?.name.type).toBe("string");
    });
});

describe("formatSchema", () => {
    describe("skeleton mode", () => {
        it("compact: formats simple object", () => {
            const result = formatSchema({ id: 1, name: "test" }, "skeleton");
            expect(result).toContain("id: integer");
            expect(result).toContain("name: string");
        });

        it("pretty: formats with indentation", () => {
            const result = formatSchema({ id: 1 }, "skeleton", { pretty: true });
            expect(result).toContain("\n");
            expect(result).toContain("id: integer");
        });
    });

    describe("typescript mode", () => {
        it("compact: generates interface", () => {
            const result = formatSchema({ id: 1, name: "test" }, "typescript");
            expect(result).toContain("interface");
            expect(result).toContain("id: number");
            expect(result).toContain("name: string");
        });

        it("pretty: generates multi-line interface", () => {
            const result = formatSchema({ id: 1 }, "typescript", { pretty: true });
            expect(result).toContain("interface");
            expect(result).toContain("\n");
        });
    });

    describe("schema mode", () => {
        it("returns JSON schema string", () => {
            const result = formatSchema("hello", "schema");
            const parsed = SafeJSON.parse(result);
            expect(parsed.type).toBe("string");
        });

        it("adds the draft-07 $schema key only when asked", () => {
            expect(formatSchema({ a: 1 }, "schema")).not.toContain("$schema");
            expect(SafeJSON.parse(formatSchema({ a: 1 }, "schema", { schemaHeader: true })).$schema).toBe(
                "http://json-schema.org/draft-07/schema#"
            );
        });

        it("keeps the properties of an object that is null in another sample", () => {
            const parsed = SafeJSON.parse(formatSchema([{ position: { line: 1 } }, { position: null }], "schema"));
            expect(parsed.items.properties.position.type).toEqual(["object", "null"]);
            expect(parsed.items.properties.position.properties.line.type).toBe("integer");
        });
    });

    describe("typescript naming", () => {
        it("quotes keys that are not identifiers and names their types validly", () => {
            const result = formatSchema({ "x-weird-key": 1, "2fa": { on: true }, plain: 1 }, "typescript");
            expect(result).toContain('"x-weird-key": number');
            expect(result).toContain('"2fa": _2fa');
            expect(result).toContain("interface _2fa { on: boolean }");
            expect(result).toContain("; plain: number");
        });

        it("names an array root and aliases it, exported when asked", () => {
            const result = formatSchema([{ id: 1 }], "typescript", {
                pretty: true,
                rootName: "Discussions",
                exported: true,
            });
            expect(result).toContain("export interface Discussion {");
            expect(result).toContain("export type Discussions = Discussion[];");
        });

        it("a singular root name still gives distinct element and alias names", () => {
            expect(formatSchema([{ id: 1 }], "typescript", { rootName: "Item" })).toBe(
                "interface ItemItem { id: number }\ntype Item = ItemItem[];"
            );
        });

        it("an object root is the named interface itself, with no alias", () => {
            expect(formatSchema({ id: 1 }, "typescript", { rootName: "Payload" })).toBe(
                "interface Payload { id: number }"
            );
        });

        it("default output is unchanged without the options", () => {
            expect(formatSchema([{ id: 1 }], "typescript")).toBe("interface Root { id: number }");
            expect(formatSchema([1, 2], "typescript")).toBe("type Root = number[];");
        });
    });
});
