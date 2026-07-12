import { describe, expect, it } from "bun:test";
import { SafeJSON } from "@app/utils/json";
import { buildOpenApiDocument, type OpenApiOperation } from "@app/youtube/lib/server/openapi";

const HTTP_METHODS = ["get", "post", "patch", "delete", "put"] as const;

function collectOperations(): OpenApiOperation[] {
    const doc = buildOpenApiDocument();
    const ops: OpenApiOperation[] = [];

    for (const pathItem of Object.values(doc.paths)) {
        for (const method of HTTP_METHODS) {
            const op = pathItem[method];

            if (op) {
                ops.push(op);
            }
        }
    }

    return ops;
}

describe("buildOpenApiDocument", () => {
    it("declares OpenAPI 3.1", () => {
        expect(buildOpenApiDocument().openapi.startsWith("3.1")).toBe(true);
    });

    it("exposes a relative server and a title", () => {
        const doc = buildOpenApiDocument();

        expect(doc.info.title).toBe("GenesisTools YouTube API");
        expect(doc.servers[0]?.url).toBe("/");
    });

    it("has a non-empty paths object", () => {
        const doc = buildOpenApiDocument();

        expect(Object.keys(doc.paths).length).toBeGreaterThan(0);
    });

    it("gives every operation a non-empty operationId", () => {
        for (const op of collectOperations()) {
            expect(typeof op.operationId).toBe("string");
            expect(op.operationId.length).toBeGreaterThan(0);
        }
    });

    it("keeps operationIds unique across all paths and methods", () => {
        const ids = collectOperations().map((op) => op.operationId);
        const unique = new Set(ids);

        expect(unique.size).toBe(ids.length);
    });

    it("ships at least 15 operations", () => {
        expect(collectOperations().length).toBeGreaterThanOrEqual(15);
    });

    it("only $refs schemas that are actually defined", () => {
        const doc = buildOpenApiDocument();
        const defined = new Set(Object.keys(doc.components.schemas));
        const serialized = SafeJSON.stringify(doc, { strict: true });
        const refs = [...serialized.matchAll(/"#\/components\/schemas\/([A-Za-z0-9_]+)"/g)].map((match) => match[1]);

        expect(refs.length).toBeGreaterThan(0);

        for (const name of refs) {
            expect(defined.has(name)).toBe(true);
        }
    });

    it("gives every operation at least one response", () => {
        for (const op of collectOperations()) {
            expect(Object.keys(op.responses).length).toBeGreaterThan(0);
        }
    });
});
