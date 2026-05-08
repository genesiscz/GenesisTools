import type { ShopsDatabase } from "./ShopsDatabase";
import type { BrandAliasesTable } from "./types";
import type { Selectable } from "kysely";

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
}
