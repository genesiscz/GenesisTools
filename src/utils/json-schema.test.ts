import { describe, expect, it } from "bun:test";
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
            const parsed = JSON.parse(result);
            expect(parsed.type).toBe("string");
        });
    });
});
