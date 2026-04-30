import { describe, expect, it } from "bun:test";
import { buildMetadataPredicate } from "./filters";

describe("buildMetadataPredicate", () => {
    it("emits = predicate for equality", () => {
        const r = buildMetadataPredicate("t", [{ column: "category", op: "=", value: "blog" }]);
        expect(r.sql).toBe("c.category = ?");
        expect(r.params).toEqual(["blog"]);
    });

    it("emits != predicate", () => {
        const r = buildMetadataPredicate("t", [{ column: "category", op: "!=", value: "blog" }]);
        expect(r.sql).toBe("c.category != ?");
        expect(r.params).toEqual(["blog"]);
    });

    it("emits < / <= / > / >= predicates", () => {
        for (const op of ["<", "<=", ">", ">="] as const) {
            const r = buildMetadataPredicate("t", [{ column: "score", op, value: 0.5 }]);
            expect(r.sql).toBe(`c.score ${op} ?`);
            expect(r.params).toEqual([0.5]);
        }
    });

    it("emits LIKE predicate", () => {
        const r = buildMetadataPredicate("t", [{ column: "title", op: "LIKE", value: "%foo%" }]);
        expect(r.sql).toBe("c.title LIKE ?");
        expect(r.params).toEqual(["%foo%"]);
    });

    it("emits BETWEEN for tuple value", () => {
        const r = buildMetadataPredicate("t", [{ column: "dateSent", op: "BETWEEN", value: [100, 200] }]);
        expect(r.sql).toBe("c.dateSent BETWEEN ? AND ?");
        expect(r.params).toEqual([100, 200]);
    });

    it("emits IN for array value", () => {
        const r = buildMetadataPredicate("t", [{ column: "lang", op: "IN", value: ["en", "cs", "de"] }]);
        expect(r.sql).toBe("c.lang IN (?, ?, ?)");
        expect(r.params).toEqual(["en", "cs", "de"]);
    });

    it("AND-joins multiple filters", () => {
        const r = buildMetadataPredicate("t", [
            { column: "category", op: "=", value: "blog" },
            { column: "score", op: ">=", value: 0.5 },
        ]);
        expect(r.sql).toBe("c.category = ? AND c.score >= ?");
        expect(r.params).toEqual(["blog", 0.5]);
    });

    it("rejects invalid column names (SQL injection guard)", () => {
        expect(() => buildMetadataPredicate("t", [{ column: "x; DROP TABLE", op: "=", value: 1 }])).toThrow(
            /invalid column/i
        );
        expect(() => buildMetadataPredicate("t", [{ column: "1bad", op: "=", value: 1 }])).toThrow(/invalid column/i);
    });

    it("rejects unknown ops", () => {
        expect(() => buildMetadataPredicate("t", [{ column: "x", op: "INVALID" as never, value: 1 }])).toThrow(
            /unsupported op/i
        );
    });

    it("rejects invalid IN values", () => {
        expect(() => buildMetadataPredicate("t", [{ column: "x", op: "IN", value: "y" }])).toThrow(/array/i);
        expect(() => buildMetadataPredicate("t", [{ column: "x", op: "IN", value: [] }])).toThrow(/non-empty/i);
    });

    it("rejects non-tuple BETWEEN values", () => {
        expect(() => buildMetadataPredicate("t", [{ column: "x", op: "BETWEEN", value: 1 }])).toThrow(
            /tuple|\[start, end\]/i
        );
    });

    it("rejects array value for scalar ops", () => {
        expect(() => buildMetadataPredicate("t", [{ column: "x", op: "=", value: ["a", "b"] }])).toThrow(/scalar/i);
    });

    it("returns empty string + empty params when filters list is empty", () => {
        const r = buildMetadataPredicate("t", []);
        expect(r.sql).toBe("");
        expect(r.params).toEqual([]);
    });

    it("aliases all columns under c.", () => {
        const r = buildMetadataPredicate("any-table", [{ column: "x", op: "=", value: 1 }]);
        expect(r.sql.startsWith("c.")).toBe(true);
    });
});
