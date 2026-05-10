import { describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ShopsDatabase } from "@app/shops/db/ShopsDatabase";
import { buildRegistry, getAdvertisedTools, getHandler } from "@app/shops/mcp/registry";

function tmpDb(): ShopsDatabase {
    return new ShopsDatabase(join(mkdtempSync(join(tmpdir(), "shops-mcp-reg-")), "test.db"));
}

describe("buildRegistry", () => {
    it("contains 13 tools (8 read + 5 write)", () => {
        const reg = buildRegistry();
        expect(reg).toHaveLength(13);
        expect(reg.filter((t) => !t.requiresWrite)).toHaveLength(8);
        expect(reg.filter((t) => t.requiresWrite)).toHaveLength(5);
    });

    it("every entry has a non-empty description and a JSONSchema", () => {
        const reg = buildRegistry();
        for (const e of reg) {
            expect(e.description.length).toBeGreaterThan(10);
            expect(e.inputSchema.type).toBe("object");
        }
    });
});

describe("getAdvertisedTools", () => {
    it("filters out write tools when allowWrite=false", () => {
        const reg = buildRegistry();
        const advertised = getAdvertisedTools(reg, false);
        expect(advertised).toHaveLength(8);
        expect(advertised.every((t) => !t.requiresWrite)).toBe(true);
    });

    it("returns all tools when allowWrite=true", () => {
        const reg = buildRegistry();
        const advertised = getAdvertisedTools(reg, true);
        expect(advertised).toHaveLength(13);
    });
});

describe("getHandler", () => {
    it("returns notFound for unknown names", () => {
        const result = getHandler(buildRegistry(), "nonexistent", true);
        expect(result.kind).toBe("notFound");
    });

    it("returns writeBlocked for write tools when allowWrite=false", () => {
        const result = getHandler(buildRegistry(), "shops_ingest", false);
        expect(result.kind).toBe("writeBlocked");
    });

    it("returns ok for read tools regardless of allowWrite", () => {
        expect(getHandler(buildRegistry(), "shops_search", false).kind).toBe("ok");
        expect(getHandler(buildRegistry(), "shops_search", true).kind).toBe("ok");
    });

    it("returns ok for write tools when allowWrite=true", () => {
        expect(getHandler(buildRegistry(), "shops_ingest", true).kind).toBe("ok");
    });
});

describe("read-tool handler smoke", () => {
    it("shops_coverage runs without error against an empty DB", async () => {
        const db = tmpDb();
        const reg = buildRegistry();
        const lookup = getHandler(reg, "shops_coverage", false);
        if (lookup.kind !== "ok") {
            throw new Error("expected ok");
        }

        const result = await lookup.entry.handler({}, { shopsDb: db });
        expect(result.isError).toBeUndefined();
        expect(result.content[0].text).toBeDefined();
        db.close();
    });

    it("shops_get_product returns isError=true when input invalid", async () => {
        const db = tmpDb();
        const reg = buildRegistry();
        const lookup = getHandler(reg, "shops_get_product", false);
        if (lookup.kind !== "ok") {
            throw new Error("expected ok");
        }

        const result = await lookup.entry.handler({}, { shopsDb: db });
        expect(result.isError).toBe(true);
        db.close();
    });
});
