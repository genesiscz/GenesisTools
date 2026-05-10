import type { Selectable } from "kysely";
import type { ShopsDatabase } from "@app/shops/db/ShopsDatabase";
import type { BrandAliasesTable } from "@app/shops/db/types";

export type BrandAlias = Selectable<BrandAliasesTable>;

export class BrandAliasesRepository {
    constructor(private readonly db: ShopsDatabase) {}

    async lookup(alias: string): Promise<string | null> {
        const row = await this.db
            .kysely()
            .selectFrom("brand_aliases")
            .select("canonical")
            .where("alias", "=", alias.toLowerCase())
            .executeTakeFirst();
        return row?.canonical ?? null;
    }

    async upsert(alias: string, canonical: string, source: BrandAlias["source"]): Promise<void> {
        const now = new Date().toISOString();
        await this.db
            .kysely()
            .insertInto("brand_aliases")
            .values({
                alias: alias.toLowerCase(),
                canonical,
                source,
                created_at: now,
            })
            .onConflict((oc) =>
                oc.column("alias").doUpdateSet({
                    canonical,
                    source,
                })
            )
            .execute();
    }

    async listAll(): Promise<BrandAlias[]> {
        return await this.db.kysely().selectFrom("brand_aliases").selectAll().execute();
    }

    upsertIfAbsent(args: { alias: string; canonical: string; source: BrandAlias["source"] }): "inserted" | "skipped" {
        const aliasLower = args.alias.toLowerCase();
        const existing = this.db
            .raw()
            .query<{ alias: string }, [string]>("SELECT alias FROM brand_aliases WHERE alias = ?")
            .get(aliasLower);
        if (existing) {
            return "skipped";
        }

        this.db
            .raw()
            .query("INSERT INTO brand_aliases (alias, canonical, source, created_at) VALUES (?, ?, ?, ?)")
            .run(aliasLower, args.canonical, args.source, new Date().toISOString());
        return "inserted";
    }
}
