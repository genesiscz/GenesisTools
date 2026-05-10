import { beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrandAliasesRepository } from "@app/shops/db/BrandAliasesRepository";
import { ShopsDatabase } from "@app/shops/db/ShopsDatabase";
import { BrandResolver } from "@app/shops/lib/brand-resolver";

describe("BrandResolver", () => {
    let db: ShopsDatabase;
    let repo: BrandAliasesRepository;
    let resolver: BrandResolver;

    beforeEach(() => {
        db = new ShopsDatabase(join(mkdtempSync(join(tmpdir(), "shops-bres-")), "test.db"));
        repo = new BrandAliasesRepository(db);
        repo.upsertIfAbsent({ alias: "RitterSport", canonical: "ritter sport", source: "seed" });
        repo.upsertIfAbsent({ alias: "RITTER SPORT", canonical: "ritter sport", source: "seed" });
        repo.upsertIfAbsent({ alias: "ritter-sport", canonical: "ritter sport", source: "seed" });
        resolver = new BrandResolver(repo);
    });

    it("resolves verbatim alias (lowercase form stored)", async () => {
        expect(await resolver.resolve("RitterSport")).toBe("ritter sport");
    });

    it("resolves uppercase alias", async () => {
        expect(await resolver.resolve("RITTER SPORT")).toBe("ritter sport");
    });

    it("resolves normalized form when verbatim missing", async () => {
        repo.upsertIfAbsent({ alias: "ritter sport", canonical: "ritter sport", source: "seed" });
        expect(await resolver.resolve("Ritter Sport")).toBe("ritter sport");
    });

    it("falls back to normalize when no alias hit", async () => {
        expect(await resolver.resolve("Madeta")).toBe("madeta");
    });

    it("returns null for null/empty", async () => {
        expect(await resolver.resolve(null)).toBeNull();
        expect(await resolver.resolve("")).toBeNull();
    });
});
